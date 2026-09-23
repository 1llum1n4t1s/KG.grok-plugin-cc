import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobRecord,
  resolveCurrentSessionId,
  runTrackedJob
} from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, saveState, upsertJob, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

function baseJob(workspace, id) {
  return { id, workspaceRoot: workspace, status: "queued", jobClass: "review", title: "Review" };
}

test("session identity prefers the shared id and falls back to the Codex thread id", () => {
  assert.equal(
    resolveCurrentSessionId({ GROK_COMPANION_SESSION_ID: "claude-session", CODEX_THREAD_ID: "codex-task" }),
    "claude-session"
  );
  assert.equal(resolveCurrentSessionId({ CODEX_THREAD_ID: "codex-task" }), "codex-task");
  assert.equal(resolveCurrentSessionId({ CODEX_THREAD_ID: "   " }), null);

  const record = createJobRecord(
    { id: "codex-job" },
    { env: { CODEX_THREAD_ID: "codex-task" } }
  );
  assert.equal(record.sessionId, "codex-task");
});

test("a transient process identity lookup failure does not prevent a task from starting", async () => {
  const workspace = makeTempDir();
  const job = baseJob(workspace, "transient-process-lookup");
  saveState(workspace, { version: 1, config: {}, jobs: [job] });
  writeJobFile(workspace, job.id, job);
  let lookups = 0;

  await runTrackedJob(job, async () => ({
    exitStatus: "completed",
    payload: { ok: true },
    rendered: "done",
    summary: "done"
  }), {
    getProcessSnapshotImpl() {
      lookups += 1;
      return lookups === 1 ? null : { startKey: "verified-start" };
    }
  });

  assert.equal(lookups, 2);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(stored.status, "completed");
  assert.equal(stored.processStartKey, "verified-start");
});

test("a task stays queued when process identity cannot be verified", async () => {
  const workspace = makeTempDir();
  const job = baseJob(workspace, "missing-process-identity");
  saveState(workspace, { version: 1, config: {}, jobs: [job] });
  writeJobFile(workspace, job.id, job);
  let lookups = 0;
  let ran = false;

  await assert.rejects(
    runTrackedJob(job, async () => {
      ran = true;
    }, {
      getProcessSnapshotImpl() {
        lookups += 1;
        return null;
      }
    }),
    /Cannot verify the Grok job process identity/i
  );

  assert.equal(lookups, 3);
  assert.equal(ran, false);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "queued");
});

test("a worker never starts a queued job that was already cancelled", async () => {
  const workspace = makeTempDir();
  const job = { ...baseJob(workspace, "cancel-before-start"), status: "cancelled" };
  saveState(workspace, { version: 1, config: {}, jobs: [job] });
  writeJobFile(workspace, job.id, job);
  let ran = false;

  await assert.rejects(
    runTrackedJob(job, async () => {
      ran = true;
      return {};
    }),
    /already cancelled/i
  );
  assert.equal(ran, false);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "cancelled");
});

test("cancellation during execution remains terminal when the runner returns", async () => {
  const workspace = makeTempDir();
  const job = baseJob(workspace, "cancel-during-run");
  saveState(workspace, { version: 1, config: {}, jobs: [job] });
  writeJobFile(workspace, job.id, job);

  await runTrackedJob(job, async () => {
    const cancelled = { ...readJobFile(resolveJobFile(workspace, job.id)), status: "cancelled", phase: "cancelled" };
    writeJobFile(workspace, job.id, cancelled);
    upsertJob(workspace, { id: job.id, status: "cancelled", phase: "cancelled" });
    return {
      exitStatus: "completed",
      payload: { ok: true },
      rendered: "done",
      summary: "done"
    };
  });

  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "cancelled");
});
