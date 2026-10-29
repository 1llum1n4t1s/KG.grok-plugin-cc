import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { boundJsonDiagnostic, hasGenerationIdentity, sameDarwinLease, sameLinuxLease, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";

const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const source = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));

for (const platform of ["win32", "linux", "darwin"]) {
for (const race of ["ack", "group-proof", "child-only", "timeout", "old-generation", "concurrent", "save-failed"]) {
  test(`direct cancel waits for owned generation evidence: ${platform}/${race}`, async () => {
    const epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const claimToken = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const leaseId = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
    const indexed = { id: "job", epoch, createdAt: "created", status: "running", pid: 42, processStartKey: "worker-start", grokTransport: "direct", grokPromptState: "pending",
      grokDirectGeneration: "generation-a", grokDirectOwnerPid: 42, grokDirectOwnerStartKey: "worker-start",
      ...(platform !== "win32" ? { claimToken, workerLease: { id: leaseId, slot: 0,
        path: platform === "linux" ? `/virtual/worker-leases-v1/${epoch}/slot-000.lease` : "/virtual/worker-leases/slot-000.lease",
        dev: "1", ino: "2", stateGeneration: epoch, ...(platform === "darwin" ? { directoryDev: "1", directoryIno: "4" } : {}) } } : {}) };
    let stored = { ...indexed };
    let locked = false;
    let stopped = 0;
    let waited = 0;
    let output = 0;
    const lock = (fn, options = {}) => { assert.equal(locked, false); locked = true;
      const state = { jobs: [indexed] }; const context = { epoch, check() {} };
      try { return options.aroundCommit ? options.aroundCommit(state, context, () => fn(state, context)) : fn(state, context); } finally { locked = false; } };
    const context = vm.createContext({ process: { platform, env: {}, stderr: { write() {} } },
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "mock",
      resolveCancelableJob: () => ({ workspaceRoot: "mock", job: indexed }), isActiveJob: () => true,
      updateState: (_root, fn, options) => lock(fn, options), withStateSnapshot: (_root, fn) => lock(fn),
      sameLinuxLease, sameDarwinLease,
      verifyPublishedLinuxLeaseRecords: ({ indexed: current, stored: record, lease }) => {
        assert.equal(current.id, "job"); assert.equal(record.id, "job");
        assert.equal(current.epoch, epoch); assert.equal(record.epoch, epoch);
        assert.equal(current.claimToken, claimToken); assert.equal(record.claimToken, claimToken);
        assert.equal(current.createdAt, "created"); assert.equal(record.createdAt, "created");
        assert.equal(current.status, record.status);
        assert.ok(sameLinuxLease(current.workerLease, lease)); assert.ok(sameLinuxLease(record.workerLease, lease));
      },
      withAvailableLinuxLease: (lease, _context, callback) => {
        assert.equal(lease.id, leaseId); return { status: "available", value: callback() };
      },
      verifyPublishedDarwinLeaseRecords: ({ indexed: current, stored: record, lease }) => {
        assert.equal(current.id, "job"); assert.equal(record.id, "job");
        assert.equal(current.epoch, epoch); assert.equal(record.epoch, epoch);
        assert.equal(current.claimToken, claimToken); assert.equal(record.claimToken, claimToken);
        assert.equal(current.createdAt, "created"); assert.equal(record.createdAt, "created");
        assert.equal(current.status, record.status);
        assert.ok(sameDarwinLease(current.workerLease, lease)); assert.ok(sameDarwinLease(record.workerLease, lease));
      },
      darwinLeaseDirectory: () => ({ expectedDirectoryIdentity: { dev: "1", ino: "4" } }),
      withAvailableDarwinLease: (lease, _context, callback) => {
        assert.equal(lease.id, leaseId); return { status: "available", value: callback() };
      },
      readStoredJob: () => { assert.equal(locked, true); return stored; },
      writeJobFile: (_root, _id, value) => {
        assert.equal(locked, true);
        if (race === "save-failed" && value.phase === "cancelled") throw Error("Cancellation save failed");
        stored = value;
      },
      waitForDirectAgentStop: async () => {
        waited += 1;
        assert.equal(locked, false);
        assert.equal(stored.terminationPending, true);
        if (race === "timeout") return false;
        for (const record of [indexed, stored]) {
          record.grokDirectStopGeneration = "generation-a";
          record.grokDirectStopKind = race === "group-proof" ? "posix-group-empty" : race === "child-only" ? "posix-child-closed" :
            platform === "win32" ? "job-empty" : "posix-group-empty";
          record.newerField = "retained";
          if (race === "old-generation") record.grokDirectGeneration = "generation-b";
        }
        return true;
      },
      interruptGrokTurn: async () => { throw Error("direct cancellation must not use a broker control connection"); },
      inspectTrackedJobProcess: () => "match", createProcessLookupDiagnostics: () => ({}),
      stopTrackedJobProcess: (_pid, _key, options) => { assert.equal(locked, platform === "win32"); assert.equal(options.tree, false); stopped += 1; },
      nowIso: () => "now", appendLogLine() {}, setTimeout: () => ({ unref() {} }),
      upsertJob: () => { throw Error("Cancellation finalization must use the existing transaction"); },
      outputCommandResult: () => { output += 1; }, renderCancelReport: () => "report"
    });
    Object.assign(context, { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence, performance });
    vm.runInContext(source, context);
    const run = context.handleCancel([]);
    if (["ack", "group-proof", "concurrent"].includes(race)) {
      await run;
      assert.equal(stored.terminationPending, false);
      assert.equal(stored.newerField, "retained");
      assert.equal(stored.grokDirectStopGeneration, "generation-a");
      if (platform !== "win32") {
        assert.equal(stored.workerStopProof, `${platform}-lease-released`);
        assert.equal(stored.workerStopLeaseId, leaseId);
      }
      assert.equal(output, 1);
    } else {
      await assert.rejects(run, /pending|save failed|generation/i);
      assert.equal(indexed.terminationPending, true);
      assert.equal(output, 0);
    }
    assert.equal(waited, 1);
    assert.equal(stopped, platform !== "win32" || ["timeout", "old-generation", "child-only"].includes(race) ? 0 : 1);
  });
}
}
