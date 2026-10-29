import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { hasGenerationIdentity, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { isActiveJob } from "../plugins/grok/scripts/lib/job-status.mjs";

// 失敗条件: 個別fileのないterminal索引が永久残存する。逆に、待機中のfile作成・
// terminal世代置換・running/terminationPendingを個別file欠落だけで整理しない。
const hook = fs.readFileSync(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url), "utf8");
const source = hook.slice(hook.indexOf("async function cleanupOwnedSessionJobs"), hook.indexOf("function handleSessionStart"));
for (const platform of ["linux", "darwin", "win32"]) {
for (const status of ["completed", "failed", "cancelled"]) {
for (const race of ["unchanged", "file-created", "file-removed", "completedAt-changed", "createdAt-changed", "process-replaced", "running", "termination-pending"]) {
  test(`SessionEnd only removes stable terminal index without a job file: ${platform}/${status}/${race}`, async () => {
    const job = { id: "job", epoch: "current-epoch", sessionId: "session", status: race === "running" ? "running" : status,
      terminationPending: race === "termination-pending", createdAt: "created", completedAt: "completed" };
    const state = { jobs: [job], reviewGateSessions: platform === "linux" && race !== "unchanged"
      ? [{ sessionId: "session", epoch: "current-epoch" }] : [] };
    let exists = race === "file-removed";
    let stored = exists ? { ...job } : null;
    let transactions = 0;
    let locked = false;
    let writes = 0;
    const originalStatus = job.status, originalPending = job.terminationPending;
    const original = JSON.stringify([job, stored]);
    let concurrentSnapshot;
    const context = vm.createContext({ process: { platform, stderr: { write() {} } }, performance: { now: () => 0 }, isActiveJob,
      fs: { existsSync: path => path === "state" || exists }, resolveWorkspaceRoot: () => "workspace", resolveStateFile: () => "state",
      resolveJobFile: () => "job", readJobFile: () => { assert.equal(locked, true); return stored; },
      writeJobFile: (_root, _id, value) => { assert.equal(locked, true); writes++; exists = true; stored = value; },
      nowIso: () => "now", appendLogLine() {},
      updateState: (_root, callback) => {
        assert.equal(locked, false); locked = true;
        try {
          transactions += 1;
          if (transactions === 2) {
            if (platform !== "win32") assert.equal(JSON.stringify([state.jobs[0], stored]), original);
            if (race === "file-created") exists = true, stored = { ...job };
            if (race === "file-removed") exists = false, stored = null;
            if (race === "completedAt-changed") job.completedAt = "replacement";
            if (race === "createdAt-changed") job.createdAt = "replacement";
            if (race === "process-replaced") job.processStartKey = "replacement";
            concurrentSnapshot = JSON.stringify([state.jobs[0], stored]);
          }
          callback(state, { epoch: "current-epoch" });
        } finally { locked = false; }
      }
    });
    Object.assign(context, { hasGenerationIdentity, sameTurnEvidence });
    vm.runInContext(source, context);
    await context.cleanupSessionJobs("workspace", "session");
    assert.equal(state.jobs.length, platform === "win32" && race === "unchanged" ? 0 : 1);
    if (platform !== "win32") {
      assert.equal(transactions, platform === "linux" && race === "unchanged" ? 1 : 2);
      assert.equal(writes, 0);
      assert.equal(state.jobs[0], job);
      assert.equal(job.status, originalStatus);
      assert.equal(job.terminationPending, originalPending);
      assert.equal(JSON.stringify([state.jobs[0], stored]), concurrentSnapshot ?? original);
    }
  });
}
}
}
