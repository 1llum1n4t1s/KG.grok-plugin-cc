import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { boundJsonDiagnostic, hasGenerationIdentity, sameDarwinLease, sameLinuxLease, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { inspectTrackedJobProcess } from "../plugins/grok/scripts/lib/process.mjs";
import { isActiveJob } from "../plugins/grok/scripts/lib/job-status.mjs";

// 失敗条件: index/fileの片側queuedを未起動証拠へ昇格する、取消保存後の両側世代
// 交換を旧jobの確定へ使う。PID/startKeyが空でもcreatedAt/startedAtを省略しない。
const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const cancelSource = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));
const hook = fs.readFileSync(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url), "utf8");
const hookSource = hook.slice(hook.indexOf("async function cleanupOwnedSessionJobs"), hook.indexOf("function handleSessionStart"));
const epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const claimToken = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const leaseId = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
function leaseFor(platform) {
  return { id: leaseId, slot: 0,
    path: platform === "linux" ? `/virtual/worker-leases-v1/${epoch}/slot-000.lease` : "/virtual/worker-leases/slot-000.lease",
    dev: "1", ino: "2", stateGeneration: epoch, ...(platform === "darwin" ? { directoryDev: "1", directoryIno: "4" } : {}) };
}
function verifyLeaseRecords(platform, lease, index, detail, current, expectedCreatedAt) {
  const compare = platform === "linux" ? sameLinuxLease : sameDarwinLease;
  if (!index || !detail || index.id !== detail.id || index.epoch !== epoch || detail.epoch !== epoch ||
      index.claimToken !== claimToken || detail.claimToken !== claimToken ||
      typeof expectedCreatedAt !== "string" || !expectedCreatedAt || index.createdAt !== expectedCreatedAt || detail.createdAt !== expectedCreatedAt ||
      index.status !== detail.status || !compare(index.workerLease, lease) || !compare(detail.workerLease, lease) || !compare(current, lease)) {
    throw new Error(`${platform} lease job records disagree`);
  }
}
for (const platform of ["win32", "linux", "darwin"]) {
for (const race of ["consistent", "legacy", "index-running", "file-running", "file-missing", "read-createdAt", "read-startedAt", "read-broker", "commit-createdAt", "commit-startedAt", "commit-broker"]) {
  test(`queued cancellation requires valid stop and generation evidence: ${platform}/${race}`, async () => {
    const leased = platform !== "win32" && (race === "consistent" || race.startsWith("commit-") || race.startsWith("read-") ||
      ["index-running", "file-running"].includes(race));
    const lease = leaseFor(platform);
    const indexed = { id: "job", epoch, status: race === "index-running" ? "running" : "queued", pid: null,
      createdAt: race === "legacy" ? undefined : "original", grokPromptState: "not-sent", grokTransport: "broker", grokBrokerGeneration: "generation",
      ...(leased ? { claimToken, workerLease: lease } : {}) };
    let stored = race === "file-missing" ? null : { ...indexed, status: race === "file-running" ? "running" : "queued" };
    let output = 0;
    let mutations = 0;
    let replacements = 0;
    let replacementSnapshot;
    let acquisitions = 0;
    const replace = () => { replacements += 1; for (const current of [indexed, stored]) {
      if (race.endsWith("createdAt")) current.createdAt = "replacement";
      if (race.endsWith("startedAt")) current.startedAt = "replacement";
      if (race.endsWith("broker")) current.grokBrokerGeneration = "replacement";
    } if (replacements === 1) replacementSnapshot = JSON.stringify([indexed, stored]); };
    const context = vm.createContext({ process: { platform, env: {}, stderr: { write() {} } },
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "virtual",
      resolveCancelableJob: () => ({ workspaceRoot: "virtual", job: indexed }), isActiveJob,
      updateState: (_root, callback, options) => {
        mutations += 1; if (mutations === 2 && race.startsWith("commit-")) replace();
        const state = { jobs: [indexed] }, scope = { epoch, check() {} };
        return options?.aroundCommit ? options.aroundCommit(state, scope, () => callback(state, scope)) : callback(state, scope);
      },
      withStateSnapshot: (_root, callback) => { if (race.startsWith("read-")) replace(); return callback({ jobs: [indexed] }, { epoch }); },
      readStoredJob: () => stored, writeJobFile: (_root, _id, value) => { stored = value; }, nowIso: () => "now", appendLogLine() {},
      setTimeout: () => ({ unref() {} }), createProcessLookupDiagnostics: () => ({}),
      sameLinuxLease, sameDarwinLease,
      verifyPublishedLinuxLeaseRecords: ({ indexed: index, stored: detail, lease: current }) => {
        verifyLeaseRecords(platform, lease, index, detail, current, "original");
      },
      verifyPublishedDarwinLeaseRecords: ({ indexed: index, stored: detail, lease: current }) => {
        verifyLeaseRecords(platform, lease, index, detail, current, "original");
      },
      darwinLeaseDirectory: () => ({ expectedDirectoryIdentity: { dev: "1", ino: "4" } }),
      withAvailableLinuxLease: (current, _scope, callback) => {
        assert.equal(current, lease); acquisitions += 1;
        assert.equal(indexed.workerStopConfirmed, false); assert.equal(stored.workerStopConfirmed, false);
        return { status: "available", value: callback() };
      },
      withAvailableDarwinLease: (current, _scope, callback) => {
        assert.equal(current, lease); acquisitions += 1;
        assert.equal(indexed.workerStopConfirmed, false); assert.equal(stored.workerStopConfirmed, false);
        if (race.startsWith("read-")) replace();
        return { status: "available", value: callback() };
      },
      inspectTrackedJobProcess: (pid, key) => inspectTrackedJobProcess(pid, key, { platform }),
      stopTrackedJobProcess: () => assert.fail("An unowned PID must never be stopped"),
      outputCommandResult: () => { output += 1; }, renderCancelReport: () => "report"
    });
    Object.assign(context, { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence, performance });
    vm.runInContext(cancelSource, context);
    const before = JSON.stringify([indexed, stored]);
    const operation = context.handleCancel([]);
    if (race === "legacy") {
      await assert.rejects(operation, /cancellation request was not recorded/i);
      assert.equal(JSON.stringify([indexed, stored]), before);
      assert.equal(output, 0);
      return;
    }
    if (leased && ["index-running", "file-running"].includes(race)) {
      await assert.rejects(operation, /lease job records disagree/i);
      assert.equal(JSON.stringify([indexed, stored]), before);
      assert.equal(output, 0); assert.equal(acquisitions, 0);
      return;
    }
    if (platform !== "win32" && race === "file-missing") {
      await assert.rejects(operation, /pending|verify|generation|epoch changed before interruption/i);
      assert.equal(JSON.stringify([indexed, stored]), before);
      assert.equal(output, 0); assert.equal(acquisitions, 0);
      return;
    }
    const leaseProvesStop = leased && race === "consistent";
    if (race === "consistent" || leaseProvesStop) await operation;
    else await assert.rejects(operation, /pending|verify|generation|epoch changed before interruption/i);
    assert.equal(output, race === "consistent" || leaseProvesStop ? 1 : 0);
    assert.equal(indexed.terminationPending, platform === "linux" && race === "file-missing" ? undefined : !(race === "consistent" || leaseProvesStop));
    if (leaseProvesStop) {
      assert.equal(acquisitions, 1);
      assert.equal(indexed.workerStopProof, `${platform}-lease-released`);
      assert.equal(stored.workerStopProof, `${platform}-lease-released`);
      assert.equal(stored.workerStopLeaseId, lease.id);
    }
    if (race.startsWith("read-") || race.startsWith("commit-")) {
      assert.ok(replacements > 0);
      assert.equal(JSON.stringify([indexed, stored]), replacementSnapshot);
    }
  });
}
for (const race of ["index-running", "file-running", "file-missing", "legacy", "different-createdAt"]) {
  test(`SessionEnd keeps mixed queued originals pending: ${platform}/${race}`, async () => {
    // createdAt 欠落の旧記録は published lease の予約条件を満たせない。
    const leased = platform !== "win32" && ["index-running", "file-running", "different-createdAt"].includes(race);
    const lease = leaseFor(platform);
    const indexed = { id: "job", epoch, sessionId: "session", status: race === "index-running" ? "running" : "queued", pid: null,
      createdAt: race === "legacy" ? undefined : "original", grokPromptState: "not-sent",
      ...(leased ? { claimToken, workerLease: lease } : {}) };
    let stored = race === "file-missing" ? null : { ...indexed, status: race === "file-running" ? "running" : "queued" };
    if (race === "different-createdAt") stored.createdAt = "replacement";
    const originals = JSON.stringify([indexed, stored]);
    let leaseComparisons = 0;
    let leaseVerifications = 0;
    const state = { jobs: [indexed], reviewGateSessions: [] };
    const context = vm.createContext({ process: { platform, stderr: { write() {} } }, performance: { now: () => 0 }, isActiveJob,
      fs: { existsSync: path => path === "state" || stored !== null }, resolveWorkspaceRoot: () => "virtual", resolveStateFile: () => "state", resolveJobFile: () => "job",
      readJobFile: () => stored, writeJobFile: (_root, _id, value) => { stored = value; }, updateState: (_root, callback) => callback(state, { epoch }),
      withStateSnapshot: (_root, callback) => callback(state, { epoch }),
      nowIso: () => "now", appendLogLine() {}, createProcessLookupDiagnostics: () => ({}),
      sameLinuxLease: (left, right) => { leaseComparisons += 1; return sameLinuxLease(left, right); },
      sameDarwinLease: (left, right) => { leaseComparisons += 1; return sameDarwinLease(left, right); },
      verifyPublishedLinuxLeaseRecords: ({ indexed: index, stored: detail, lease: current }) => {
        leaseVerifications += 1;
        verifyLeaseRecords(platform, lease, index, detail, current, indexed.createdAt);
      },
      verifyPublishedDarwinLeaseRecords: ({ indexed: index, stored: detail, lease: current }) => {
        leaseVerifications += 1;
        verifyLeaseRecords(platform, lease, index, detail, current, indexed.createdAt);
      },
      inspectTrackedJobProcess: (pid, key) => inspectTrackedJobProcess(pid, key, { platform }) });
    Object.assign(context, { hasGenerationIdentity, sameTurnEvidence });
    vm.runInContext(hookSource, context);
    if (leased && ["index-running", "file-running"].includes(race)) {
      await assert.rejects(context.cleanupSessionJobs("virtual", "session"), /lease job records disagree/i);
      assert.ok(leaseVerifications > 0);
      assert.equal(JSON.stringify([indexed, stored]), originals);
      return;
    }
    await context.cleanupSessionJobs("virtual", "session");
    assert.equal(state.jobs.length, 1);
    if (race === "different-createdAt" && platform !== "win32") {
      assert.ok(leaseComparisons > 0);
      assert.equal(leaseVerifications, 0);
      assert.equal(JSON.stringify([indexed, stored]), originals);
      return;
    }
    if (platform !== "win32" && ["file-missing", "legacy"].includes(race)) {
      assert.equal(leaseVerifications, 0);
      assert.equal(JSON.stringify([indexed, stored]), originals);
      return;
    }
    assert.equal(indexed.terminationPending, true);
    if (race === "file-missing") {
      assert.equal(stored, null);
      assert.equal(indexed.status, "cancelled");
      assert.equal(indexed.phase, "termination-pending");
      assert.equal(indexed.cancelRequestedAt, "now");
    } else {
      assert.equal(stored.terminationPending, true);
    }
    if (race === "different-createdAt") {
      assert.equal(indexed.createdAt, "original");
      assert.equal(stored.createdAt, "replacement");
    }
  });
}
}
