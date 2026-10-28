import test from "node:test";
import assert from "node:assert/strict";
import * as tracked from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import fs from "node:fs";
import vm from "node:vm";
import { waitForTrackedJobExit } from "../plugins/grok/scripts/lib/process.mjs";

// 失敗条件: agentがcancel通知を無視してprompt RPCを返さずworkerが待ち続ける。
// 自身のbroker接続以外、別pid/startKey/generation、片側記録、directは閉じない。
for (const race of ["cancel", "pending", "one-sided", "other-pid", "other-start", "other-generation", "direct", "lookup-error", "complete", "close-rejects", "close-hangs", "dispose"]) {
  test(`broker worker closes only its owned connection on cancellation: ${race}`, async () => {
    const workerLease = { id: "lease", path: "/fixture/lease", dev: "1", ino: "2", stateGeneration: "fixture-epoch" };
    let indexed = { id: "job", status: "running", pid: 42, processStartKey: "worker-start", epoch: "fixture-epoch", claimToken: "fixture-claim", workerLease, grokTransport: "broker", grokBrokerGeneration: "generation" };
    let stored = { ...indexed };
    let check;
    let cleared = 0;
    let closes = 0;
    let readError = false;
    const observer = tracked.observeBrokerWorkerCancellation("virtual", "job", {
      brokerGeneration: "generation", close() {
        closes += 1;
        if (race === "close-rejects") return Promise.reject(Error("Socket already closed"));
        if (race === "close-hangs") return new Promise(() => {});
      }
    }, { pid: 42, ownerToken: { epoch: "fixture-epoch", claimToken: "fixture-claim", workerLease }, readCandidate: () => { if (readError) throw Error("Read interrupted"); return { indexed, stored }; },
      setInterval: callback => { check = callback; return { unref() {} }; }, clearInterval: () => { cleared += 1; } });
    assert.equal(closes, 0);
    indexed = { ...indexed, status: "cancelled", terminationPending: true };
    stored = { ...indexed };
    if (race === "pending") indexed.status = stored.status = "failed";
    if (race === "one-sided") stored.status = "running", stored.terminationPending = false;
    if (race === "other-pid") indexed.pid = stored.pid = 99;
    if (race === "other-start") indexed.processStartKey = stored.processStartKey = "replacement";
    if (race === "other-generation") indexed.grokBrokerGeneration = stored.grokBrokerGeneration = "replacement";
    if (race === "direct") indexed.grokTransport = stored.grokTransport = "direct";
    if (race === "lookup-error") readError = true;
    if (race === "complete") indexed.status = stored.status = "completed", indexed.terminationPending = stored.terminationPending = false;
    if (race === "dispose") observer.dispose();
    check(); check();
    await Promise.resolve(); await Promise.resolve();
    const shouldClose = ["cancel", "pending", "close-rejects", "close-hangs"].includes(race);
    assert.equal(closes, shouldClose ? 1 : 0);
    observer.dispose();
    assert.equal(cleared, 1);
  });
}

test("cooperative worker exit can use the existing five-second stop budget", () => {
  let checks = 0;
  assert.equal(waitForTrackedJobExit(42, "worker-start", {
    inspectImpl: () => ++checks < 15 ? "match" : "absent", sleepImpl() {}
  }), true);
  assert.equal(checks, 15);
});

test("withGrok exposes only its own broker connection and rejects a held prompt after cancellation", async () => {
  const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
  const source = "function getBrokerUnsentRejection() { return null; }\n" + grok.slice(grok.indexOf("async function withGrok"), grok.indexOf("function isBrokerUnsentPrompt"));
  let rejectPrompt;
  const prompt = new Promise((_resolve, reject) => { rejectPrompt = reject; });
  void prompt.catch(() => {});
  let destroyed = 0;
  let closes = 0;
  let disposed = 0;
  let cancelConnection;
  const client = { transport: "broker", initializeResult: { _meta: {} }, socket: {
    destroy() { destroyed += 1; rejectPrompt(Error("Owned broker connection closed")); }
  }, close: async () => { closes += 1; } };
  const context = vm.createContext({ process: { env: {} }, brokerRequests: new WeakMap(), GrokAcpClient: { connect: async () => client },
    BROKER_BUSY_RPC_CODE: -1 });
  vm.runInContext(source, context);
  const operation = context.withGrok("virtual", async () => prompt, { connectionEstablished(connection) {
    assert.equal(typeof connection.close, "function");
    cancelConnection = connection.close;
    return () => { disposed += 1; };
  } });
  void operation.catch(() => {});
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  if (!cancelConnection) await operation;
  await cancelConnection();
  await assert.rejects(operation, /Owned broker connection closed/);
  assert.equal(destroyed, 1);
  assert.ok(closes >= 1);
  assert.equal(disposed, 1);
});

test("tracked companion wiring releases a held broker prompt without committing cancelled output", async () => {
  const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
  const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
  const workerLease = { id: "lease", slot: 1, path: "/fixture/lease", dev: "1", ino: "2",
    stateGeneration: "fixture-epoch", directoryDev: "1", directoryIno: "3" };
  const ownerToken = { pid: 42, startKey: "start", epoch: "fixture-epoch", claimToken: "fixture-claim", workerLease };
  const indexed = { id: "job", status: "running", pid: ownerToken.pid, processStartKey: ownerToken.startKey,
    epoch: ownerToken.epoch, claimToken: ownerToken.claimToken, workerLease };
  let stored = { ...indexed };
  let rejectPrompt;
  let check;
  let disposed = 0;
  let destroyed = 0;
  const prompt = new Promise((_resolve, reject) => { rejectPrompt = reject; });
  void prompt.catch(() => {});
  const client = { transport: "broker", initializeResult: { _meta: { grokBrokerGeneration: "generation" } },
    socket: { destroy() { destroyed += 1; rejectPrompt(Error("Owned connection closed")); } }, close: async () => {} };
  const context = vm.createContext({ process: { env: {} }, brokerRequests: new WeakMap(), GrokAcpClient: { connect: async () => client }, BROKER_BUSY_RPC_CODE: -1,
    readStoredJob: () => stored, writeJobFile: (_root, _id, value) => { stored = value; },
    updateState: (_root, callback) => callback({ jobs: [indexed] }), withStateSnapshot: (_root, callback) => callback({ jobs: [indexed] }),
    observeBrokerWorkerCancellation: (root, id, control, options) => tracked.observeBrokerWorkerCancellation(root, id, control, {
      ...options, pid: 42, readCandidate: () => ({ indexed, stored }), setInterval: callback => { check = callback; return { unref() {} }; },
      clearInterval: () => { disposed += 1; }
    })
  });
  vm.runInContext(companion.slice(companion.indexOf("function createPromptEnqueuer"), companion.indexOf("async function handleCancel")), context);
  vm.runInContext("function getBrokerUnsentRejection() { return null; }\n" + grok.slice(grok.indexOf("async function withGrok"), grok.indexOf("function isBrokerUnsentPrompt")), context);
  const enqueuer = context.createPromptEnqueuer("virtual", "job", ownerToken);
  const operation = context.withGrok("virtual", () => enqueuer(() => prompt,
    { sessionId: "session", transport: "broker", brokerGeneration: "generation" }),
  { prepareConnection: enqueuer.prepareConnection, connectionEstablished: enqueuer.connectionEstablished });
  void operation.catch(() => {});
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(stored.grokPromptState, "pending");
  for (const current of [indexed, stored]) Object.assign(current, { status: "cancelled", terminationPending: true });
  check();
  await assert.rejects(operation, /Owned connection closed/);
  assert.equal(destroyed, 1);
  assert.equal(disposed, 1);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.terminationPending, true);
});
