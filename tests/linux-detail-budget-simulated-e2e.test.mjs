import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Mac 模擬 CLI と実ファイル。大きい過去 detail と新しい agent 応答の合計が
// sweep の 64 MiB 読取り上限を超える場合、結果を公開せず元記録を保持する。
// Linux kernel の fsync や mount は検証しない。
test("simulated Linux task refuses detail growth beyond the aggregate sweep budget", { skip: process.platform !== "darwin", timeout: 90000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-detail-budget-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned"), wrapper = path.join(root, "fake-grok");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid, GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker,
    GROK_LINUX_SIM_COMPLETE: "1", GROK_LINUX_SIM_REPLY_BYTES: String(3 * 1024 * 1024),
    GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1" };
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
      t.diagnostic(`Large-record fixture retained: ${root}`);
    }
  });
  const run = argv => spawnSync(process.execPath, [command, ...argv], { env, encoding: "utf8", timeout: 45000, maxBuffer: 16 * 1024 * 1024 });
  const migration = run(["state-lock", "migrate", ...args]); assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const stateFile = path.join(stateDir, "state.json"), jobs = path.join(stateDir, "jobs"), oldDetail = path.join(jobs, "old-large.json");
  const old = { id: "old-large", status: "completed", epoch: "22222222-2222-4222-8222-222222222222",
    createdAt: "2020-01-01T00:00:00.000Z", jobClass: "task", terminationPending: false };
  const fd = fs.openSync(oldDetail, "wx", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(old).slice(0, -1)},"padding":"`);
    const padding = Buffer.alloc(62 * 1024 * 1024, 0x78);
    for (let offset = 0; offset < padding.length;) {
      const written = fs.writeSync(fd, padding, offset, padding.length - offset);
      if (written <= 0) throw new Error("fixture padding write made no progress");
      offset += written;
    }
    fs.writeSync(fd, '"}'); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")); state.jobs.push(old);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  const oldStat = fs.statSync(oldDetail, { bigint: true });
  const task = run(["task", "--cwd", workspace, "--json", "produce a large result"]);
  assert.ok(fs.existsSync(agentPid), `agent did not start, so detail growth was not exercised: ${task.stderr}`);
  assert.notEqual(task.status, 0, "a result exceeding the total detail budget was published");
  assert.match(task.stderr, /budget|limit|capacity/i);
  const after = fs.statSync(oldDetail, { bigint: true });
  assert.equal(after.dev, oldStat.dev); assert.equal(after.ino, oldStat.ino); assert.equal(after.size, oldStat.size);
  const details = fs.readdirSync(jobs).filter(name => name.endsWith(".json"));
  const total = details.reduce((sum, name) => sum + fs.statSync(path.join(jobs, name), { bigint: true }).size, 0n);
  assert.ok(total <= 64n * 1024n * 1024n, `published detail total exceeds 64 MiB: ${total}`);
});
