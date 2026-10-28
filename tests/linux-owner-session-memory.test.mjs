import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

// Failure conditions: a stale owner sends session/new or session/load; a
// synchronous request is issued outside the state lock; the lock is kept
// while waiting for its asynchronous reply. This is a simulated boundary,
// not an actual Linux kernel or ACP integration test.
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
function extract(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to).replace(/^export /, "");
}

function createStartSession() {
  return vm.runInNewContext(`${extract("async function startSession(", "/**\n * プロンプトを 1 ターン実行")}\nstartSession`, {
    applyRequestedModel: async () => "model", applyRequestedEffort: async () => "effort"
  });
}

test("session/new cannot be sent when the original Linux owner is stale", async () => {
  const startSession = createStartSession();
  let requests = 0;
  const guardOwnerEffect = () => { throw new Error("owner changed"); };
  await assert.rejects(startSession({ request: () => { requests++; return Promise.resolve({ sessionId: "s" }); } },
    "workspace", { guardOwnerEffect }), /owner changed/);
  assert.equal(requests, 0);
});

test("session/new sends synchronously under the owner guard and awaits outside it", async () => {
  const startSession = createStartSession();
  let held = false, releaseReply;
  const guardOwnerEffect = effect => {
    held = true;
    try { return effect(); } finally { held = false; }
  };
  const client = { request: method => {
    assert.equal(method, "session/new");
    assert.equal(held, true);
    return new Promise(resolve => { releaseReply = resolve; });
  } };
  const result = startSession(client, "workspace", { guardOwnerEffect });
  void result.catch(() => {});
  assert.equal(held, false);
  assert.equal(typeof releaseReply, "function");
  releaseReply({ sessionId: "s" });
  assert.equal((await result).sessionId, "s");
});

test("session/load cannot be sent when the original Linux owner is stale", async () => {
  let requests = 0;
  const client = { initializeResult: { agentCapabilities: { loadSession: true } },
    request: () => { requests++; throw new Error("stale load was sent"); } };
  const runGrokTurn = vm.runInNewContext(`${extract("export async function runGrokTurn(", "/**\n * 直近の委任タスク用セッション")}\nrunGrokTurn`, {
    process: { env: {} }, randomUUID: () => "execution", DEFAULT_REVIEW_MODEL: "model",
    getGrokAvailability: () => ({ available: true, bin: "fake" }),
    withGrok: async (_cwd, handler) => handler(client), emitProgress() {}
  });
  const enqueuePrompt = Object.assign(() => {}, { guardOwnerEffect: () => { throw new Error("owner changed"); } });
  await assert.rejects(runGrokTurn("workspace", { prompt: "hello", resumeSessionId: "old", enqueuePrompt }), /owner changed/);
  assert.equal(requests, 0);
});
