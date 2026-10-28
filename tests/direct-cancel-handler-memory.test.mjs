import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const source = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));

for (const platform of ["win32", "linux", "darwin"]) {
for (const race of ["ack", "group-proof", "child-only", "timeout", "old-generation", "concurrent", "save-failed"]) {
  test(`direct cancel waits for owned generation evidence: ${platform}/${race}`, async () => {
    const indexed = { id: "job", epoch: "current-epoch", createdAt: "created", status: "running", pid: 42, processStartKey: "worker-start", grokTransport: "direct", grokPromptState: "pending",
      grokDirectGeneration: "generation-a", grokDirectOwnerPid: 42, grokDirectOwnerStartKey: "worker-start",
      ...(platform === "linux" ? { claimToken: "claim", workerLease: { id: "lease" } } : {}) };
    let stored = { ...indexed };
    let locked = false;
    let stopped = 0;
    let waited = 0;
    let output = 0;
    const lock = (fn, options = {}) => { assert.equal(locked, false); locked = true;
      const state = { jobs: [indexed] }; const context = { epoch: "current-epoch", check() {} };
      try { const result = fn(state, context); options.aroundCommit?.(state, context, () => {}); return result; } finally { locked = false; } };
    const context = vm.createContext({ process: { platform, env: {}, stderr: { write() {} } },
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "mock",
      resolveCancelableJob: () => ({ workspaceRoot: "mock", job: indexed }), isActiveJob: () => true,
      updateState: (_root, fn, options) => lock(fn, options), withStateSnapshot: (_root, fn) => lock(fn),
      sameLinuxLease: (left, right) => left.id === right.id,
      verifyPublishedLinuxLeaseRecords: ({ indexed: current, stored: record, lease }) => {
        assert.equal(current.workerLease.id, lease.id); assert.equal(record.workerLease.id, lease.id);
      },
      withAvailableLinuxLease: (lease, _context, callback) => {
        assert.equal(lease.id, "lease"); callback(); return { status: "available" };
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
          record.grokDirectStopKind = race === "group-proof" ? "posix-group-empty" : race === "child-only" ? "posix-child-closed" : "job-empty";
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
    vm.runInContext(source, context);
    const run = context.handleCancel([]);
    if (["ack", "group-proof", "concurrent"].includes(race)) {
      await run;
      assert.equal(stored.terminationPending, false);
      assert.equal(stored.newerField, "retained");
      assert.equal(stored.grokDirectStopGeneration, "generation-a");
      if (platform === "linux") {
        assert.equal(stored.workerStopProof, "linux-lease-released");
        assert.equal(stored.workerStopLeaseId, "lease");
      }
      assert.equal(output, 1);
    } else {
      await assert.rejects(run, /pending|save failed|generation/i);
      assert.equal(indexed.terminationPending, true);
      assert.equal(output, 0);
    }
    assert.equal(waited, 1);
    assert.equal(stopped, platform === "linux" || ["timeout", "old-generation", "child-only"].includes(race) ? 0 : 1);
  });
}
}
