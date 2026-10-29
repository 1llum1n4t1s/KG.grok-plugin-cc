import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac process と CLI を使用するが、boot ID・procfs/mount/flock は模擬する。
// 特に directory flock の Linux kernel / filesystem 契約は別途実機確認が必要。
// 履歴削除と旧 recover-history は未統合。現行CLIの拒否と記録の保全を確認する。
// 旧回復処理のroot lockやmount変更の競合は、現行CLIからは実行できない。
function offlineHistoryFixture(t, prefix) {
  const root = fs.realpathSync(makeTempDir(prefix));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), barrier = path.join(stateDir, "state.lock");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const boot = fileURLToPath(new URL("./fixtures/linux-history-boot-preload.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(boot)}`.trim() };
  delete env.PLUGIN_DATA; delete env.GROK_HISTORY_SIM_BOOT;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = argv => spawnSync(process.execPath, [command, ...argv], { env, encoding: "utf8", timeout: 30000 });
  let sentinel = false, verifiedDone = false;
  t.after(() => {
    try {
      if (sentinel) {
        const stop = run(["state-lock", "stop-sentinel", ...args]);
        assert.equal(stop.status, 0, stop.stderr);
      }
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained offline history fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const migrate = () => {
    const result = run(["state-lock", "migrate", ...args]);
    if (result.status === 0) sentinel = true;
    return result;
  };
  const first = migrate(); assert.equal(first.status, 0, first.stderr);
  const markerBytes = fs.readFileSync(path.join(barrier, "protocol.json"));
  const epoch = JSON.parse(markerBytes).epoch;
  const journal = path.join(stateDir, "history-journal-v1", epoch);
  const journalIdentity = fs.statSync(journal, { bigint: true });
  const bootstrap = path.join(journal, "bootstrap");
  const bootstrapBytes = Buffer.from(`${JSON.stringify({ version: 1, epoch, nonce: randomUUID() }, null, 2)}\n`);
  const fd = fs.openSync(bootstrap, "wx", 0o600);
  try { fs.writeFileSync(fd, bootstrapBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const journalFd = fs.openSync(journal, "r");
  try { fs.fsyncSync(journalFd); } finally { fs.closeSync(journalFd); }
  const stateFile = path.join(stateDir, "state.json"), stateBytes = fs.readFileSync(stateFile);
  const ledger = path.join(stateDir, "worker-leases-v1", epoch, "ledger.json"), ledgerBytes = fs.readFileSync(ledger);
  const stop = run(["state-lock", "stop-sentinel", ...args]); assert.equal(stop.status, 0, stop.stderr); sentinel = false;
  const barrierIdentity = fs.statSync(barrier, { bigint: true });
  const savedBarrier = path.join(stateDir, `state.lock.history-${epoch}`);
  fs.renameSync(barrier, savedBarrier);
  env.GROK_HISTORY_SIM_BOOT = "33333333-3333-4333-8333-333333333333";
  const assertPreserved = () => {
    const currentJournal = fs.statSync(journal, { bigint: true }), currentBarrier = fs.statSync(savedBarrier, { bigint: true });
    assert.equal(currentJournal.dev, journalIdentity.dev); assert.equal(currentJournal.ino, journalIdentity.ino);
    assert.equal(currentBarrier.dev, barrierIdentity.dev); assert.equal(currentBarrier.ino, barrierIdentity.ino);
    assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
    assert.deepEqual(fs.readFileSync(bootstrap), bootstrapBytes);
    assert.deepEqual(fs.readFileSync(ledger), ledgerBytes);
    assert.deepEqual(fs.readFileSync(path.join(savedBarrier, "protocol.json")), markerBytes);
  };
  return { stateDir, workspace, barrier, savedBarrier, epoch, args, run, migrate, assertPreserved, complete() { verifiedDone = true; } };
}

test("Linux rejects unavailable history recovery and preserves the incomplete migration", {
  skip: process.platform !== "darwin", timeout: 180000
}, t => {
  const f = offlineHistoryFixture(t, "grok-linux-history-offline-lock-");
  const unsupported = f.run(["state-lock", "recover-history", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", f.stateDir, "--old-epoch", f.epoch, "--old-barrier", f.savedBarrier, "--cwd", f.workspace]);
  assert.equal(unsupported.error, undefined); assert.equal(unsupported.signal, null); assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Invalid state-lock arguments\/options/);
  assert.equal(fs.existsSync(f.barrier), false);
  f.assertPreserved();

  const migration = f.migrate();
  assert.equal(migration.error, undefined); assert.equal(migration.signal, null); assert.equal(migration.status, 1, "unconfirmed history must not migrate");
  assert.match(migration.stderr, /Old Linux history journal contains unconfirmed evidence/);
  const entries = fs.readdirSync(f.barrier).sort();
  assert.equal(entries.includes("native.lock"), true);
  assert.equal(entries.includes("protocol.json"), false);
  const prepared = entries.filter(name => /^prepared-.*\.json$/.test(name));
  assert.equal(prepared.length, 1);
  const preparedBytes = fs.readFileSync(path.join(f.barrier, prepared[0]));
  const preparedIdentity = fs.statSync(path.join(f.barrier, prepared[0]), { bigint: true });
  f.assertPreserved();

  const retry = f.migrate();
  assert.equal(retry.error, undefined); assert.equal(retry.signal, null); assert.equal(retry.status, 1, "an incomplete barrier must remain fail-closed");
  assert.match(retry.stderr, /POSIX state lock migration is incomplete or invalid/);
  assert.deepEqual(fs.readdirSync(f.barrier).sort(), entries);
  assert.deepEqual(fs.readFileSync(path.join(f.barrier, prepared[0])), preparedBytes);
  const retriedPrepared = fs.statSync(path.join(f.barrier, prepared[0]), { bigint: true });
  assert.equal(retriedPrepared.dev, preparedIdentity.dev); assert.equal(retriedPrepared.ino, preparedIdentity.ino);
  f.assertPreserved();
  f.complete();
});

test("Linux concurrent first migrations lock the same newly created root", {
  skip: process.platform !== "darwin", timeout: 180000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-first-root-lock-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), barrier = path.join(stateDir, "state.lock");
  assert.ok(!fs.existsSync(stateDir), "the fixture must start before the first state root exists");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const pause = fileURLToPath(new URL("./fixtures/linux-history-offline-lock-pause.mjs", import.meta.url));
  const ready = path.join(root, "first-root-ready"), release = path.join(root, "first-root-release");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(pause)}`.trim() };
  delete env.PLUGIN_DATA; delete env.GROK_HISTORY_OFFLINE_LOCK_READY; delete env.GROK_HISTORY_OFFLINE_LOCK_RELEASE;
  delete env.GROK_HISTORY_OFFLINE_LOCK_CMD;
  const args = ["state-lock", "migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let first, second, firstClosed, secondClosed, sentinel = false, verifiedDone = false;
  t.after(async () => {
    try {
      if ((first || second) && !fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
      for (const child of [first, second]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (firstClosed) await firstClosed;
      if (secondClosed) await secondClosed;
      if (sentinel) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
      }
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained first-root fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const start = childEnv => {
    const child = spawn(process.execPath, [command, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
    return { child, closed };
  };
  ({ child: first, closed: firstClosed } = start({ ...env, GROK_HISTORY_OFFLINE_LOCK_CMD: "migrate",
    GROK_HISTORY_OFFLINE_LOCK_READY: ready, GROK_HISTORY_OFFLINE_LOCK_RELEASE: release }));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && first.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready), "first migration must lock the newly created root before publishing a barrier");
  const rootIdentity = fs.statSync(stateDir, { bigint: true });
  assert.equal(rootIdentity.mode & 0o777n, 0o700n);
  ({ child: second, closed: secondClosed } = start(env));
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.ok(!fs.existsSync(barrier), "a competing first migration must not create a barrier while the root is locked");
  assert.notEqual(second.exitCode, 0, "a competing first migration must not complete before the lock is released");
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const firstResult = await firstClosed; assert.equal(firstResult.code, 0, firstResult.stderr); sentinel = true;
  const secondResult = await secondClosed;
  assert.ok(secondResult.code === 0 || /lock|timed out/i.test(secondResult.stderr), secondResult.stderr);
  const after = fs.statSync(stateDir, { bigint: true });
  assert.equal(after.dev, rootIdentity.dev); assert.equal(after.ino, rootIdentity.ino);
  assert.ok(fs.existsSync(path.join(barrier, "protocol.json")));
  verifiedDone = true;
});

test("Linux epoch recovery refuses a missing barrier and preserves old history", {
  skip: process.platform !== "darwin", timeout: 180000
}, t => {
  const f = offlineHistoryFixture(t, "grok-linux-offline-recovery-");
  const result = f.run(["state-lock", "recover", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", f.stateDir, "--cwd", f.workspace]);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1, "epoch recovery requires the active state barrier");
  assert.match(result.stderr, /Grok state lock requires explicit offline migration/);
  assert.equal(fs.existsSync(f.barrier), false);
  f.assertPreserved();
  f.complete();
});
