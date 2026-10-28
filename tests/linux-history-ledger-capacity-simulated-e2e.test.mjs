import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 256 実 owner と 2048 件の history 候補を一つの mutex snapshot で検査する。
// Mac の lockf と模擬 procfs/mount は Linux kernel の性能・動作を証明しない。
test("history ledger batch verifies 2048 candidates with 256 live slots", {
  skip: process.platform !== "darwin", timeout: 180000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-history-ledger-capacity-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-capacity-worker.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let sentinel = false, holder, closed;
  t.after(async () => {
    try {
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      if (closed) await closed;
      if (sentinel) {
        const stop = spawnSync(process.execPath, [cli, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  const migrated = spawnSync(process.execPath, [cli, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrated.status, 0, migrated.stderr); sentinel = true;
  holder = fork(fixture, [workspace, "hold"], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => holder.once("close", resolve));
  const [held] = await Promise.race([once(holder, "message"), closed.then(() => { throw new Error("holder exited before setup"); })]);
  assert.equal(held.type, "held"); assert.equal(held.leases.length, 256);
  holder.send("benchmark");
  const [result] = await Promise.race([once(holder, "message"), closed.then(() => { throw new Error("holder exited during benchmark"); })]);
  assert.equal(result.type, "benchmark"); assert.equal(result.count, 2048);
  assert.ok(result.elapsedMs < 10000, `batch exceeded its 10-second mutex budget: ${result.elapsedMs} ms`);
  t.diagnostic(`2048 candidates / 256 occupied slots: ${result.elapsedMs.toFixed(1)} ms on Mac simulated Linux`);
  holder.send("release-one");
  const [released] = await once(holder, "message"); assert.equal(released.type, "released");
  holder.send("finish"); await closed;
});
