import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 CLI と実 Mac process を使うが、procfs/mount/flock は模擬値。
// 記録は停止済み worker の実出力を使用し、index の容量圧迫だけを注入する。
test("Linux task reclaims verified history before admitting into a full index", {
  skip: process.platform !== "darwin", timeout: 1800000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-admission-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), stateFile = path.join(stateDir, "state.json"), jobsDir = path.join(stateDir, "jobs");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_COMPANION_SESSION_ID: "history-admission-session", SETTINGS_LOG: path.join(root, "settings.log"),
    SETTINGS_READY: path.join(root, "agent-ready"), SETTINGS_RELEASE: path.join(root, "agent-release"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  const lockArgs = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let migrated = false, allStopped = true, verifiedDone = false;
  t.after(() => {
    try {
      if (migrated && allStopped) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...lockArgs], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
        else t.diagnostic(`Retained failed admission fixture: ${root}`);
      } else if (migrated) t.diagnostic(`Retained fixture because agent exit is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const migrate = spawnSync(process.execPath, [command, "state-lock", "migrate", ...lockArgs], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrate.status, 0, migrate.stderr); migrated = true;
  function task(i) {
    const exited = path.join(root, `agent-exit-${i}`), spawned = path.join(root, `agent-spawn-${i}`);
    allStopped = false;
    const result = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", `admission task ${i}`],
      { env: { ...env, SETTINGS_EXIT: exited, GROK_LINUX_SIM_SPAWN_MARKER: spawned }, encoding: "utf8", timeout: 120000 });
    if (!fs.existsSync(spawned) || fs.existsSync(exited)) allStopped = true;
    if (result.status === 0) assert.ok(fs.existsSync(exited), `task ${i}: agent exit must be observed`);
    return result;
  }
  for (let i = 0; i < 51; i++) { const result = task(i); assert.equal(result.status, 0, result.stderr); }
  allStopped = false;
  const reclaimed = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 120000 });
  assert.equal(reclaimed.status, 0, reclaimed.stderr); allStopped = true;
  assert.equal(JSON.parse(reclaimed.stdout).reclaimed, 51);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const eligible = state.jobs.filter(job => job.status === "completed" && job.workerLease == null &&
    job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  assert.equal(eligible.length, 51);
  const oldest = eligible[0], indexed = state.jobs.find(job => job.id === oldest.id);
  indexed.fixtureSummaryPadding = "x".repeat(512 * 1024);
  state.config.fixtureIndexPadding = "";
  const serialize = () => `${JSON.stringify(state, null, 2)}\n`;
  const budget = 64 * 1024 * 1024, target = budget - 2048;
  const baseLength = Buffer.byteLength(serialize());
  assert.ok(baseLength < target);
  state.config.fixtureIndexPadding = "x".repeat(target - baseLength);
  const payload = serialize(); assert.equal(Buffer.byteLength(payload), target);
  fs.writeFileSync(stateFile, payload, { mode: 0o600 });
  const result = task(51);
  assert.equal(result.status, 0, `admission should reclaim verified history first: ${result.stderr}\n${result.stdout}`);
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(!after.jobs.some(job => job.id === oldest.id), "the padded oldest verified index record must be removed");
  assert.ok(!fs.existsSync(path.join(jobsDir, `${oldest.id}.json`)));
  assert.ok(!fs.existsSync(oldest.logFile));
  assert.ok(fs.statSync(stateFile).size < target - 256 * 1024, "admission must have reclaimed meaningful index capacity");
  verifiedDone = true;
});
