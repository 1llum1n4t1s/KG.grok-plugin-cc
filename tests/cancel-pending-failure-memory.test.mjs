import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { boundJsonDiagnostic, hasGenerationIdentity, sameDarwinLease, sameLinuxLease, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";

// 失敗条件: pending保存前の失敗を保存済みと誤表示、保存後のproof/確定失敗から生のlockエラー漏れ、
// 原因/causeの消失、別generationを取消済みと誤認、失敗時の成功出力。
// 実state・process・削除を使わず、初回保存と後続境界を独立して故障注入する。
const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const source = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));

for (const platform of ["win32", "linux", "darwin"]) {
  for (const stage of ["initial-update", "worker-proof", "commit-pending", "commit-final", "generation-changed"]) {
    test(`cancel reports only previously persisted pending requests and preserves the state failure: ${platform}/${stage}`, async () => {
      const epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const job = { id: "saved-generation", epoch, createdAt: "2026-10-28T00:00:00.000Z", startedAt: "start",
        processStartKey: "worker-start", pid: 42, status: "running", sessionId: "host", grokSessionId: "agent",
        grokTransport: "broker", grokBrokerGeneration: "broker-generation",
        ...(platform !== "win32" ? { claimToken: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", workerLease: {
          id: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa", slot: 0,
          path: platform === "linux" ? `/virtual/worker-leases-v1/${epoch}/slot-000.lease` : "/virtual/worker-leases/slot-000.lease",
          dev: "1", ino: "2", stateGeneration: epoch, ...(platform === "darwin" ? { directoryDev: "1", directoryIno: "4" } : {}) } } : {}) };
      const indexed = { ...job }; let stored = { ...job }, updates = 0, snapshots = 0, outputs = 0, writes = 0, interrupts = 0;
      const nativeCause = Object.assign(new Error("isolated utility deadline expired"), { code: "ETIMEDOUT" });
      const fault = new Error("POSIX state lock utility failed: /isolated/state", { cause: nativeCause });
      let leaseChecks = 0;
      const verifyLease = ({ indexed: index, stored: detail, lease }) => {
        assert.equal(index.id, job.id); assert.equal(detail.id, job.id);
        assert.equal(index.epoch, epoch); assert.equal(detail.epoch, epoch);
        assert.equal(index.claimToken, job.claimToken); assert.equal(detail.claimToken, job.claimToken);
        assert.equal(index.createdAt, job.createdAt); assert.equal(detail.createdAt, job.createdAt);
        assert.equal(index.status, detail.status);
        assert.equal(index.workerLease, lease); assert.equal(detail.workerLease, lease);
        if (++leaseChecks > 1 && stage === "worker-proof") throw fault;
      };
      const context = vm.createContext({
        process: { platform, env: {}, stderr: { write() {} } },
        parseCommandInput: () => ({ options: { json: true }, positionals: [job.id] }), resolveCommandCwd: () => "isolated",
        resolveCancelableJob: () => ({ workspaceRoot: "isolated", job }), isActiveJob: () => true,
        updateState: (_root, callback, options) => {
          updates++;
          if (stage === "initial-update" || (updates > 1 && ["commit-pending", "commit-final"].includes(stage))) throw fault;
          if (updates > 1 && stage === "generation-changed") {
            indexed.createdAt = stored.createdAt = "replacement-generation";
          }
          const state = { jobs: [indexed] }, scope = { epoch, check() {} };
          return options?.aroundCommit ? options.aroundCommit(state, scope, () => callback(state, scope)) : callback(state, scope);
        },
        withStateSnapshot: (_root, callback) => {
          snapshots++;
          if (stage === "worker-proof" && (platform !== "linux" || snapshots > 1)) throw fault;
          return callback({ jobs: [indexed] }, { epoch });
        },
        readStoredJob: () => stored, writeJobFile: (_root, _id, record) => { stored = record; writes++; },
        nowIso: () => "now", appendLogLine() {},
        sameLinuxLease, sameDarwinLease,
        verifyPublishedLinuxLeaseRecords: verifyLease, verifyPublishedDarwinLeaseRecords: verifyLease,
        darwinLeaseDirectory: () => ({ expectedDirectoryIdentity: { dev: "1", ino: "4" } }),
        interruptGrokTurn: async () => { interrupts++; return { stopConfirmed: stage === "commit-final", notificationSent: true }; },
        setTimeout: () => ({ unref() {} }), createProcessLookupDiagnostics: () => ({}), inspectTrackedJobProcess: () => "absent",
        outputCommandResult: () => { outputs++; }, renderCancelReport: () => "report"
      });
      Object.assign(context, { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence, performance });
      vm.runInContext(source, context);
      let failure;
      try { await context.handleCancel([]); } catch (error) { failure = error; }
      assert.ok(failure); assert.equal(outputs, 0);
      if (stage === "initial-update") {
        assert.equal(failure, fault); assert.doesNotMatch(failure.message, /cancellation remains pending/i);
        assert.equal(stored.status, "running"); assert.equal(writes, 0); assert.equal(interrupts, 0);
      } else {
        assert.match(failure.message, /cancellation remains pending/i);
        assert.match(failure.message, /selected generation|saved generation|original generation/i);
        assert.equal(indexed.terminationPending, true); assert.equal(stored.terminationPending, true); assert.equal(writes, 1);
        if (stage === "generation-changed") {
          assert.match(failure.message, /generation changed/i); assert.equal(stored.createdAt, "replacement-generation");
        } else {
          assert.ok(failure.message.includes(fault.message)); assert.equal(failure.cause, fault);
          assert.equal(failure.cause.cause, nativeCause);
        }
      }
    });
  }
}
