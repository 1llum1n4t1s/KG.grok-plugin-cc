import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac process と CLI を使用するが procfs/mount/flock は模擬する。
// 実 worker 1 件と fixture 50 件、旧 epoch の 2000 件を使う。Linux kernel の性能は実証しない。
// 51 worker の停止や 256 枠を 60 秒で走査する性能は検証しない。
test("Linux CLI preserves current and 2000 old history records", {
  skip: process.platform !== "darwin", timeout: 1800000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-inventory-"));
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
    GROK_COMPANION_SESSION_ID: "history-inventory-session", SETTINGS_LOG: path.join(root, "settings.log"),
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
        else t.diagnostic(`Retained failed inventory fixture: ${root}`);
      } else if (migrated) t.diagnostic(`Retained fixture because agent exit is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", ...lockArgs], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  function task(i, timeout = 30000) {
    const exited = path.join(root, `agent-exit-${i}`), spawned = path.join(root, `agent-spawn-${i}`);
    allStopped = false;
    const result = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", `inventory task ${i}`],
      { env: { ...env, SETTINGS_EXIT: exited, GROK_LINUX_SIM_SPAWN_MARKER: spawned }, encoding: "utf8", timeout });
    if (!fs.existsSync(spawned) || fs.existsSync(exited)) allStopped = true;
    if (result.status === 0) assert.ok(fs.existsSync(exited), `task ${i}: agent exit must be observed`);
    return result;
  }
  const first = task(0); assert.equal(first.status, 0, `first task: ${first.error?.code ?? "no spawn error"}; signal=${first.signal}; ${first.stderr}`);
  allStopped = false;
  const sweepResult = spawnSync(process.execPath, [sweep, workspace, "256"], { env, encoding: "utf8", timeout: 120000 });
  assert.equal(sweepResult.status, 0, sweepResult.stderr); allStopped = true;
  assert.deepEqual(JSON.parse(sweepResult.stdout), { examined: 256, reclaimed: 1, uncertain: 0 });
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const verified = state.jobs.filter(job => job.status === "completed" && job.workerLease == null &&
    job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  assert.equal(verified.length, 1);
  const oldest = verified[0], oldRecords = new Map();
  const currentFiles = new Map();
  currentFiles.set(path.join(jobsDir, `${oldest.id}.json`), fs.readFileSync(path.join(jobsDir, `${oldest.id}.json`), "utf8"));
  currentFiles.set(oldest.logFile, fs.readFileSync(oldest.logFile, "utf8"));
  for (let i = 0; i < 50; i++) {
    const id = `fixture-current-${i}`, logFile = path.join(jobsDir, `${id}.log`);
    const record = { id, epoch: oldest.epoch, jobClass: "review", status: "completed", createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z", terminationPending: false, logFile };
    const detail = `${JSON.stringify(record, null, 2)}\n`, log = `fixture log ${i}\n`;
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), detail, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(logFile, log, { flag: "wx", mode: 0o600 });
    currentFiles.set(path.join(jobsDir, `${id}.json`), detail); currentFiles.set(logFile, log);
    state.jobs.push(record);
  }
  for (let i = 0; i < 2000; i++) {
    const id = `preserved-old-${String(i).padStart(4, "0")}`;
    const record = { id, epoch: "22222222-2222-4222-8222-222222222222", jobClass: "review", status: "completed",
      createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", terminationPending: false, logFile: null };
    const text = `${JSON.stringify(record, null, 2)}\n`;
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), text, { flag: "wx", mode: 0o600 });
    oldRecords.set(id, text); state.jobs.push(record);
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  assert.ok(fs.readdirSync(jobsDir).length < 4096);
  const currentJobs = state.jobs.filter(job => job.epoch === oldest.epoch);
  assert.equal(currentJobs.length, 51);
  const started = performance.now(), result = task(1, 180000), elapsed = performance.now() - started;
  t.diagnostic(`CLI task with existing state inventory: ${Math.round(elapsed)} ms`);
  assert.equal(result.status, 0, `inventory task: ${result.error?.code ?? "no spawn error"}; signal=${result.signal}; ${result.stderr}`);
  assert.ok(elapsed < 180000, `CLI task exceeded its end-to-end time budget: ${elapsed} ms`);
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8")), indexed = new Map(after.jobs.map(job => [job.id, job]));
  for (const job of currentJobs) assert.deepEqual(indexed.get(job.id), job, `${job.id} must stay indexed`);
  for (const [file, content] of currentFiles) assert.equal(fs.readFileSync(file, "utf8"), content, `${file} must be preserved`);
  for (const [id, text] of oldRecords) {
    assert.ok(indexed.has(id), `${id} must stay indexed`);
    assert.deepEqual(indexed.get(id), JSON.parse(text), `${id} index record must be preserved`);
    assert.equal(fs.readFileSync(path.join(jobsDir, `${id}.json`), "utf8"), text, `${id} detail must be preserved`);
  }
  const oldId = "preserved-old-0000";
  const oldResult = spawnSync(process.execPath, [command, "result", "--json", "--cwd", workspace, oldId],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(oldResult.error, undefined); assert.equal(oldResult.signal, null); assert.equal(oldResult.status, 0, oldResult.stderr);
  const output = JSON.parse(oldResult.stdout), expectedOld = JSON.parse(oldRecords.get(oldId));
  assert.deepEqual(output.job, expectedOld); assert.deepEqual(output.storedJob, expectedOld);
  verifiedDone = true;
});
