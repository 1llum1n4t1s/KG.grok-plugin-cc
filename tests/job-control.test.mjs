import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildStatusSnapshot,
  filterJobsForCurrentSession,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/grok/scripts/lib/job-control.mjs";
import { migrateStateLock, resolveStateDir, saveState } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

function seedJobs(t, workspace, jobs) {
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"];
  const previous = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  process.env.CLAUDE_PLUGIN_DATA = path.join(workspace, "plugin-data");
  delete process.env.PLUGIN_DATA;
  if (["win32", "linux", "darwin"].includes(process.platform)) {
    migrateStateLock(workspace, {
      offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace)
    });
  }
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: jobs.map((job, index) => ({
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      updatedAt: `2026-01-01T00:00:0${index}.000Z`,
      ...job
    }))
  });
}

test("session filtering accepts an explicit hook session id", () => {
  const jobs = [
    { id: "mine", sessionId: "hook-session" },
    { id: "theirs", sessionId: "other-session" }
  ];

  assert.deepEqual(
    filterJobsForCurrentSession(jobs, {
      sessionId: "hook-session",
      env: { GROK_COMPANION_SESSION_ID: "different-session" }
    }).map((job) => job.id),
    ["mine"]
  );
});

test("session filtering falls back to the environment when the explicit hook session id is blank", () => {
  const jobs = [
    { id: "mine", sessionId: "environment-session" },
    { id: "theirs", sessionId: "other-session" }
  ];

  assert.deepEqual(
    filterJobsForCurrentSession(jobs, {
      sessionId: "   ",
      env: { GROK_COMPANION_SESSION_ID: "environment-session" }
    }).map((job) => job.id),
    ["mine"]
  );
});

test("cancel without an id selects only the sole active job in the current session", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [
    { id: "mine", status: "running", sessionId: "session-a" },
    { id: "theirs", status: "running", sessionId: "session-b" }
  ]);

  assert.equal(resolveCancelableJob(workspace, "", { env: { GROK_COMPANION_SESSION_ID: "session-a" } }).job.id, "mine");
});

test("cancel without an id accepts the Codex thread id as session identity", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [
    { id: "mine", status: "running", sessionId: "codex-task" },
    { id: "theirs", status: "running", sessionId: "other-task" }
  ]);

  assert.equal(resolveCancelableJob(workspace, "", { env: { CODEX_THREAD_ID: "codex-task" } }).job.id, "mine");
});

test("a cancellation with pending process termination can be retried by job id", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [{ id: "pending", status: "cancelled", terminationPending: true, sessionId: "session-a" }]);

  assert.equal(resolveCancelableJob(workspace, "pending", { env: {} }).job.id, "pending");
  const status = buildStatusSnapshot(workspace, { env: {} });
  assert.deepEqual(status.running.map((job) => job.id), ["pending"]);
  assert.equal(status.latestFinished, null);
  assert.throws(() => resolveResultJob(workspace, "pending"), /needs process termination/i);
});

test("cancel without an id rejects multiple active jobs in the current session", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [
    { id: "mine-a", status: "queued", sessionId: "session-a" },
    { id: "mine-b", status: "running", sessionId: "session-a" }
  ]);

  assert.throws(
    () => resolveCancelableJob(workspace, "", { env: { GROK_COMPANION_SESSION_ID: "session-a" } }),
    /Multiple Grok jobs are active/i
  );
});

test("cancel without an id never crosses sessions when session identity is absent", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [{ id: "unknown-owner", status: "running", sessionId: "session-b" }]);

  assert.throws(() => resolveCancelableJob(workspace, "", { env: {} }), /Pass an exact job id/i);
});

test("bare result rejects ambiguous parallel results", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [
    { id: "review-a", status: "completed", sessionId: "session-a" },
    { id: "review-b", status: "completed", sessionId: "session-a" }
  ]);
  const previous = process.env.GROK_COMPANION_SESSION_ID;
  process.env.GROK_COMPANION_SESSION_ID = "session-a";
  try {
    assert.throws(() => resolveResultJob(workspace, ""), /Multiple finished Grok jobs/i);
    assert.equal(resolveResultJob(workspace, "review-a").job.id, "review-a");
  } finally {
    if (previous == null) delete process.env.GROK_COMPANION_SESSION_ID;
    else process.env.GROK_COMPANION_SESSION_ID = previous;
  }
});

test("bare result uses CODEX_THREAD_ID when the shared session variable is absent", (t) => {
  const workspace = makeTempDir();
  seedJobs(t, workspace, [
    { id: "codex-result", status: "completed", sessionId: "codex-task" },
    { id: "other-result", status: "completed", sessionId: "other-task" }
  ]);
  const previousShared = process.env.GROK_COMPANION_SESSION_ID;
  const previousCodex = process.env.CODEX_THREAD_ID;
  delete process.env.GROK_COMPANION_SESSION_ID;
  process.env.CODEX_THREAD_ID = "codex-task";
  try {
    assert.equal(resolveResultJob(workspace, "").job.id, "codex-result");
  } finally {
    if (previousShared == null) delete process.env.GROK_COMPANION_SESSION_ID;
    else process.env.GROK_COMPANION_SESSION_ID = previousShared;
    if (previousCodex == null) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousCodex;
  }
});
