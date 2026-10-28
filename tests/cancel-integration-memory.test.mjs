import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
function functionSource(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).replace(/^export /, ""); }
const withGrokSource = functionSource(grok, "const brokerRequests = new WeakMap();", "const DEFAULT_CONTINUE_PROMPT") +
  functionSource(grok, "async function withGrok", "async function withDirectGrok");
const interruptSource = functionSource(grok, "export async function interruptGrokTurn", "function grokMissingMessage");
const cancelSource = functionSource(companion, "async function handleCancel", "async function main");
const tracked = fs.readFileSync(new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url), "utf8");
const jobControl = fs.readFileSync(new URL("../plugins/grok/scripts/lib/job-control.mjs", import.meta.url), "utf8");

for (const state of [undefined, "pending", "not-sent", "terminal", "concurrent-cancel"]) {
for (const platform of ["win32", "linux"]) {
for (const identity of ["absent", "mismatch", "match", "unavailable", "missing-key", "invalid-key", "malformed-snapshot", "changed-key"]) {
  test(`orphan reconciliation retains unknown turns under the state lock: ${state}/${platform}/${identity}`, () => {
    const validKey = platform === "linux" ? "12345678-abcd-1234-abcd-123456789abc:12345" : "win32-filetime:132537600000000000";
    let record = { id: "job", epoch: "current-epoch", status: "running", pid: 123, processStartKey: identity === "missing-key" ? null : identity === "invalid-key" ? "old-key" : validKey, grokPromptState: state };
    let holdingLock = false;
    const context = vm.createContext({ Date, process: { platform }, STALE_QUEUED_JOB_MS: 60_000, listJobs: () => [{ ...record }],
      resolveStateDir: () => "mock", withStateLockMigrationScope: (_dir, fn) => fn(Object.assign(() => {}, { epoch: "current-epoch" })),
      getProcessSnapshot: () => ({ startKey: "malformed", commandLine: "fixture" }),
      inspectTrackedJobProcess: (pid, key, options) => {
        assert.ok(!["missing-key", "invalid-key"].includes(identity));
        if (identity === "malformed-snapshot") { assert.equal(options.getProcessSnapshotImpl(pid, {}), null); return "unavailable"; }
        return identity === "changed-key" ? "mismatch" : identity;
      },
      readStoredJob: () => record,
      updateState: (_root, fn) => {
        if (state === "concurrent-cancel") record = { ...record, status: "cancelled", terminationPending: true };
        else if (identity === "changed-key") record = { ...record, processStartKey: "replacement" };
        holdingLock = true;
        try { fn({ jobs: [record] }, { epoch: "current-epoch" }); } finally { holdingLock = false; }
      },
      writeJobFile: (_root, _id, value) => { assert.equal(holdingLock, true); record = value; },
      upsertJob: () => { throw new Error("No nested mutation"); } });
    vm.runInContext(functionSource(jobControl, "function validProcessStartKey", "/** @param"), context);
    context.reconcileOrphanedJobs("mock");
    if (platform === "linux") {
      // 旧 lease 不在の PID 消失は worker 停止証拠にならない。
      assert.equal(record.status, "running");
      assert.equal(record.terminationPending, undefined);
    } else if (["absent", "mismatch"].includes(identity) && state !== "concurrent-cancel") {
      assert.equal(record.status, "failed");
      assert.equal(record.terminationPending, !["not-sent", "terminal"].includes(state));
    } else if (["absent", "mismatch", "changed-key"].includes(identity) && state === "concurrent-cancel") {
      assert.equal(record.status, "cancelled");
    } else assert.equal(record.status, "running");
  });
}
}
}

for (const thrown of [false, true]) {
  test(`tracked job keeps transport-unknown execution cancellable (runner throw: ${thrown})`, async () => {
    let record;
    const context = vm.createContext({ process: { pid: 123 }, nowIso: () => "now", createProcessLookupDiagnostics: () => ({}),
      getProcessSnapshot: () => ({ startKey: "key" }), appendLogBlock() {},
      readStoredJobOrNull: () => record,
      commitNonTerminalTransition: (_root, _id, build) => { record = build(record ?? {}); return { accepted: true, record }; } });
    vm.runInContext(tracked.slice(tracked.indexOf("export async function runTrackedJob")).replace(/^export /, ""), context);
    const runner = async () => {
      record.grokPromptState = "pending";
      if (thrown) throw new Error("Connection lost");
      return { exitStatus: "failed", turnStopUnconfirmed: true, grokSessionId: "session" };
    };
    try { await context.runTrackedJob({ id: "job", workspaceRoot: "mock" }, runner); } catch (error) { if (!thrown) throw error; }
    assert.equal(record.terminationPending, true);
    assert.equal(record.phase, "termination-pending");
  });
}

for (const kind of ["transport", "broker-agent-transport", "rpc-terminal", "guard-rejection"]) {
  test(`runPrompt distinguishes ${kind} from a confirmed terminal`, async () => {
    const error = new Error("Failed");
    if (kind !== "transport") error.rpcResponseReceived = true;
    if (kind === "broker-agent-transport") error.data = { data: { turnStopConfirmed: false } };
    if (kind === "rpc-terminal") error.data = { data: { turnStopConfirmed: true } };
    const evidence = new WeakMap();
    const context = vm.createContext({ Error, createTurnCollector: () => ({ state: {}, handle() {}, finalize() {} }),
      getAcpPromptFailureEvidence: (failure, client) => evidence.get(failure)?.client === client ? evidence.get(failure).value : null });
    vm.runInContext(functionSource(grok, "async function runPrompt", "function buildResultStatus"), context);
    const client = { transport: "broker", nextId: 1, setNotificationHandler() {}, request: async (method) => {
      const requestId = client.nextId++;
      if (kind !== "transport") evidence.set(error, { client, value: Object.freeze({ method, requestId,
        terminal: kind === "rpc-terminal" ? "confirmed" : "unconfirmed" }) });
      throw error;
    } };
    const result = await context.runPrompt(client, "session", "prompt", kind === "guard-rejection" ? { enqueuePrompt: () => { throw error; } } : {});
    assert.equal(result.turnStopUnconfirmed, ["transport", "broker-agent-transport"].includes(kind));
  });
}

// 失敗条件を先に固定: ACKだけの取消、世代変更、旧job、direct/unknown、
// worker停止時の共有broker巻込み、actual transport保存前のprompt送信。
for (const executionState of ["accepted", "unknown", "terminal", "never-accepted"]) {
  test(`interrupt uses actual ledger evidence: ${executionState}`, async () => {
    let params;
    const client = { transport: "broker", initializeResult: { _meta: { grokScopedCancellation: true, grokExecutionLedger: true, grokBrokerGeneration: "generation" } },
      request: async (_method, value) => { params = value; return { executionState, generation: "generation", reservationAccepted: true, notificationSent: true }; }, close: async () => {} };
    const context = vm.createContext({ GrokAcpClient: { connect: async () => client }, process: { env: {} }, Date, AbortSignal });
    vm.runInContext(interruptSource, context);
    const result = await context.interruptGrokTurn("mock", { sessionId: "session", executionId: "job", transport: "broker", brokerGeneration: "generation" });
    assert.equal(params.generation, "generation");
    assert.equal(result.stopConfirmed, ["terminal", "never-accepted"].includes(executionState));
  });
}

for (const platform of ["win32", "linux", "darwin"]) {
for (const [confirmed, notSent] of [[false, false], [true, false], [false, true]]) {
  test(`cancel stops only the worker and retains pending without turn evidence (${platform}, ${confirmed}, not sent ${notSent})`, async () => {
    const epoch = "12345678-abcd-1234-abcd-123456789abc";
    const workerLease = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", slot: 0,
      path: `/mock-state/worker-leases-v1/${epoch}/slot-000.lease`, dev: "1", ino: "2", stateGeneration: epoch };
    const job = { id: "job", createdAt: "2026-01-01T00:00:00.000Z", epoch, status: "running", pid: 42,
      processStartKey: platform === "linux" ? `${epoch}:12345` : "start", grokSessionId: "session", grokTransport: "broker", grokBrokerGeneration: "generation",
      ...(platform === "linux" ? { claimToken: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", workerLease } : {}),
      ...(notSent ? { grokPromptState: "not-sent" } : {}) };
    const indexed = { ...job };
    let stored = { ...job };
    let stopOptions;
    let leaseChecks = 0;
    let leaseAcquisitions = 0;
    let holdingLock = false;
    const context = vm.createContext({
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "mock", resolveCancelableJob: () => ({ workspaceRoot: "mock", job }),
      process: { platform, env: {}, stderr: { write() {} } },
      updateState: (_root, fn, options) => { const state = { jobs: [indexed] }, scope = { epoch, check() {} };
        const commit = () => fn(state, scope); return options?.aroundCommit ? options.aroundCommit(state, scope, commit) : commit(); }, isActiveJob: () => true,
      withStateSnapshot: (_root, fn) => { holdingLock = true; try { return fn({ jobs: [indexed] }, { epoch, check() {} }); } finally { holdingLock = false; } },
      readStoredJob: () => stored, nowIso: () => "now", writeJobFile: (_root, _id, value) => { stored = value; }, appendLogLine() {},
      sameLinuxLease: (left, right) => Boolean(left && right && ["id", "slot", "path", "dev", "ino", "stateGeneration"].every(key => left[key] === right[key])),
      verifyPublishedLinuxLeaseRecords: ({ context: scope, indexed: index, stored: detail, lease }) => {
        assert.equal(scope.epoch, epoch); assert.equal(index.id, job.id); assert.equal(detail.id, job.id);
        assert.equal(index.claimToken, job.claimToken); assert.equal(detail.claimToken, job.claimToken);
        assert.equal(index.epoch, epoch); assert.equal(detail.epoch, epoch); assert.equal(index.status, detail.status);
        assert.equal(index.createdAt, job.createdAt); assert.equal(detail.createdAt, job.createdAt);
        assert.equal(index.workerLease, lease); assert.equal(detail.workerLease, lease); leaseChecks += 1;
      },
      withAvailableLinuxLease: (lease, scope, callback) => { assert.equal(lease, workerLease); assert.equal(scope.epoch, epoch);
        leaseAcquisitions += 1; return { status: "available", value: callback() }; },
      interruptGrokTurn: async () => ({ stopConfirmed: confirmed, notificationSent: true }),
      setTimeout: () => ({ unref() {} }), createProcessLookupDiagnostics: () => ({}), inspectTrackedJobProcess: () => {
        assert.notEqual(platform, "linux"); return "match"; },
      stopTrackedJobProcess: (_pid, _key, options) => { assert.equal(holdingLock, platform === "win32"); stopOptions = options; }, upsertJob: (_root, patch) => Object.assign(indexed, patch),
      outputCommandResult() {}, renderCancelReport: () => "report"
    });
    vm.runInContext(cancelSource, context);
    if (confirmed || notSent) await context.handleCancel([]);
    else await assert.rejects(context.handleCancel([]), /turn stop is unconfirmed/);
    if (platform === "linux") {
      assert.equal(stopOptions, undefined);
      assert.equal(leaseChecks, 2);
      assert.equal(leaseAcquisitions, 1);
      assert.equal(stored.workerStopProof, "linux-lease-released");
      assert.equal(stored.workerStopLeaseId, workerLease.id);
    } else assert.equal(stopOptions.tree, false);
    assert.equal(stored.terminationPending, !(confirmed || notSent));
    assert.equal(indexed.terminationPending, !(confirmed || notSent));
  });
}
}

test("enqueue persists actual transport under the cancellation lock before sending", () => {
  let stored = { id: "job", status: "running" };
  const indexed = { ...stored };
  const context = vm.createContext({ process: { platform: "win32" }, readStoredJob: () => stored,
    updateState: (_root, fn) => fn({ jobs: [indexed] }), withStateSnapshot: (_root, fn) => fn({ jobs: [indexed] }),
    writeJobFile: (_root, _id, value) => { stored = value; } });
  vm.runInContext(functionSource(companion, "function createPromptEnqueuer", "async function handleCancel"), context);
  context.createPromptEnqueuer("mock", "job")(() => {
    assert.equal(stored.grokTransport, "broker");
    assert.equal(stored.grokBrokerGeneration, "generation");
    return "pending";
  }, { sessionId: "session", transport: "broker", brokerGeneration: "generation" });
  assert.equal(indexed.grokBrokerGeneration, "generation");
});

for (const boundary of ["save-failure", "cancel-after-save", "enqueue-throw"]) {
  test(`enqueue preserves durable metadata and respects ${boundary}`, () => {
    const indexed = { id: "job", status: "running" };
    let stored = { ...indexed };
    let saved = false;
    let sends = 0;
    const context = vm.createContext({ process: { platform: "win32" }, readStoredJob: () => stored,
      writeJobFile: (_root, _id, value) => { stored = value; },
      updateState: (_root, fn) => {
        fn({ jobs: [indexed] });
        if (boundary === "save-failure") throw new Error("Index save failed");
        saved = true;
        if (boundary === "cancel-after-save") {
          indexed.terminationPending = true;
          stored = { ...stored, terminationPending: true };
        }
      },
      withStateSnapshot: (_root, fn) => fn({ jobs: [indexed] }) });
    vm.runInContext(functionSource(companion, "function createPromptEnqueuer", "async function handleCancel"), context);
    assert.throws(() => context.createPromptEnqueuer("mock", "job")(() => {
      sends += 1;
      assert.equal(saved, true, "index save must finish before enqueue");
      assert.equal(stored.grokBrokerGeneration, "generation");
      throw new Error("Enqueue failed");
    }, { sessionId: "session", transport: "broker", brokerGeneration: "generation" }));
    assert.equal(sends, boundary === "enqueue-throw" ? 1 : 0);
    assert.equal(stored.grokBrokerGeneration, "generation");
    if (boundary === "cancel-after-save") assert.equal(stored.terminationPending, true);
  });
}

for (const identity of [{}, { transport: "direct", brokerGeneration: "generation" }, { transport: "broker" }]) {
  test(`legacy or direct execution cannot claim broker cancellation: ${JSON.stringify(identity)}`, async () => {
    const context = vm.createContext({ process: { env: {} }, GrokAcpClient: { connect: () => { throw new Error("Must not connect"); } } });
    vm.runInContext(interruptSource, context);
    const result = await context.interruptGrokTurn("mock", { sessionId: "session", executionId: "job", ...identity });
    assert.equal(result.stopConfirmed, false);
    assert.equal(result.attempted, false);
  });
}

test("changed broker generation is unknown and receives no cancellation", async () => {
  const context = vm.createContext({ process: { env: {} }, Date,
    GrokAcpClient: { connect: async () => ({ transport: "broker", initializeResult: { _meta: { grokExecutionLedger: true, grokBrokerGeneration: "new-generation" } },
      request: () => { throw new Error("Must not cancel a new broker"); }, close: async () => {} }) } });
  vm.runInContext(interruptSource, context);
  const result = await context.interruptGrokTurn("mock", { sessionId: "session", executionId: "job", transport: "broker", brokerGeneration: "old-generation" });
  assert.notEqual(result.stopConfirmed, true);
  assert.equal(result.attempted, false);
});

for (const transport of ["direct", "broker"]) {
  test(`runPrompt passes actual ${transport} metadata to the enqueue guard`, async () => {
    const evidence = new WeakMap();
    const client = { transport, nextId: 1, initializeResult: { _meta: { grokBrokerGeneration: "generation" } }, setNotificationHandler() {},
      request: async (method) => {
        const requestId = client.nextId++;
        const response = { stopReason: "end_turn" };
        evidence.set(response, { client, value: Object.freeze({ method, requestId, stopReason: response.stopReason }) });
        return response;
      } };
    const context = vm.createContext({ createTurnCollector: () => ({ state: {}, handle() {}, finalize() {} }),
      getAcpPromptSuccessEvidence: (response, actualClient) => evidence.get(response)?.client === actualClient ? evidence.get(response).value : null });
    vm.runInContext(functionSource(grok, "async function runPrompt", "function buildResultStatus"), context);
    let metadata;
    const result = await context.runPrompt(client, "session", "prompt", { executionId: "job", enqueuePrompt: (enqueue, execution) => { metadata = execution; return enqueue(); } });
    assert.equal(result.error, null);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(metadata.transport, transport);
    assert.equal(metadata.brokerGeneration, transport === "broker" ? "generation" : null);
  });
}

for (const failure of ["connect-busy", "old-broker", "prompt-busy", "capacity", "implicit-direct", "explicit-direct"]) {
  test(`resume never bypasses broker ownership after ${failure}`, async () => {
    const connects = [];
    let handled = 0;
    const busy = Object.assign(new Error("Broker busy"), { rpcCode: -32001 });
    const capacity = Object.assign(new Error("Capacity"), { rpcCode: -32003, data: { data: { source: "grok-broker", promptForwarded: false } } });
    const evidence = new WeakMap();
    const context = vm.createContext({ process: { env: {} },
      getBrokerUnsentRejection: (error, client) => evidence.get(error)?.client === client ? evidence.get(error).value : null,
      GrokAcpClient: { connect: async (_cwd, options) => {
        connects.push(options);
        if (failure === "connect-busy") throw busy;
        const client = { transport: options.disableBroker || failure === "implicit-direct" ? "direct" : "broker", nextId: 1, close: async () => {},
          initializeResult: { _meta: failure === "old-broker" ? {} : { grokScopedCancellation: true, grokExecutionLedger: true, grokBrokerGeneration: "generation" } },
          request: async (method) => {
            const requestId = client.nextId++;
            const error = failure === "capacity" ? capacity : busy;
            evidence.set(error, { client, value: { method, requestId, reason: failure === "capacity" ? "capacity" : "busy" } });
            throw error;
          } };
        return client;
      } } });
    vm.runInContext(withGrokSource, context);
    await assert.rejects(context.withGrok("mock", async (client) => {
      handled += 1;
      if (failure === "prompt-busy" || failure === "capacity") return client.request("session/prompt");
    }, { resumeSessionId: "session", requireScopedCancellation: true, allowCapacityFallback: true, disableBroker: failure === "explicit-direct" }));
    assert.ok(connects.length <= 1);
    assert.equal(handled, ["prompt-busy", "capacity"].includes(failure) ? 1 : 0);
    if (connects.length) {
      assert.equal(connects[0].brokerOnly, true);
      assert.equal(connects[0].reuseExistingBroker, true);
    }
  });
}

test("a fresh session does not retry an unverified busy connection as direct", async () => {
  let connects = 0;
  const context = vm.createContext({ process: { env: {} }, BROKER_BUSY_RPC_CODE: -32001, BROKER_CAPACITY_RPC_CODE: -32003,
    GrokAcpClient: { connect: async (_cwd, options) => {
      connects += 1;
      if (!options.disableBroker) throw Object.assign(new Error("Busy"), { rpcCode: -32001 });
      return { transport: "direct", close: async () => {} };
    } } });
  vm.runInContext("function getBrokerUnsentRejection() { return null; }\n" + withGrokSource, context);
  await assert.rejects(context.withGrok("mock", async (client) => client.transport), /busy/i);
  assert.equal(connects, 1);
});
