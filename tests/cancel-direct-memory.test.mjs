import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { inspectTrackedJobProcess, stopTrackedJobProcess, waitForTrackedJobExit } from "../plugins/grok/scripts/lib/process.mjs";

// 実agentの起動・停止やファイル削除を行わず、起動契約の境界だけ確認する。
const acp = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
function sourceFunction(source, start, end) {
  const offset = source.indexOf(start);
  assert.notEqual(offset, -1, `Missing ${start}`);
  return source.slice(offset, source.indexOf(end, offset));
}

test("withdrawn native-executable route preserves the previous platform shell contract", () => {
  assert.equal(acp.includes('const useShell = process.platform === "win32";'), true);
  assert.equal(acp.includes("canSpawnWithoutShell"), false);
});

const startKey = "win32-filetime:134000000000000001";
for (const kind of ["agent", "worker"]) {
  test(`same process with a changed ${kind} command is not an exit confirmation`, () => {
    const options = { platform: "win32", sleepImpl() {},
      ...(kind === "agent" ? { expectedCommandLine: "C:\\grok.exe agent stdio" } : {}),
      getProcessSnapshotImpl: () => ({ startKey, commandLine: "unrelated.exe agent stdio" }) };
    assert.equal(inspectTrackedJobProcess(123, startKey, options), "unavailable");
    assert.equal(waitForTrackedJobExit(123, startKey, options), false);
    assert.throws(() => stopTrackedJobProcess(123, startKey, { ...options, terminateImpl() {} }), /exit could not be confirmed/);
  });
}

test("a reused PID has a different start identity and confirms the original process exited", () => {
  const options = { platform: "win32", sleepImpl() {}, expectedCommandLine: "grok.exe agent stdio",
    getProcessSnapshotImpl: () => ({ startKey: "win32-filetime:134000000000000002", commandLine: "unrelated.exe" }) };
  assert.equal(inspectTrackedJobProcess(123, startKey, options), "mismatch");
  assert.equal(waitForTrackedJobExit(123, startKey, options), true);
});

const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
const withGrokSource = sourceFunction(grok, "const brokerRequests = new WeakMap();", "const DEFAULT_CONTINUE_PROMPT") +
  sourceFunction(grok, "async function withGrok", "async function withDirectGrok");
for (const race of ["after-preparation", "before-preparation", "save-failure"]) {
  test(`connection preparation preserves cancellation safety: ${race}`, async () => {
    let record = { id: "job", status: "running", grokPromptState: "not-sent" };
    let connects = 0;
    const context = vm.createContext({ process: { env: {} },
      readStoredJob: () => record,
      writeJobFile: (_root, _id, value) => { record = value; },
      updateState: (_root, fn) => { fn({ jobs: [record] }); if (race === "save-failure") throw Error("Save failed"); },
      GrokAcpClient: { connect: async () => {
        connects += 1;
        assert.equal(record.grokPromptState, "starting");
        record = { ...record, status: "cancelled", terminationPending: true };
        return { transport: "direct", close: async () => {} };
      } } });
    vm.runInContext(sourceFunction(companion, "function createPromptEnqueuer", "async function handleCancel"), context);
    vm.runInContext("function getBrokerUnsentRejection() { return null; }\n" + withGrokSource, context);
    const enqueuer = context.createPromptEnqueuer("mock", "job");
    assert.equal(typeof enqueuer.prepareConnection, "function");
    if (race === "before-preparation") record.status = "cancelled";
    const run = context.withGrok("mock", async () => {}, { prepareConnection: enqueuer.prepareConnection });
    if (race === "after-preparation") {
      await run;
      assert.equal(connects, 1);
      assert.equal(record.grokPromptState, "starting");
      assert.equal(record.terminationPending, true);
    } else {
      await assert.rejects(run);
      assert.equal(connects, 0);
    }
  });
}

test("diagnostic direct snapshots never authorize a process stop", () => {
  assert.equal(/stopDirectGrokAgent/.test(companion), false);
  assert.equal(/export function stopDirectGrokAgent/.test(grok), false);
});

for (const exit of ["alive", "signal-before", "signal-during", "code-before", "code-during"]) {
  test(`withdrawn snapshot capture never collects process command lines: ${exit}`, async () => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 123, exitCode: exit === "code-before" ? 0 : null,
      signalCode: exit === "signal-before" ? "SIGTERM" : null,
      stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    let reads = 0;
    const context = vm.createContext({ process: { platform: "linux", env: {} },
      AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.agentProcessIdentity = null; } async performInitialize() {} },
      spawn: () => child, withTimeout: (promise) => promise, DIRECT_HANDSHAKE_TIMEOUT_MS: 10,
      getProcessSnapshot: () => {
        reads += 1;
        if (exit === "signal-during") child.signalCode = "SIGTERM";
        if (exit === "code-during") child.exitCode = 0;
        return { startKey, commandLine: "C:\\grok.exe agent stdio" };
      } });
    vm.runInContext(sourceFunction(acp, "class SpawnedAcpClient", "class BrokerAcpClient") + ";globalThis.Direct = SpawnedAcpClient;", context);
    const client = new context.Direct("mock", { grokBin: "grok" });
    await client.initialize();
    assert.equal(client.agentProcessIdentity, null);
    assert.equal(reads, 0);
  });
}

const tracked = fs.readFileSync(new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url), "utf8");
for (const outcome of ["connection-failure", "cancel-while-connecting", "prompt-after-connect"]) {
  test(`broker-only resume separates old session uncertainty from this job: ${outcome}`, async () => {
    let record = { id: "job", status: "running", grokPromptState: "not-sent" };
    let sends = 0;
    let connects = 0;
    const context = vm.createContext({ process: { env: {} },
      readStoredJob: () => record, writeJobFile: (_root, _id, value) => { record = value; },
      updateState: (_root, fn) => fn({ jobs: [record] }), withStateSnapshot: (_root, fn) => fn({ jobs: [record] }),
      GrokAcpClient: { connect: async (_cwd, options) => {
        connects += 1;
        assert.equal(options.brokerOnly, true);
        assert.equal(options.reuseExistingBroker, true);
        assert.equal(record.grokPromptState, "not-sent");
        if (outcome === "connection-failure") throw Error("No existing broker");
        if (outcome === "cancel-while-connecting") record.status = "cancelled";
        return { transport: "broker", close: async () => {} };
      } } });
    vm.runInContext(sourceFunction(companion, "function createPromptEnqueuer", "async function handleCancel"), context);
    vm.runInContext("function getBrokerUnsentRejection() { return null; }\n" + withGrokSource, context);
    const enqueuer = context.createPromptEnqueuer("mock", "job");
    const run = context.withGrok("mock", () => enqueuer(() => { sends += 1; },
      { sessionId: "old-session", transport: "broker", brokerGeneration: "generation" }),
    { resumeSessionId: "old-session", prepareConnection: enqueuer.prepareConnection });
    if (outcome === "prompt-after-connect") await run;
    else await assert.rejects(run);
    assert.equal(connects, 1);
    assert.equal(sends, outcome === "prompt-after-connect" ? 1 : 0);
    assert.equal(record.grokPromptState, sends ? "pending" : "not-sent");
  });
}

for (const state of ["starting", "pending", "not-sent", "terminal"]) {
  test(`runner throw preserves uncertain agent startup state: ${state}`, async () => {
    let record;
    const context = vm.createContext({ process: { pid: 123 }, nowIso: () => "now", createProcessLookupDiagnostics: () => ({}),
      getProcessSnapshot: () => ({ startKey: "key" }), appendLogBlock() {}, readStoredJobOrNull: () => record,
      commitNonTerminalTransition: (_root, _id, build) => { record = build(record ?? {}); return { accepted: true, record }; } });
    vm.runInContext(tracked.slice(tracked.indexOf("export async function runTrackedJob")).replace(/^export /, ""), context);
    await assert.rejects(context.runTrackedJob({ id: "job", workspaceRoot: "mock" }, async () => {
      record.grokPromptState = state;
      throw new Error("Connection interrupted");
    }));
    const uncertain = ["starting", "pending"].includes(state);
    assert.equal(record.terminationPending, uncertain);
    assert.equal(record.phase, uncertain ? "termination-pending" : "failed");
  });
}

test("direct prompt guard failure retains uncertainty despite no prompt admission", async () => {
  const context = vm.createContext({ createTurnCollector: () => ({ state: {}, handle() {}, finalize() {} }) });
  vm.runInContext(sourceFunction(grok, "async function runPrompt", "function buildResultStatus"), context);
  const result = await context.runPrompt({ transport: "direct", setNotificationHandler() {},
    request: () => { throw Error("No prompt may be sent"); } }, "session", "prompt",
  { enqueuePrompt: () => { throw Error("State persistence failed"); } });
  assert.equal(result.turnStopUnconfirmed, true);
});

test("normal runner failure cannot clear uncertain startup state", async () => {
  let record;
  const context = vm.createContext({ process: { pid: 123 }, nowIso: () => "now", createProcessLookupDiagnostics: () => ({}),
    getProcessSnapshot: () => ({ startKey: "key" }), appendLogBlock() {}, readStoredJobOrNull: () => record,
    commitNonTerminalTransition: (_root, _id, build) => { record = build(record ?? {}); return { accepted: true, record }; } });
  vm.runInContext(tracked.slice(tracked.indexOf("export async function runTrackedJob")).replace(/^export /, ""), context);
  await context.runTrackedJob({ id: "job", workspaceRoot: "mock" }, async () => {
    record.grokPromptState = "starting";
    return { exitStatus: "failed", turnStopUnconfirmed: false };
  });
  assert.equal(record.terminationPending, true);
  assert.equal(record.phase, "termination-pending");
});

for (const reason of ["connect-busy", "old-broker", "prompt-busy", "capacity"]) for (const cancel of [false, true]) {
  test(`direct fallback clears broker evidence and rechecks cancel: ${reason}, cancel ${cancel}`, async () => {
    let record = { id: "job", status: "running", grokPromptState: "not-sent" };
    let connections = 0;
    const busy = Object.assign(new Error("Busy"), { rpcCode: -32001 });
    const capacity = Object.assign(new Error("Capacity"), { rpcCode: -32003, data: { data: { source: "grok-broker", promptForwarded: false } } });
    const evidence = new WeakMap();
    const context = vm.createContext({ process: { env: {} },
      getBrokerUnsentRejection: (error, client) => evidence.get(error)?.client === client ? evidence.get(error).value : null,
      readStoredJob: () => record, writeJobFile: (_root, _id, value) => { record = value; },
      updateState: (_root, fn) => fn({ jobs: [record] }),
      GrokAcpClient: { connect: async (_cwd, options) => {
        connections += 1;
        if (options.disableBroker) {
          assert.equal(record.status, "running");
          assert.equal(record.grokPromptState, "starting");
          assert.equal(record.grokSessionId, null);
          assert.equal(record.grokTransport, null);
          assert.equal(record.grokBrokerGeneration, null);
          return { transport: "direct", close: async () => {} };
        }
        Object.assign(record, { grokSessionId: "old-session", grokTransport: "broker", grokBrokerGeneration: "generation", grokPromptState: "pending" });
        if (reason === "connect-busy") { if (cancel) record.status = "cancelled"; throw busy; }
        const client = { transport: "broker", nextId: 1, initializeResult: { _meta: reason === "old-broker" ? {} : {
          grokScopedCancellation: true, grokExecutionLedger: true, grokBrokerGeneration: "generation" } },
          request: async (method) => {
            const requestId = client.nextId++;
            const error = reason === "capacity" ? capacity : busy;
            evidence.set(error, { client, value: { method, requestId, reason: reason === "capacity" ? "capacity" : "busy" } });
            throw error;
          },
          close: async () => { if (cancel) record.status = "cancelled"; } };
        return client;
      } } });
    vm.runInContext(sourceFunction(companion, "function createPromptEnqueuer", "async function handleCancel"), context);
    vm.runInContext(withGrokSource, context);
    const enqueuer = context.createPromptEnqueuer("mock", "job");
    const run = context.withGrok("mock", async (client) => {
      if (client.transport === "broker") return client.request("session/prompt");
      return {};
    }, { prepareConnection: enqueuer.prepareConnection, requireScopedCancellation: true, allowCapacityFallback: true });
    if (cancel || reason === "connect-busy") await assert.rejects(run);
    else await run;
    assert.equal(connections, cancel || reason === "connect-busy" ? 1 : 2);
  });
}

for (const transport of ["broker", "direct"]) for (const boundary of ["startup-error", "cancel-before-record", "save-failure"]) {
  test(`actual transport is recorded before session startup: ${transport}, ${boundary}`, async () => {
    let record = { id: "job", status: "running", grokPromptState: "not-sent" };
    let updates = 0;
    let handled = 0;
    let closed = 0;
    const context = vm.createContext({ process: { env: {} },
      readStoredJob: () => record, writeJobFile: (_root, _id, value) => { record = value; },
      observeBrokerWorkerCancellation: () => ({ dispose() {} }),
      updateState: (_root, fn) => { updates += 1; fn({ jobs: [record] }); if (updates === 2 && boundary === "save-failure") throw Error("Save failed"); },
      GrokAcpClient: { connect: async () => {
        if (boundary === "cancel-before-record") record.status = "cancelled";
        return { transport, initializeResult: { _meta: { grokBrokerGeneration: "generation" } }, close: async () => { closed += 1; } };
      } } });
    vm.runInContext(sourceFunction(companion, "function createPromptEnqueuer", "async function handleCancel"), context);
    vm.runInContext("function getBrokerUnsentRejection() { return null; }\n" + withGrokSource, context);
    const enqueuer = context.createPromptEnqueuer("mock", "job");
    assert.equal(typeof enqueuer.connectionEstablished, "function");
    await assert.rejects(context.withGrok("mock", async () => {
      handled += 1;
      assert.equal(record.grokTransport, transport);
      assert.equal(record.grokPromptState, transport === "broker" ? "not-sent" : "starting");
      throw Error("session/new failed");
    }, { prepareConnection: enqueuer.prepareConnection, connectionEstablished: enqueuer.connectionEstablished }));
    assert.equal(handled, boundary === "startup-error" ? 1 : 0);
    assert.equal(closed, 1);
  });
}

for (const platform of ["win32", "linux"]) for (const state of ["alive", "signalled", "exited"]) {
  test(`${platform} close never stops through a reusable PID: ${state}`, async () => {
    let kills = 0;
    let rawPidStops = 0;
    const timers = [];
    const context = vm.createContext({ process: { platform },
      AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.framer = { close() {} }; } },
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      CLOSE_TIMEOUT_MS: 1000,
      waitForExitWithTimeout: async () => { for (const timer of timers.splice(0)) timer(); },
      terminateProcessTree: () => { rawPidStops += 1; } });
    vm.runInContext(sourceFunction(acp, "class SpawnedAcpClient", "class BrokerAcpClient") + ";globalThis.Direct = SpawnedAcpClient;", context);
    const client = new context.Direct("mock", {});
    client.proc = { pid: 123, killed: false, exitCode: state === "exited" ? 0 : null,
      signalCode: state === "signalled" ? "SIGTERM" : null, stdin: { end() {} }, kill() { kills += 1; } };
    await client.close();
    assert.equal(rawPidStops, 0);
    assert.equal(kills, 0);
  });
}
