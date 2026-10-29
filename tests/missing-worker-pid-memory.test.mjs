import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { inspectTrackedJobProcess } from "../plugins/grok/scripts/lib/process.mjs";
import { isActiveJob } from "../plugins/grok/scripts/lib/job-status.mjs";

// 失敗条件: running/旧pendingのPID欠落をabsentと誤認する。queuedの未claim証拠と、
// 同job/startKey両保存先のdurable終了証拠だけはPIDなしで再試行を完結できる。
const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const source = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));
for (const platform of ["win32", "linux", "darwin"]) {
  for (const pid of [null, undefined, 0, -1, 1.5, "42"]) {
    test(`missing tracked PID never proves worker exit: ${platform}/${pid}`, () => {
      assert.equal(inspectTrackedJobProcess(pid, "start", { platform }), "unavailable");
    });
  }
  for (const kind of ["running", "queued", "confirmed", "wrong-generation", "one-sided", "legacy"]) {
    test(`cancel only accepts same-generation worker absence proof: ${platform}/${kind}`, async () => {
      const indexed = { id: "job", epoch: "current-epoch", status: kind === "queued" ? "queued" : kind === "running" ? "running" : "cancelled",
        pid: null, createdAt: "created", processStartKey: kind === "queued" ? undefined : "start", grokPromptState: "not-sent", grokTransport: "broker",
        ...(kind === "queued" || kind === "running" ? {} : { terminationPending: true, workerStopConfirmed: true }),
        ...(["confirmed", "wrong-generation", "one-sided"].includes(kind) ? {
          workerStopProof: "process-exited", workerStopProcessStartKey: kind === "wrong-generation" ? "other" : "start" } : {}) };
      let stored = { ...indexed };
      if (kind === "one-sided") delete stored.workerStopConfirmed;
      const original = JSON.stringify([indexed, stored]);
      let output = 0;
      const context = vm.createContext({ process: { platform, env: {}, stderr: { write() {} } },
        parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "virtual",
        resolveCancelableJob: () => ({ workspaceRoot: "virtual", job: indexed }), isActiveJob: () => true,
        updateState: (_root, callback) => callback({ jobs: [indexed] }, { epoch: "current-epoch" }), withStateSnapshot: (_root, callback) => callback({ jobs: [indexed] }, { epoch: "current-epoch" }),
        readStoredJob: () => stored, writeJobFile: (_root, _id, value) => { stored = value; },
        nowIso: () => "now", appendLogLine() {}, setTimeout: () => ({ unref() {} }),
        createProcessLookupDiagnostics: () => ({}),
        inspectTrackedJobProcess: (pid, key) => inspectTrackedJobProcess(pid, key, { platform }),
        stopTrackedJobProcess: () => assert.fail("Missing PID must never be stopped"),
        outputCommandResult: () => { output += 1; }, renderCancelReport: () => "report"
      });
      Object.assign(context, { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence, performance });
      vm.runInContext(source, context);
      const operation = context.handleCancel([]);
      const safe = platform === "win32" && ["queued", "confirmed"].includes(kind);
      if (safe) {
        await operation;
        assert.equal(output, 1); assert.equal(stored.terminationPending, false);
        if (kind === "queued") assert.equal(stored.workerStopProof, "never-started");
      } else {
        await assert.rejects(operation, /pending|verify/i);
        assert.equal(output, 0);
        if (platform !== "win32") assert.equal(JSON.stringify([indexed, stored]), original);
        else assert.equal(stored.terminationPending, true);
      }
    });
  }
}

const hook = fs.readFileSync(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url), "utf8");
const cleanupSource = hook.slice(hook.indexOf("async function cleanupOwnedSessionJobs"), hook.indexOf("function handleSessionStart"));
for (const platform of ["win32", "linux", "darwin"]) {
for (const proof of ["missing", "confirmed", "wrong-generation", "one-sided", "proof-changed", "never-started"]) {
  test(`SessionEnd accepts only durable same-generation missing-PID proof: ${platform}/${proof}`, async () => {
    const job = { id: "job", epoch: "current-epoch", sessionId: "session", status: "cancelled", terminationPending: true, pid: null,
      createdAt: "created", processStartKey: proof === "never-started" ? undefined : "start", grokTransport: "broker", grokPromptState: "not-sent",
      ...(proof === "missing" ? {} : { workerStopConfirmed: true, workerStopProof: proof === "never-started" ? "never-started" : "process-exited",
        workerStopProcessStartKey: proof === "wrong-generation" ? "other" : proof === "never-started" ? null : "start" }) };
    let stored = { ...job };
    if (proof === "one-sided") delete stored.workerStopConfirmed;
    const state = { jobs: [job], reviewGateSessions: [] };
    const original = JSON.stringify([job, stored]);
    let concurrentSnapshot;
    let transactions = 0;
    let writes = 0;
    const context = vm.createContext({ process: { platform, stderr: { write() {} } }, performance: { now: () => 0 },
      fs: { existsSync: () => true }, resolveWorkspaceRoot: () => "virtual", resolveStateFile: () => "state", resolveJobFile: () => "job",
      readJobFile: () => stored, writeJobFile: (_root, _id, value) => { writes++; stored = value; }, nowIso: () => "now", appendLogLine() {},
      updateState: (_root, callback) => {
        transactions += 1;
        if (transactions === 2) {
          if (platform !== "win32") assert.equal(JSON.stringify([state.jobs[0], stored]), original);
          if (proof === "proof-changed") stored.workerStopProof = null;
          concurrentSnapshot = JSON.stringify([state.jobs[0], stored]);
        }
        callback(state, { epoch: "current-epoch" });
      }, withStateSnapshot: (_root, callback) => callback(state, { epoch: "current-epoch" }),
      createProcessLookupDiagnostics: () => ({}), isActiveJob,
      inspectTrackedJobProcess: (pid, key) => {
        if (platform !== "win32") assert.fail("Unleased POSIX workers must not be inspected by PID");
        return inspectTrackedJobProcess(pid, key, { platform });
      },
      stopTrackedJobProcess: () => assert.fail("Missing worker PID must never be stopped")
    });
    Object.assign(context, { hasGenerationIdentity, sameTurnEvidence });
    vm.runInContext(cleanupSource, context);
    await context.cleanupSessionJobs("virtual", "session");
    assert.equal(state.jobs.length, platform === "win32" && ["confirmed", "never-started"].includes(proof) ? 0 : 1);
    if (platform !== "win32") {
      assert.equal(writes, 0);
      assert.equal(state.jobs[0], job);
      assert.equal(job.terminationPending, true);
      assert.equal(JSON.stringify([state.jobs[0], stored]), concurrentSnapshot ?? original);
    }
  });
}
}
