import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";

// 先行失敗条件: cancel無視、owner切断、遅延terminal、同session回避、
// 世代不一致、容量飽和、旧clientのprompt、agent接続喪失。
// 実ネットワーク・子process・ファイル書込み/削除を一切使わずbroker本体を通す。
const source = fs.readFileSync(new URL("../plugins/grok/scripts/acp-broker.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "");
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

async function broker() {
  let accept;
  const calls = [];
  const notifications = [];
  const grant = { ownerIdentity: { epoch: "epoch-one" } };
  const agent = {
    initializeResult: {},
    exitPromise: new Promise(() => {}),
    brokerAuthorization: { grant, baseline: "baseline" },
    setNotificationHandler() {}, setAgentRequestHandler() {}, respondToAgent() {},
    notify: (method, params) => notifications.push({ method, params }),
    request(method, params, { signal }) {
      return new Promise((resolve, reject) => {
        calls.push({ method, params, resolve, reject });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  };
  const server = new EventEmitter();
  server.listen = () => {};
  const context = {
    fs: new Proxy({}, { get: () => () => { throw new Error("Real filesystem operation prohibited"); } }),
    net: { createServer: (handler) => { accept = handler; return server; } },
    path: { resolve: (...parts) => parts.join("/"), dirname: () => "virtual" },
    process: { argv: ["node", "broker", "serve", "--endpoint", "mock"], cwd: () => "virtual", env: { GROK_COMPANION_BROKER_GENERATION: "generation-one" },
      on() {}, stderr: { write: (value) => { throw new Error(value); } }, exit: () => { throw new Error("Unexpected exit"); } },
    parseArgs: () => ({ options: { endpoint: "mock" } }),
    parseBrokerEndpoint: () => ({ kind: "pipe", path: "mock" }),
    GrokAcpClient: { connectBrokerOwned: async (cwd, options) => {
      assert.equal(cwd, "virtual"); assert.equal(options.brokerEndpoint, "mock"); assert.equal(options.posixGroupMode, "inherit");
      return agent;
    } },
    verifyBrokerEpoch: (cwd, epoch) => {
      assert.equal(cwd, "virtual");
      assert.equal(epoch, "epoch-one");
      return true;
    },
    inspectBrokerConfirmation: async (actualGrant, baseline, endpoint, generation) => {
      assert.deepEqual([actualGrant, baseline, endpoint, generation], [grant, "baseline", "mock", "generation-one"]);
      return true;
    },
    setTimeout: () => ({}), clearTimeout() {}, performance: { now: () => 0 },
    BROKER_AGENT_STDERR_METHOD: "broker/stderr", BROKER_BUSY_RPC_CODE: -32001, BROKER_CAPACITY_RPC_CODE: -32003,
    AbortController,
    JsonlFramer: class { constructor(handler) { this.handler = handler; } push(chunk) { for (const line of chunk.trim().split("\n")) this.handler(line); } close() {} }
  };
  vm.runInNewContext(source, context);
  await flush();
  function socket() {
    const value = new EventEmitter();
    value.messages = [];
    value.destroyed = false;
    value.setEncoding = () => {};
    value.write = (data) => value.messages.push(JSON.parse(data));
    value.end = value.destroy = () => { value.destroyed = true; value.emit("close"); };
    value.send = async (id, method, params = {}) => {
      value.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await flush();
      return value.messages.findLast((message) => message.id === id);
    };
    accept(value);
    return value;
  }
  return { socket, calls, notifications };
}

test("cancel ignores transport ACK and reports accepted execution until actual terminal", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  const control = fixture.socket();
  await owner.send(1, "session/prompt", { sessionId: "session", executionId: "job", prompt: [] });
  const cancel = await control.send(2, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" });
  assert.equal(cancel.result.executionState, "accepted");
  owner.destroy();
  await flush();
  assert.equal((await control.send(3, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" })).result.executionState, "accepted");
  const other = fixture.socket();
  assert.ok((await other.send(4, "session/prompt", { sessionId: "other", executionId: "other-job", prompt: [] })).error);
  fixture.calls[0].resolve({ stopReason: "cancelled" });
  await flush();
  assert.equal((await control.send(5, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" })).result.executionState, "terminal");
});

test("cancel cannot prove an absent execution across broker generations", async () => {
  const fixture = await broker();
  const control = fixture.socket();
  const init = await control.send(1, "initialize");
  assert.equal(init.result._meta.grokBrokerGeneration, "generation-one");
  const cancel = await control.send(2, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "old-generation" });
  assert.equal(cancel.result.executionState, "unknown");
});

test("owner disconnect retains pending prompt and blocks same-session replacement", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  await owner.send(1, "session/prompt", { sessionId: "session", executionId: "job", prompt: [] });
  owner.destroy();
  await flush();
  const replacement = fixture.socket();
  assert.ok((await replacement.send(2, "session/prompt", { sessionId: "session", executionId: "replacement", prompt: [] })).error);
  assert.ok((await replacement.send(3, "session/prompt", { sessionId: "other", executionId: "replacement", prompt: [] })).error);
  assert.equal(fixture.calls.length, 1);
});

test("agent transport failure remains unknown and quarantines the session", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  await owner.send(1, "session/prompt", { sessionId: "session", executionId: "job", prompt: [] });
  fixture.calls[0].reject(new Error("Agent disconnected"));
  await flush();
  const control = fixture.socket();
  assert.equal((await control.send(2, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" })).result.executionState, "unknown");
  assert.ok((await control.send(3, "session/prompt", { sessionId: "session", executionId: "replacement", prompt: [] })).error);
});

test("only same-generation absent execution has never-accepted proof", async () => {
  const fixture = await broker();
  const control = fixture.socket();
  assert.equal((await control.send(1, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" })).result.executionState, "never-accepted");
  assert.ok((await control.send(2, "session/prompt", { sessionId: "session", executionId: "job", prompt: [] })).error);
});

test("legacy unscoped execution never gets an absent-execution proof", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  await owner.send(1, "session/prompt", { sessionId: "session", prompt: [] });
  const control = fixture.socket();
  assert.equal((await control.send(2, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" })).result.executionState, "unknown");
});

test("agent RPC error confirms terminal while stale generation never cancels the current turn", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  await owner.send(1, "session/prompt", { sessionId: "session", executionId: "job", prompt: [] });
  const control = fixture.socket();
  const stale = await control.send(2, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "old" });
  assert.equal(stale.result.notificationSent, false);
  assert.equal(fixture.notifications.length, 0);
  fixture.calls[0].reject(Object.assign(new Error("Agent rejected prompt"), { rpcResponseReceived: true }));
  await flush();
  assert.equal((await control.send(3, "broker/cancelTurn", { sessionId: "session", executionId: "job", generation: "generation-one" })).result.executionState, "terminal");
});

test("execution ledger capacity fails closed and retains earlier terminal proof", async () => {
  const fixture = await broker();
  for (let index = 0; index < 4096; index += 1) {
    const owner = fixture.socket();
    await owner.send(1, "session/prompt", { sessionId: `session-${index}`, executionId: `job-${index}`, prompt: [] });
    fixture.calls[index].resolve({ stopReason: "end_turn" });
    await flush();
    owner.destroy();
  }
  const control = fixture.socket();
  const overflow = await control.send(2, "session/prompt", { sessionId: "overflow", executionId: "overflow", prompt: [] });
  assert.equal(overflow.error.data.promptForwarded, false);
  assert.equal(fixture.calls.length, 4096);
  assert.equal((await control.send(3, "broker/cancelTurn", { sessionId: "session-0", executionId: "job-0", generation: "generation-one" })).result.executionState, "terminal");
});

test("session load rejects direct, legacy, and previous-generation history without local terminal proof", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  assert.ok((await owner.send(1, "session/load", { sessionId: "outside-history" })).error);
  assert.equal(fixture.calls.length, 0);
  await owner.send(2, "session/prompt", { sessionId: "known-session", executionId: "known-job", prompt: [] });
  assert.ok((await owner.send(4, "session/load", { sessionId: "known-session" })).error);
  fixture.calls[0].resolve({ stopReason: "end_turn" });
  await flush();
  await owner.send(3, "session/load", { sessionId: "known-session" });
  assert.equal(fixture.calls[1].method, "session/load");
  fixture.calls[1].resolve({});
  await flush();
  await owner.send(5, "session/prompt", { sessionId: "known-session", executionId: "second-job", prompt: [] });
  assert.ok((await owner.send(6, "session/load", { sessionId: "known-session" })).error);
  fixture.calls[2].resolve({ stopReason: "end_turn" });
  await flush();
  owner.destroy();
  const secondBroker = await broker();
  assert.ok((await secondBroker.socket().send(1, "session/load", { sessionId: "known-session" })).error);
  assert.equal(secondBroker.calls.length, 0);
});

test("disconnected session cannot resume even after its delayed terminal response", async () => {
  const fixture = await broker();
  const owner = fixture.socket();
  await owner.send(1, "session/prompt", { sessionId: "session", executionId: "job", prompt: [] });
  owner.destroy();
  fixture.calls[0].resolve({ stopReason: "cancelled" });
  await flush();
  assert.ok((await fixture.socket().send(2, "session/load", { sessionId: "session" })).error);
  assert.equal(fixture.calls.length, 1);
});
