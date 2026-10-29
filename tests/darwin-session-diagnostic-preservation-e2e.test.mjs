import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { reserveDarwinTrackedJob, runTrackedJob } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { registerDirectAgentOwner } from "../plugins/grok/scripts/lib/direct-agent-control.mjs";

// SessionEnd の遅延候補読取りが失敗した場合、存在しない旧 log を再生成せず
// diagnostic を stderr に残し、両 job record を保留する。
test("macOS SessionEnd diagnostic does not recreate a missing job log", { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const data = fs.realpathSync(makeTempDir("grok-darwin-session-diagnostic-state-"));
  const workspace = fs.realpathSync(makeTempDir("grok-darwin-session-diagnostic-workspace-"));
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const stateDir = resolveStateDir(workspace);
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const log = path.join(stateDir, "jobs", "stale-session-job.log");
  const job = { id: "stale-session-job", workspaceRoot: workspace, sessionId: "session", jobClass: "task",
    createdAt: "2020-01-01T00:00:00.000Z", logFile: log };
  const reservation = reserveDarwinTrackedJob(job, { logFile: log });
  let failure, assertionFailure;
  try {
    try {
      await runTrackedJob(job, async owner => {
        // 実 lease / claim に紐づく direct generation を登録し、停止未確認の取消を通す。
        const controller = registerDirectAgentOwner(workspace, job.id, { close: async () => "never-started" }, { ownerToken: owner });
        try {
          const detail = resolveJobFile(workspace, job.id);
          const before = readJobFile(detail);
          assert.equal(before.epoch, epoch);
          assert.equal(before.workerLease.id, reservation.lease.id);
          assert.equal(before.claimToken, reservation.claimToken);
          assert.equal(before.grokDirectGeneration, controller.generation);
          assert.equal(fs.existsSync(log), false);
          const hook = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));
          const preload = fileURLToPath(new URL("./fixtures/darwin-session-diagnostic-failure.cjs", import.meta.url));
          const result = spawnSync(process.execPath, ["--require", preload, hook, "SessionEnd"], {
            env: { ...process.env, GROK_TEST_DIAGNOSTIC_STATE: stateDir }, input: JSON.stringify({ cwd: workspace, session_id: "session" }),
            encoding: "utf8", timeout: 15000
          });
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stderr, /fixture delayed candidate read failed/);
          assert.equal(fs.existsSync(log), false, "late diagnostic recreated the missing log");
          const indexed = loadState(workspace).jobs.find(record => record.id === job.id), stored = readJobFile(detail);
          for (const record of [indexed, stored]) {
            assert.ok(record);
            assert.equal(record.status, "cancelled");
            assert.equal(record.terminationPending, true);
            for (const key of ["id", "epoch", "claimToken", "createdAt", "pid", "processStartKey", "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey"]) {
              assert.equal(record[key], before[key], key);
            }
            assert.deepEqual(record.workerLease, before.workerLease);
          }
        } catch (error) { assertionFailure = error; throw error; }
        finally { controller.dispose(); }
        return { exitStatus: "completed", rendered: "done" };
      }, { logFile: log, reservation });
    } catch (error) { failure = error; }
    if (assertionFailure) throw assertionFailure;
    assert.ok(failure, "cancelled job must not complete");
    assert.match(failure.message, /cancelled|terminal|termination pending/i);
    assert.equal(fs.existsSync(log), false, "worker teardown recreated the missing log");
  } finally { fs.closeSync(reservation.fd); }
});

test("macOS SessionEnd retains unleased history while clearing the session review gate", { skip: process.platform !== "darwin", timeout: 45000 }, t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const data = fs.realpathSync(makeTempDir("grok-darwin-session-history-state-"));
  const workspace = fs.realpathSync(makeTempDir("grok-darwin-session-history-workspace-"));
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const stateDir = resolveStateDir(workspace);
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const jobs = path.join(stateDir, "jobs"); fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const detail = path.join(jobs, "completed-session-job.json");
  const job = { id: "completed-session-job", epoch, status: "completed", sessionId: "session", jobClass: "task",
    createdAt: "2020-01-01T00:00:00.000Z", completedAt: "2020-01-01T00:01:00.000Z", terminationPending: false,
    grokPromptState: "terminal", grokSessionId: "fixture-session", pid: null };
  fs.writeFileSync(detail, JSON.stringify(job), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {}, jobs: [job],
    reviewGateSessions: [{ sessionId: "session" }] }), { mode: 0o600 });
  const hook = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [hook, "SessionEnd"], {
    env: { ...process.env }, input: JSON.stringify({ cwd: workspace, session_id: "session" }), encoding: "utf8", timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(saved.jobs, [job]);
  assert.deepEqual(saved.reviewGateSessions, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(detail, "utf8")), job);
});
