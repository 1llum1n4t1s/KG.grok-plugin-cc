import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 256 個の稼働中 lease を回収する、満杯を拒否しない、
// 終了済み reservation を回収できず次の予約を永久に拒否する。
// 実 Mac プロセスと模擬 procfs/mount/flock は Linux kernel の実証ではない。
test("Linux capacity is restored only after an owner releases a reserved lease", {
  skip: process.platform !== "darwin", timeout: 360000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-lease-capacity-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-capacity-worker.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  let holder, closed, migrated = false;
  t.after(async () => {
    try {
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      if (closed) await closed;
      if (migrated) {
        const stopped = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stopped.status, 0, stopped.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const crashed = spawnSync(process.execPath, [fixture, workspace, "crash-empty"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(crashed.status, 76, crashed.stderr);
  const reclaimPreload = fileURLToPath(new URL("./fixtures/linux-lease-empty-reclaim-crash-preload.mjs", import.meta.url));
  const interrupted = spawnSync(process.execPath, [sweep, workspace], { encoding: "utf8", timeout: 75000,
    env: { ...env, GROK_EMPTY_RECLAIM_CRASH: "1", NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(reclaimPreload)}` } });
  assert.equal(interrupted.status, 77, `${interrupted.stderr}\n${interrupted.stdout}`);
  const recovery = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 75000 });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).reclaimed, 1, "a durable reservation with no lease or records must be reclaimable");
  holder = fork(fixture, [workspace, "hold"], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => holder.once("close", resolve));
  const [held] = await Promise.race([once(holder, "message"), closed.then(() => { throw new Error("capacity holder exited"); })]);
  assert.equal(held.type, "held"); assert.equal(held.leases.length, 256);
  const reserve = () => {
    const result = spawnSync(process.execPath, [fixture, workspace, "reserve"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(reserve(), { ok: false, code: "GROK_LINUX_LEASE_CAPACITY" });
  holder.send("release-one");
  const [released] = await once(holder, "message");
  assert.equal(released.type, "released");
  const result = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 75000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reclaimed, 1);
  assert.equal(reserve().ok, true);
  holder.send("finish");
  await closed;
});
