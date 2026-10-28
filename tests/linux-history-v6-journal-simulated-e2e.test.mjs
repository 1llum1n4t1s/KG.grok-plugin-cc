import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Real CLI and files on macOS, with simulated Linux procfs/mount/flock. This
// does not establish Linux kernel mount, no-replace or durability semantics.
const mac = process.platform !== "darwin" ? "macOS simulated Linux only" : false;
const v5Root = process.env.GROK_LINUX_V5_ROOT;
const oldSkip = mac || (!v5Root ? "GROK_LINUX_V5_ROOT not supplied; old v5 CLI was not validated" : false);
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
const historyModule = new URL("../plugins/grok/scripts/lib/linux-history-prune.mjs", import.meta.url).href;

function fixture(t) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-history-v6-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  for (const dir of [data, workspace, registry]) fs.mkdirSync(dir, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir };
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = (command, argv, extra = {}) => spawnSync(process.execPath, [command, ...argv], { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
  const active = [];
  t.after(() => {
    try {
      for (const owner of active.filter(owner => owner.live)) {
        const stopped = run(owner.cli, ["state-lock", "stop-sentinel", ...args]);
        if (stopped.status !== 0) t.diagnostic(`Sentinel exit unconfirmed; retained ${root}: ${stopped.stderr}`);
      }
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      t.diagnostic(`Linux v6 journal fixture retained: ${root}`);
    }
  });
  return { root, workspace, stateDir, env, args, run, active };
}
const migrate = (f, command = cli, extra) => {
  const result = f.run(command, ["state-lock", "migrate", ...f.args], extra);
  if (result.status === 0) f.active.push({ cli: command, live: true });
  return result;
};

test("simulated Linux v6 pins the journal inode to the marker and state capability", { skip: mac, timeout: 45000 }, t => {
  const f = fixture(t), result = migrate(f); assert.equal(result.status, 0, result.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8"));
  assert.equal(marker.protocol, "posix-linux-worker-lease-v6");
  const journal = path.join(f.stateDir, "history-journal-v1", marker.epoch), stat = fs.lstatSync(journal, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777n) === 0o700n);
  assert.deepEqual(marker.historyJournalIdentity, { dev: String(stat.dev), ino: String(stat.ino) });
  const script = `import assert from 'node:assert/strict'; import * as s from ${JSON.stringify(stateModule)};
    s.withStateSnapshot(${JSON.stringify(f.workspace)}, (_state, context) => {
      s.assertLinuxHistoryContext(context);
      assert.deepEqual(context.expectedHistoryJournalIdentity, ${JSON.stringify(marker.historyJournalIdentity)});
    });`;
  const check = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(check.status, 0, check.stderr);
});

test("simulated Linux history transactions reject reentry from public state callbacks", { skip: mac, timeout: 45000 }, t => {
  const f = fixture(t), result = migrate(f); assert.equal(result.status, 0, result.stderr);
  const script = `import assert from 'node:assert/strict'; import * as s from ${JSON.stringify(stateModule)};
    import * as h from ${JSON.stringify(historyModule)}; const cwd=${JSON.stringify(f.workspace)};
    s.withStateSnapshot(cwd, (_state, context) => {
      s.assertLinuxHistoryContext(context);
      assert.throws(()=>h.recoverLinuxHistory(context), /internal.*phase|phase.*internal/i);
      assert.throws(()=>h.pruneLinuxHistory(context), /internal.*phase|phase.*internal/i);
    });
    s.updateState(cwd, (_state, context) => {
      assert.throws(()=>h.pruneLinuxHistory(context), /internal.*phase|phase.*internal/i);
    }, { aroundCommit(_state, context, commit) {
      assert.throws(()=>h.recoverLinuxHistory(context), /internal.*phase|phase.*internal/i);
      assert.throws(()=>h.pruneLinuxHistory(context), /internal.*phase|phase.*internal/i);
      return commit();
    }});
    assert.equal(s.loadState(cwd).jobs.length,0);`;
  const check = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(check.status, 0, check.stderr);
});

for (const pending of [false, true]) test(`simulated Linux v6 offline epoch transition preserves ${pending ? "unconfirmed" : "empty"} old journal`, { skip: mac, timeout: 90000 }, t => {
  const f = fixture(t), initial = migrate(f); assert.equal(initial.status, 0, initial.stderr);
  const old = f.active.at(-1), barrier = path.join(f.stateDir, "state.lock");
  const oldMarker = JSON.parse(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8"));
  const oldJournal = path.join(f.stateDir, "history-journal-v1", oldMarker.epoch);
  const oldStat = fs.lstatSync(oldJournal, { bigint: true });
  const pendingFile = path.join(oldJournal, "unconfirmed-intent.json");
  if (pending) fs.writeFileSync(pendingFile, "unconfirmed old intent\n", { flag: "wx", mode: 0o600 });
  const stop = f.run(cli, ["state-lock", "stop-sentinel", ...f.args]); assert.equal(stop.status, 0, stop.stderr); old.live = false;
  const backup = path.join(f.stateDir, "old-v6-barrier"); fs.mkdirSync(backup, { mode: 0o700 });
  const sync = dir => { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  sync(f.stateDir); fs.renameSync(barrier, path.join(backup, "state.lock")); sync(backup); sync(f.stateDir);
  const next = migrate(f);
  if (!pending) {
    assert.equal(next.status, 0, next.stderr);
    const marker = JSON.parse(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8"));
    assert.notEqual(marker.epoch, oldMarker.epoch);
    const newStat = fs.lstatSync(path.join(f.stateDir, "history-journal-v1", marker.epoch), { bigint: true });
    assert.notEqual(newStat.ino, oldStat.ino);
    const recover = f.run(cli, ["state-lock", "recover", ...f.args, "--all-old-processes-stopped"]);
    assert.equal(recover.status, 0, recover.stderr);
    assert.equal(f.run(cli, ["status", "--cwd", f.workspace, "--json"]).status, 0);
  } else if (next.status === 0) {
    assert.notEqual(f.run(cli, ["status", "--cwd", f.workspace, "--json"]).status, 0);
    assert.notEqual(f.run(cli, ["state-lock", "recover", ...f.args, "--all-old-processes-stopped"]).status, 0,
      "unconfirmed old journal was silently cleared");
  }
  const saved = fs.lstatSync(oldJournal, { bigint: true }); assert.equal(saved.dev, oldStat.dev); assert.equal(saved.ino, oldStat.ino);
  if (pending) assert.equal(fs.readFileSync(pendingFile, "utf8"), "unconfirmed old intent\n");
});

test("simulated Linux migration preserves and rejects a symbolic journal directory", { skip: mac, timeout: 45000 }, t => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  const outside = path.join(f.root, "outside"), journal = path.join(f.stateDir, "history-journal-v1");
  fs.mkdirSync(outside, { mode: 0o700 }); fs.symlinkSync(outside, journal, "dir");
  const result = migrate(f); assert.notEqual(result.status, 0, "symbolic journal was accepted");
  assert.ok(fs.lstatSync(journal).isSymbolicLink()); assert.deepEqual(fs.readdirSync(outside), []);
});

test("simulated Linux journal creation crash leaves unconfirmed evidence and blocks retry", { skip: mac, timeout: 45000 }, t => {
  const f = fixture(t), result = migrate(f, cli, { GROK_LINUX_SIM_JOURNAL_CRASH: "1" });
  assert.equal(result.status, 74, result.stderr);
  const journal = path.join(f.stateDir, "history-journal-v1"), barrier = path.join(f.stateDir, "state.lock");
  assert.ok(fs.lstatSync(journal).isDirectory());
  assert.equal(fs.existsSync(path.join(barrier, "protocol.json")), false);
  const before = fs.readdirSync(barrier).sort();
  const retry = migrate(f); assert.notEqual(retry.status, 0, "unconfirmed journal was silently reused");
  assert.deepEqual(fs.readdirSync(barrier).sort(), before); assert.ok(fs.lstatSync(journal).isDirectory());
});

test("simulated Linux v5 state requires offline v6 migration and excludes the old CLI", { skip: oldSkip, timeout: 90000 }, t => {
  assert.ok(path.isAbsolute(v5Root));
  const source = path.join(fs.realpathSync(v5Root), "plugins", "grok"), f = fixture(t), copy = path.join(f.root, "v5-plugin");
  const sourceLock = fs.readFileSync(path.join(source, "scripts", "lib", "posix-state-lock.mjs"), "utf8");
  assert.match(sourceLock, /posix-linux-worker-lease-v5/); assert.doesNotMatch(sourceLock, /posix-linux-worker-lease-v6/);
  fs.cpSync(source, copy, { recursive: true, errorOnExist: true, force: false });
  const oldCli = path.join(copy, "scripts", "grok-companion.mjs"), initial = migrate(f, oldCli); assert.equal(initial.status, 0, initial.stderr);
  const old = f.active.at(-1), barrier = path.join(f.stateDir, "state.lock"), markerFile = path.join(barrier, "protocol.json");
  const oldMarker = fs.readFileSync(markerFile, "utf8"), oldEpoch = JSON.parse(oldMarker).epoch;
  assert.equal(JSON.parse(oldMarker).protocol, "posix-linux-worker-lease-v5");
  const stateFile = path.join(f.stateDir, "state.json"), ledger = path.join(f.stateDir, "worker-leases-v1", oldEpoch, "ledger.json");
  const before = [stateFile, ledger].map(name => fs.readFileSync(name));
  assert.notEqual(f.run(cli, ["status", "--cwd", f.workspace, "--json"]).status, 0, "v6 runtime accepted v5");
  assert.equal(fs.readFileSync(markerFile, "utf8"), oldMarker);
  const stop = f.run(oldCli, ["state-lock", "stop-sentinel", ...f.args]); assert.equal(stop.status, 0, stop.stderr); old.live = false;
  const backup = path.join(f.stateDir, "v5-barrier-backup"), oldId = fs.lstatSync(barrier, { bigint: true });
  fs.mkdirSync(backup, { mode: 0o700 });
  const sync = dir => { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  sync(f.stateDir); fs.renameSync(barrier, path.join(backup, "state.lock")); sync(backup); sync(f.stateDir);
  const saved = fs.lstatSync(path.join(backup, "state.lock"), { bigint: true }); assert.equal(saved.ino, oldId.ino); assert.equal(saved.dev, oldId.dev);
  const next = migrate(f); assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(fs.readFileSync(markerFile, "utf8")).protocol, "posix-linux-worker-lease-v6");
  assert.notEqual(f.run(oldCli, ["status", "--cwd", f.workspace, "--json"]).status, 0, "v5 writer accepted v6");
  assert.notEqual(f.run(cli, ["status", "--cwd", f.workspace, "--json"]).status, 0, "old epoch recovery was skipped");
  const recovery = f.run(cli, ["state-lock", "recover", ...f.args, "--all-old-processes-stopped"]); assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(f.run(cli, ["status", "--cwd", f.workspace, "--json"]).status, 0);
  for (const [index, name] of [stateFile, ledger].entries()) assert.deepEqual(fs.readFileSync(name), before[index]);
});
