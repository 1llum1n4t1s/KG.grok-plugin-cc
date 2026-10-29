import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 CLI と実 Mac process を使うが、procfs/mount/flock は模擬値。
// 実 worker 1 件の停止を確認し、他の 50 件と index の容量圧迫を fixture で作る。
// 51 worker の停止や 256 枠を 60 秒で走査する性能は検証しない。
test("Linux task refuses a full index and preserves current history", {
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
  const first = task(0); assert.equal(first.status, 0, `first task: ${first.error?.code ?? "no spawn error"}; signal=${first.signal}; ${first.stderr}`);
  allStopped = false;
  const reclaimed = spawnSync(process.execPath, [sweep, workspace, "256"], { env, encoding: "utf8", timeout: 120000 });
  assert.equal(reclaimed.status, 0, reclaimed.stderr); allStopped = true;
  assert.deepEqual(JSON.parse(reclaimed.stdout), { examined: 256, reclaimed: 1, uncertain: 0 });
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const eligible = state.jobs.filter(job => job.status === "completed" && job.workerLease == null &&
    job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  assert.equal(eligible.length, 1);
  const oldest = eligible[0], indexed = state.jobs.find(job => job.id === oldest.id);
  const preservedFiles = new Map();
  for (let i = 0; i < 50; i++) {
    const id = `fixture-current-${i}`, logFile = path.join(jobsDir, `${id}.log`);
    const record = { id, epoch: oldest.epoch, jobClass: "review", status: "completed", createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z", terminationPending: false, logFile };
    const detail = `${JSON.stringify(record, null, 2)}\n`, log = `fixture log ${i}\n`;
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), detail, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(logFile, log, { flag: "wx", mode: 0o600 });
    preservedFiles.set(path.join(jobsDir, `${id}.json`), detail); preservedFiles.set(logFile, log);
    state.jobs.push(record);
  }
  preservedFiles.set(path.join(jobsDir, `${oldest.id}.json`), fs.readFileSync(path.join(jobsDir, `${oldest.id}.json`), "utf8"));
  preservedFiles.set(oldest.logFile, fs.readFileSync(oldest.logFile, "utf8"));
  indexed.fixtureSummaryPadding = "x".repeat(512 * 1024);
  state.config.fixtureIndexPadding = "";
  const serialize = () => `${JSON.stringify(state, null, 2)}\n`;
  const budget = 64 * 1024 * 1024, target = budget - 2048;
  const baseLength = Buffer.byteLength(serialize());
  assert.ok(baseLength < target);
  state.config.fixtureIndexPadding = "x".repeat(target - baseLength);
  const payload = serialize(); assert.equal(Buffer.byteLength(payload), target);
  fs.writeFileSync(stateFile, payload, { mode: 0o600 });
  const result = task(1);
  assert.equal(result.error, undefined, `admission must exit without a spawn error: ${result.error?.message}`);
  assert.equal(result.signal, null, "admission must not terminate by signal");
  assert.ok(Number.isInteger(result.status), "admission must return an exit code");
  assert.notEqual(result.status, 0, "a full index must reject admission");
  assert.match(result.stderr, /index.*(?:space|budget|limit)|(?:space|budget|limit).*index/i);
  t.diagnostic(`Admission refusal: ${result.stderr.trim()}`);
  assert.equal(fs.existsSync(path.join(root, "agent-spawn-1")), false, "the agent must not start");
  assert.equal(fs.readFileSync(stateFile, "utf8"), payload, "the full index must be preserved");
  for (const [file, content] of preservedFiles) assert.equal(fs.readFileSync(file, "utf8"), content, `${file} must be preserved`);
  verifiedDone = true;
});
