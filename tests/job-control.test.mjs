import assert from "node:assert/strict";
import test from "node:test";

import { resolveCancelableJob, resolveResultJob } from "../plugins/grok/scripts/lib/job-control.mjs";
import { saveState } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

function seedJobs(workspace, jobs) {
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

test("cancel without an id selects only the sole active job in the current session", () => {
  const workspace = makeTempDir();
  seedJobs(workspace, [
    { id: "mine", status: "running", sessionId: "session-a" },
    { id: "theirs", status: "running", sessionId: "session-b" }
  ]);

  assert.equal(resolveCancelableJob(workspace, "", { env: { GROK_COMPANION_SESSION_ID: "session-a" } }).job.id, "mine");
});

test("cancel without an id accepts the Codex thread id as session identity", () => {
  const workspace = makeTempDir();
  seedJobs(workspace, [
    { id: "mine", status: "running", sessionId: "codex-task" },
    { id: "theirs", status: "running", sessionId: "other-task" }
  ]);

  assert.equal(resolveCancelableJob(workspace, "", { env: { CODEX_THREAD_ID: "codex-task" } }).job.id, "mine");
});

test("cancel without an id rejects multiple active jobs in the current session", () => {
  const workspace = makeTempDir();
  seedJobs(workspace, [
    { id: "mine-a", status: "queued", sessionId: "session-a" },
    { id: "mine-b", status: "running", sessionId: "session-a" }
  ]);

  assert.throws(
    () => resolveCancelableJob(workspace, "", { env: { GROK_COMPANION_SESSION_ID: "session-a" } }),
    /Multiple Grok jobs are active/i
  );
});

test("cancel without an id never crosses sessions when session identity is absent", () => {
  const workspace = makeTempDir();
  seedJobs(workspace, [{ id: "unknown-owner", status: "running", sessionId: "session-b" }]);

  assert.throws(() => resolveCancelableJob(workspace, "", { env: {} }), /Pass an exact job id/i);
});

test("bare result rejects ambiguous parallel results", () => {
  const workspace = makeTempDir();
  seedJobs(workspace, [
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

test("bare result uses CODEX_THREAD_ID when the shared session variable is absent", () => {
  const workspace = makeTempDir();
  seedJobs(workspace, [
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
