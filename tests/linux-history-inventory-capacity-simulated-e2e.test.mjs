import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac process と CLI を使用するが procfs/mount/flock は模擬する。
// 計測には既存 state inventory を含み、Linux kernel の性能を実証しない。
test("Linux CLI completes history pruning with 2000 preserved old jobs", {
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
  for (let i = 0; i < 51; i++) { const result = task(i); assert.equal(result.status, 0, result.stderr); }
  allStopped = false;
  const sweepResult = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 120000 });
  assert.equal(sweepResult.status, 0, sweepResult.stderr); allStopped = true;
  assert.equal(JSON.parse(sweepResult.stdout).reclaimed, 51);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const verified = state.jobs.filter(job => job.status === "completed" && job.workerLease == null &&
    job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  assert.equal(verified.length, 51);
  const oldest = verified[0], oldRecords = new Map();
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
  const started = performance.now(), result = task(51, 180000), elapsed = performance.now() - started;
  t.diagnostic(`CLI task with existing state inventory: ${Math.round(elapsed)} ms`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 180000, `CLI task exceeded its end-to-end time budget: ${elapsed} ms`);
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8")), ids = new Set(after.jobs.map(job => job.id));
  assert.ok(!ids.has(oldest.id), "a verified old current-epoch job must be pruned");
  for (const [id, text] of oldRecords) {
    assert.ok(ids.has(id), `${id} must stay indexed`);
    assert.equal(fs.readFileSync(path.join(jobsDir, `${id}.json`), "utf8"), text, `${id} detail must be preserved`);
  }
  verifiedDone = true;
});
