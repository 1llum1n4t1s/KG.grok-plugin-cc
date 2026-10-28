import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Mac CLI simulation: procfs, namespaces, mount and flock are injected; this
// does not demonstrate Linux kernel locking, no-replace or durability.
const mac = process.platform !== "darwin" ? "macOS simulated Linux only" : false;
const v4Root = process.env.GROK_LINUX_V4_ROOT;
const oldSkip = mac || (!v4Root ? "GROK_LINUX_V4_ROOT was not supplied; old v4 CLI was not validated" : false);
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
const fakeAgent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;

function fixture(t) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-history-protocol-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  for (const dir of [data, workspace, registry]) fs.mkdirSync(dir, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned");
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeAgent)} "$@"\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid,
    GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker, GROK_LINUX_SIM_COMPLETE: "1", GROK_BIN: wrapper,
    GROK_COMPANION_DISABLE_BROKER: "1", XAI_API_KEY: "test-only" };
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = (command, ...argv) => spawnSync(process.execPath, [command, ...argv], { env, encoding: "utf8", timeout: 30000 });
  const sentinels = [];
  t.after(() => {
    try {
      let stopped = !fs.existsSync(spawnMarker);
      if (fs.existsSync(agentPid)) {
        try { process.kill(Number(fs.readFileSync(agentPid, "utf8")), 0); }
        catch (error) { if (error.code === "ESRCH") stopped = true; else throw error; }
      }
      if (stopped) for (const item of sentinels.filter(item => item.active)) {
        const result = run(item.cli, "state-lock", "stop-sentinel", ...args);
        if (result.status !== 0) t.diagnostic(`Sentinel stop unconfirmed; retained ${root}: ${result.stderr}`);
      }
      else if (sentinels.some(item => item.active)) t.diagnostic(`Agent exit unconfirmed; retained sentinel and fixture: ${root}`);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      t.diagnostic(`Linux protocol fixture retained: ${root}`);
    }
  });
  return { root, workspace, stateDir, args, env, run, sentinels };
}

test("simulated Linux history protocol exposes only a live v6 mutex capability", { skip: mac, timeout: 45000 }, t => {
  const f = fixture(t), migrate = f.run(cli, "state-lock", "migrate", ...f.args);
  assert.equal(migrate.status, 0, migrate.stderr); f.sentinels.push({ cli, active: true });
  const marker = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8"));
  assert.equal(marker.protocol, "posix-linux-worker-lease-v6");
  const script = `import assert from 'node:assert/strict'; import * as s from ${JSON.stringify(stateModule)};
    let old; s.withStateSnapshot(${JSON.stringify(f.workspace)}, (_state, context) => {
      old=context; assert.equal(context.protocol,'posix-linux-worker-lease-v6');
      assert.equal(typeof s.assertLinuxHistoryContext,'function'); s.assertLinuxHistoryContext(context);
      assert.throws(()=>s.assertLinuxHistoryContext({...context,check(){}}));
      assert.throws(()=>s.assertLinuxHistoryContext({...context,protocol:'posix-linux-worker-lease-v4'}));
    }); assert.throws(()=>s.assertLinuxHistoryContext(old));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test("simulated Linux v4 offline upgrade preserves leased history and excludes old writers", { skip: oldSkip, timeout: 90000 }, t => {
  assert.ok(path.isAbsolute(v4Root));
  const source = path.join(fs.realpathSync(v4Root), "plugins", "grok");
  const sourceLock = fs.readFileSync(path.join(source, "scripts", "lib", "posix-state-lock.mjs"), "utf8");
  assert.match(sourceLock, /posix-linux-worker-lease-v4/); assert.doesNotMatch(sourceLock, /posix-linux-worker-lease-v5/);
  const f = fixture(t), copied = path.join(f.root, "v4-plugin");
  fs.cpSync(source, copied, { recursive: true, errorOnExist: true, force: false });
  const oldCli = path.join(copied, "scripts", "grok-companion.mjs");
  const initial = f.run(oldCli, "state-lock", "migrate", ...f.args); assert.equal(initial.status, 0, initial.stderr);
  const oldSentinel = { cli: oldCli, active: true }; f.sentinels.push(oldSentinel);
  const task = f.run(oldCli, "task", "--cwd", f.workspace, "--json", "old v4 task"); assert.equal(task.status, 0, task.stderr);
  const id = JSON.parse(task.stdout).jobId, barrier = path.join(f.stateDir, "state.lock");
  const oldMarker = fs.readFileSync(path.join(barrier, "protocol.json"), "utf8"), epoch = JSON.parse(oldMarker).epoch;
  assert.equal(JSON.parse(oldMarker).protocol, "posix-linux-worker-lease-v4");
  const stateFile = path.join(f.stateDir, "state.json"), detail = path.join(f.stateDir, "jobs", `${id}.json`), log = path.join(f.stateDir, "jobs", `${id}.log`);
  const ledger = path.join(f.stateDir, "worker-leases-v1", epoch, "ledger.json");
  const preserved = [stateFile, detail, log, ledger].map(file => fs.readFileSync(file));
  assert.ok(JSON.parse(preserved[1].toString()).workerLease, "old worker did not publish its lease");
  const denied = f.run(cli, "status", "--cwd", f.workspace, "--json");
  assert.notEqual(denied.status, 0, "v5 runtime accepted v4 without offline migration");
  assert.equal(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8"), oldMarker);
  const agentFile = path.join(f.root, "agent.pid");
  assert.ok(fs.existsSync(agentFile), "fake agent identity is unavailable");
  const agentPid = Number(fs.readFileSync(agentFile, "utf8"));
  const deadline = Date.now() + 5000;
  let agentExited = false;
  while (Date.now() < deadline) {
    try { process.kill(agentPid, 0); }
    catch (error) { if (error.code === "ESRCH") { agentExited = true; break; } throw error; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(agentExited, true, "fake agent exit was not independently confirmed");
  const stopped = f.run(oldCli, "state-lock", "stop-sentinel", ...f.args); assert.equal(stopped.status, 0, stopped.stderr); oldSentinel.active = false;
  const oldId = fs.lstatSync(barrier, { bigint: true }), backup = path.join(f.stateDir, "v4-barrier-backup");
  fs.mkdirSync(backup, { mode: 0o700 });
  const sync = dir => { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  sync(f.stateDir); fs.renameSync(barrier, path.join(backup, "state.lock")); sync(backup); sync(f.stateDir);
  const saved = fs.lstatSync(path.join(backup, "state.lock"), { bigint: true }); assert.equal(saved.ino, oldId.ino); assert.equal(saved.dev, oldId.dev);
  const migrated = f.run(cli, "state-lock", "migrate", ...f.args); assert.equal(migrated.status, 0, migrated.stderr);
  f.sentinels.push({ cli, active: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8")).protocol, "posix-linux-worker-lease-v6");
  assert.notEqual(f.run(oldCli, "status", "--cwd", f.workspace, "--json").status, 0, "old v4 runtime accepted v5");
  const beforeRecovery = f.run(cli, "status", "--cwd", f.workspace, "--json"); assert.notEqual(beforeRecovery.status, 0);
  const recovery = f.run(cli, "state-lock", "recover", ...f.args, "--all-old-processes-stopped"); assert.equal(recovery.status, 0, recovery.stderr);
  const status = f.run(cli, "status", "--cwd", f.workspace, "--json"); assert.equal(status.status, 0, status.stderr);
  for (const [index, file] of [stateFile, detail, log, ledger].entries()) assert.deepEqual(fs.readFileSync(file), preserved[index]);
});
