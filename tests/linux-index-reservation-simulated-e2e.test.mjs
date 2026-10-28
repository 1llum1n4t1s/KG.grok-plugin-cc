import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// index 余裕がない場合、CLI task は queued detail や ledger slot を作る前に拒否する。
// Mac の procfs・mount・flock は模擬であり、Linux kernel の実証ではない。
test("simulated Linux task refuses a full index before reserving a worker", { skip: process.platform !== "darwin", timeout: 90000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-index-reservation-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fill = fileURLToPath(new URL("./fixtures/linux-fill-index-budget.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid,
    GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker, GROK_LINUX_SIM_COMPLETE: "1", GROK_BIN: wrapper,
    XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1" };
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let migrated = false;
  t.after(async () => {
    try {
      let stopped = !fs.existsSync(spawnMarker);
      if (fs.existsSync(agentPid)) {
        const pid = Number(fs.readFileSync(agentPid, "utf8")), deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === "ESRCH") { stopped = true; break; } throw error; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (migrated && stopped) {
        const result = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
      } else if (migrated) t.diagnostic(`Retained sentinel; agent exit is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      t.diagnostic(`Index capacity fixture retained: ${root}`);
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const stateFile = path.join(stateDir, "state.json"), jobs = path.join(stateDir, "jobs");
  const old = { id: "old-fill", status: "completed", epoch: "22222222-2222-4222-8222-222222222222",
    createdAt: "2020-01-01T00:00:00.000Z", terminationPending: false };
  fs.writeFileSync(path.join(jobs, "old-fill.json"), JSON.stringify(old), { flag: "wx", mode: 0o600 });
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")); state.jobs.push(old);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  const filled = spawnSync(process.execPath, [fill, workspace, old.id], { env, encoding: "utf8", timeout: 45000 });
  assert.equal(filled.status, 0, filled.stderr); assert.equal(JSON.parse(filled.stdout).saved, true);
  assert.equal(fs.statSync(stateFile, { bigint: true }).size, 64n * 1024n * 1024n - 64n);
  const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const beforeIndex = digest(stateFile), beforeNames = fs.readdirSync(jobs).sort();
  const epoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
  const ledger = path.join(stateDir, "worker-leases-v1", epoch, "ledger.json"), beforeLedger = fs.readFileSync(ledger, "utf8");
  const task = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "no capacity"], { env, encoding: "utf8", timeout: 45000 });
  assert.notEqual(task.status, 0);
  assert.match(task.stderr, /budget|capacity|limit|space/i);
  assert.equal(fs.existsSync(spawnMarker), false, "agent started with an unreservable index");
  assert.equal(digest(stateFile), beforeIndex);
  assert.deepEqual(fs.readdirSync(jobs).sort(), beforeNames, "unconfirmed queued detail or temp was left behind");
  assert.equal(fs.readFileSync(ledger, "utf8"), beforeLedger, "slot was reserved before index capacity was proved");
});
