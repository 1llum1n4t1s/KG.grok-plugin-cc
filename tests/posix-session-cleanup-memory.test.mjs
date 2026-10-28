import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// 失敗条件: SessionEndが所有workerへ停止要求を届けない、共有brokerや別sessionを
// 止める、worker終了だけでagent停止も確定する、期限切れや旧世代を成功扱いする。
const hook = fs.readFileSync(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url), "utf8");
const helper = hook.indexOf("async function cleanupOwnedSessionJobs");
const source = hook.slice(helper < 0 ? hook.indexOf("function cleanupSessionJobs") : helper, hook.indexOf("function handleSessionStart"));
for (const platform of ["linux", "darwin", "win32"]) {
for (const transport of ["direct", "broker", "legacy"]) {
for (const confirmed of [true, false]) {
for (const identity of ["match", "absent", "mismatch", "unavailable", "timeout", "replaced", "control-timeout", "ack-replaced", "group-proof", "child-only"]) {
  test(`SessionEnd requests owned cancellation and retains uncertainty: ${platform}/${transport}/${confirmed}/${identity}`, async () => {
    const mine = { id: "mine", epoch: "current-epoch", sessionId: "ending", status: "running", pid: 42, processStartKey: "worker-start",
      grokSessionId: "grok-session", grokTransport: transport, grokBrokerGeneration: "broker-generation",
      ...(platform === "linux" ? { claimToken: "claim", workerLease: { id: "lease" } } : {}),
      ...(transport === "direct" ? { grokDirectGeneration: "direct-generation", grokDirectOwnerPid: 42,
        grokDirectOwnerStartKey: "worker-start" } : {}) };
    const other = { id: "other", epoch: "current-epoch", sessionId: "other-session", status: "running", pid: 99 };
    const state = { jobs: [mine, other], reviewGateSessions: [{ sessionId: "ending", epoch: "current-epoch" }, { sessionId: "other-session", epoch: "current-epoch" }] };
    const stored = new Map(state.jobs.map(job => [job.id, { ...job }]));
    let locked = false;
    let requested = 0;
    let waited = 0;
    const context = vm.createContext({ process: { platform, stderr: { write() {} } }, performance: { now: () => 0 },
      setTimeout: callback => { if (identity === "control-timeout") Promise.resolve().then(callback); return { unref() {} }; }, clearTimeout() {},
      fs: { existsSync: () => true }, resolveWorkspaceRoot: () => "workspace", resolveStateFile: () => "state",
      resolveJobFile: (_root, id) => id, readJobFile: id => stored.get(id), listJobs: () => state.jobs,
      writeJobFile: (_root, id, value) => { assert.equal(locked, true); stored.set(id, value); },
      updateState: (_root, callback, options) => { assert.equal(options.timeoutMs, 2200); assert.equal(locked, false); locked = true;
        try { callback(state, { epoch: "current-epoch" }); } finally { locked = false; } },
      withStateSnapshot: (_root, callback, options) => { assert.equal(options.timeoutMs, 2200); assert.equal(locked, false); locked = true;
        try { return callback(state, { epoch: "current-epoch" }); } finally { locked = false; } },
      nowIso: () => "now", appendLogLine() {}, createProcessLookupDiagnostics: () => ({}),
      isActiveJob: job => ["queued", "running"].includes(job.status) || job.terminationPending === true,
      sameLinuxLease: (left, right) => left.id === right.id,
      verifyPublishedLinuxLeaseRecords: ({ indexed, stored: record, lease }) => {
        assert.equal(indexed.workerLease.id, lease.id); assert.equal(record.workerLease.id, lease.id);
      },
      waitForDirectAgentStop: async (_root, id, expected, options) => {
        assert.equal(locked, false); assert.equal(id, "mine");
        assert.equal(expected.grokDirectGeneration, "direct-generation");
        assert.ok(options.timeoutMs <= 2200); assert.equal(stored.get(id).terminationPending, true);
        if (confirmed) for (const current of [mine, stored.get(id)]) {
          current.grokDirectStopGeneration = "direct-generation";
          current.grokDirectStopKind = identity === "group-proof" ? "posix-group-empty" : identity === "child-only" ? "posix-child-closed" : "job-empty";
        }
        requested += 1; return confirmed;
      }, readDirectAgentStop: () => confirmed,
      interruptGrokTurn: async (_cwd, options) => {
        assert.equal(locked, false); assert.equal(stored.get("mine").status, "cancelled");
        assert.equal(options.executionId, "mine"); assert.equal(options.sessionId, "grok-session");
        assert.equal(options.brokerGeneration, "broker-generation");
        requested += 1;
        if (identity === "control-timeout") return new Promise(() => {});
        return { stopConfirmed: confirmed && transport === "broker" };
      },
      inspectTrackedJobProcess: () => {
        if (identity === "ack-replaced" && transport === "direct") stored.get("mine").grokDirectStopKind = null;
        return ["timeout", "replaced", "control-timeout", "ack-replaced", "group-proof", "child-only"].includes(identity) ? "match" : identity;
      },
      stopTrackedJobProcess: (pid, key, options) => {
        assert.equal(locked, platform === "win32"); assert.equal(pid, 42); assert.equal(key, "worker-start");
        assert.equal(options.processLookupDeadline, 2200); waited += 1;
        if (identity === "timeout") throw Error("Process exit could not be confirmed.");
        if (identity === "replaced") mine.processStartKey = "replacement-start";
      }
    });
    vm.runInContext(source, context);
    await context.cleanupSessionJobs("workspace", "ending");
    assert.equal(requested, transport === "legacy" ? 0 : 1);
    const ackReplaced = ["ack-replaced", "child-only"].includes(identity) && transport === "direct";
    const controlTimeout = identity === "control-timeout" && transport === "broker";
    const canRemove = platform !== "linux" && confirmed && transport !== "legacy" && !["unavailable", "timeout", "replaced"].includes(identity) && !ackReplaced && !controlTimeout;
    assert.equal(state.jobs.some(job => job.id === "mine"), !canRemove);
    assert.equal(stored.get("mine").status, "cancelled");
    assert.equal(stored.get("mine").terminationPending, true);
    assert.equal(state.jobs.find(job => job.id === "other"), other);
    assert.equal(other.status, "running");
    assert.equal(waited, platform !== "linux" && confirmed && transport !== "legacy" && !["absent", "mismatch", "unavailable"].includes(identity) &&
      !controlTimeout && !(ackReplaced && platform === "win32") ? 1 : 0);
  });
}
}
}
}

for (const status of ["queued", "completed"]) {
  test(`POSIX SessionEnd preserves existing ${status} cleanup behavior`, async () => {
    const job = { id: "mine", epoch: "current-epoch", createdAt: "created", sessionId: "ending", status, grokTransport: "direct", grokDirectGeneration: "generation" };
    const state = { jobs: [job], reviewGateSessions: [] };
    let stored = { ...job };
    const context = vm.createContext({ process: { platform: "darwin", stderr: { write() {} } }, performance: { now: () => 0 },
      fs: { existsSync: () => true }, resolveWorkspaceRoot: () => "workspace", resolveStateFile: () => "state",
      resolveJobFile: () => "job", readJobFile: () => stored, listJobs: () => state.jobs,
      writeJobFile: (_root, _id, value) => { stored = value; }, updateState: (_root, fn) => fn(state, { epoch: "current-epoch" }),
      nowIso: () => "now", appendLogLine() {}, readDirectAgentStop: () => false,
      isActiveJob: job => ["queued", "running"].includes(job.status) || job.terminationPending === true,
      waitForDirectAgentStop: () => assert.fail("No active direct agent remains") });
    vm.runInContext(source, context);
    await context.cleanupSessionJobs("workspace", "ending");
    assert.equal(state.jobs.length, status === "queued" ? 1 : 0);
    if (status === "queued") assert.equal(stored.status, "cancelled");
  });

  test(`Linux SessionEnd retains ${status} records without a verified lease`, async () => {
    const job = { id: "mine", epoch: "current-epoch", createdAt: "created", sessionId: "ending", status };
    const state = { jobs: [job], reviewGateSessions: [{ sessionId: "ending", epoch: "current-epoch" }] };
    const stored = { ...job };
    const context = vm.createContext({ process: { platform: "linux", stderr: { write() {} } }, performance: { now: () => 0 },
      fs: { existsSync: () => true }, resolveWorkspaceRoot: () => "workspace", resolveStateFile: () => "state",
      resolveJobFile: () => "job", readJobFile: () => stored,
      writeJobFile: () => assert.fail("Unverified records must not be changed"),
      updateState: (_root, fn) => fn(state, { epoch: "current-epoch" }),
      isActiveJob: current => ["queued", "running"].includes(current.status) || current.terminationPending === true });
    vm.runInContext(source, context);
    await context.cleanupSessionJobs("workspace", "ending");
    assert.equal(state.jobs.length, 1);
    assert.equal(job.status, status);
    assert.equal(stored.status, status);
  });
}
