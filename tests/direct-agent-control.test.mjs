import test from "node:test";
import assert from "node:assert/strict";
import { registerDirectAgentOwner, readDirectAgentStop, waitForDirectAgentStop } from "../plugins/grok/scripts/lib/direct-agent-control.mjs";

function fixture(overrides = {}) {
  const indexed = { id: "job", status: "running", epoch: "fixture-epoch", pid: 42, processStartKey: "worker-start",
    claimToken: "fixture-claim", workerLease: { id: "lease", path: "/fixture/lease", dev: "1", ino: "2", stateGeneration: "fixture-epoch" } };
  let stored = { ...indexed };
  let locked = false;
  let notify;
  let poll;
  let disposed = 0;
  let reads = 0;
  const deps = {
    pid: 42, ownerToken: { epoch: "fixture-epoch", pid: 42, startKey: "worker-start" }, verifyDarwinTrackedOwner: () => true,
    randomUUID: () => "generation-a", resolveStateDir: () => "mock-state",
    updateState: (_root, change) => { assert.equal(locked, false); locked = true; try { change({ jobs: [indexed] }, { epoch: "fixture-epoch" }); } finally { locked = false; } },
    withStateSnapshot: (_root, inspect) => { assert.equal(locked, false); locked = true; try { return inspect({ jobs: [indexed] }, { epoch: "fixture-epoch" }); } finally { locked = false; } },
    readStoredJob: () => { assert.equal(locked, true); reads += 1; return stored; },
    readCandidate: () => { assert.equal(locked, false); reads += 1; return { indexed, stored }; },
    writeJobFile: (_root, _id, next) => { assert.equal(locked, true); stored = next; },
    watch: (_root, callback) => { notify = callback; return { on() {}, close() { disposed += 1; } }; },
    setInterval: callback => { poll = callback; return { unref() {} }; }, clearInterval() {},
    ...overrides
  };
  return { indexed, deps, stored: () => stored, notify: (event = "rename", name = "state.json") => notify(event, name), poll: () => poll(), disposed: () => disposed, reads: () => reads,
    cancelled() { indexed.status = stored.status = "cancelled"; indexed.terminationPending = stored.terminationPending = true; },
    locked: () => locked };
}

test("direct generation is durable before starting and binds worker identity", () => {
  const f = fixture();
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => false }, f.deps);
  assert.equal(f.indexed.grokDirectGeneration, "generation-a");
  assert.equal(f.stored().grokDirectOwnerStartKey, "worker-start");
  assert.equal(f.indexed.grokDirectOwnerPid, 42);
  owner.dispose();
});

for (const race of ["before-generation", "before-ready", "after-enqueue", "concurrent-cancel", "poll-fallback"]) {
  test(`direct owner cancellation is safe at ${race}`, async () => {
    const f = fixture();
    let closes = 0;
    let release;
    const closing = new Promise(resolve => { release = resolve; });
    if (race === "before-generation") f.cancelled();
    let owner;
    const register = () => registerDirectAgentOwner("mock", "job", { close: () => {
      assert.equal(f.locked(), false);
      closes += 1;
      return closing;
    } }, f.deps);
    if (race === "before-generation") {
      assert.throws(register, /cancelled|running/);
      assert.equal(closes, 0);
      return;
    }
    owner = register();
    if (race === "after-enqueue") f.indexed.grokPromptState = f.stored().grokPromptState = "pending";
    f.cancelled();
    if (race === "poll-fallback") f.poll(); else f.notify();
    if (race === "concurrent-cancel") { f.notify(); f.poll(); }
    await Promise.resolve();
    assert.equal(closes, 1);
    assert.equal(readDirectAgentStop("mock", "job", f.indexed, f.deps), false);
    release("job-empty");
    await owner.closed;
    assert.equal(readDirectAgentStop("mock", "job", f.indexed, f.deps), true);
    assert.equal(f.disposed(), 1);
  });
}

for (const proof of [false, "job-empty", "posix-group-empty", "never-started"]) {
  test(`direct owner persists only explicit stop proof: ${proof}`, async () => {
    const f = fixture();
    const owner = registerDirectAgentOwner("mock", "job", { close: async () => proof }, f.deps);
    f.cancelled();
    assert.equal(await owner.finish(proof), Boolean(proof));
    assert.equal(readDirectAgentStop("mock", "job", f.indexed, f.deps), Boolean(proof));
    if (proof) assert.equal(f.stored().grokDirectStopKind, proof);
  });
}

for (const stale of ["generation", "worker-key", "stored-only-ack"]) {
  test(`direct stop evidence rejects ${stale}`, async () => {
    const f = fixture();
    const owner = registerDirectAgentOwner("mock", "job", { close: async () => "job-empty" }, f.deps);
    const expected = { ...f.indexed };
    f.cancelled();
    if (stale === "generation") f.indexed.grokDirectGeneration = f.stored().grokDirectGeneration = "generation-b";
    if (stale === "worker-key") f.indexed.processStartKey = f.stored().processStartKey = "replacement-worker";
    if (stale === "stored-only-ack") {
      f.stored().grokDirectStopGeneration = "generation-a";
      f.stored().grokDirectStopKind = "job-empty";
    } else assert.equal(await owner.finish("job-empty"), false);
    assert.equal(readDirectAgentStop("mock", "job", expected, f.deps), false);
    owner.dispose();
  });
}

test("direct ACK save failure remains pending even if the per-job write succeeded", async () => {
  const f = fixture();
  let fail = false;
  const update = f.deps.updateState;
  f.deps.updateState = (_root, change) => update("mock", (state, context) => {
    if (!fail) return change(state, context);
    change({ jobs: [{ ...f.indexed }] }, context);
    throw Error("Index save failed");
  });
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => "job-empty" }, f.deps);
  f.cancelled();
  fail = true;
  await assert.rejects(owner.finish("job-empty"), /save failed/);
  assert.equal(readDirectAgentStop("mock", "job", f.indexed, f.deps), false);
});

test("direct cancel wait is outside the lock and never infers a dead worker ACK", async () => {
  const f = fixture();
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => false }, f.deps);
  f.cancelled();
  const expected = { ...f.indexed };
  owner.dispose();
  assert.equal(await waitForDirectAgentStop("mock", "job", expected, { ...f.deps, timeoutMs: 20, pollMs: 5 }), false);
});

test("a delayed direct ACK can complete after the cancel caller's earlier deadline", async () => {
  const f = fixture();
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => false }, f.deps);
  f.cancelled();
  const expected = { ...f.indexed };
  assert.equal(await waitForDirectAgentStop("mock", "job", expected, { ...f.deps, timeoutMs: 10, pollMs: 2 }), false);
  await owner.finish("job-empty");
  assert.equal(await waitForDirectAgentStop("mock", "job", expected, f.deps), true);
});

test("watch ignores lock, directory and filename-less self notifications and recovers with poll", async () => {
  const f = fixture();
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => "job-empty" }, f.deps);
  const before = f.reads();
  for (const name of ["state.lock", "jobs", "protocol.json", null]) f.notify("change", name);
  assert.equal(f.reads(), before);
  f.cancelled();
  f.notify("change", null);
  f.poll();
  await owner.closed;
  assert.equal(readDirectAgentStop("mock", "job", f.indexed, f.deps), true);
});

test("direct cancel deadline does not wait for a competing state lock", async () => {
  const f = fixture({ withStateSnapshot() { throw Error("A candidate read must not acquire the state lock"); } });
  const owner = registerDirectAgentOwner("mock", "job", { close: async () => false }, f.deps);
  assert.equal(await waitForDirectAgentStop("mock", "job", f.indexed, { ...f.deps, timeoutMs: 10, pollMs: 2 }), false);
  owner.dispose();
});

test("cancellation during subscribe closes the startup gate before register returns", async () => {
  let f;
  let closes = 0;
  f = fixture({ watch: () => { f.cancelled(); return { on() {}, close() {} }; } });
  const owner = registerDirectAgentOwner("mock", "job", { close: () => { closes += 1; return Promise.resolve("never-started"); } }, f.deps);
  assert.equal(closes, 1);
  await owner.closed;
});

test("direct ACK lock recheck receives the caller's remaining budget", async () => {
  const f = fixture(); const owner = registerDirectAgentOwner("mock", "job", { close: async () => "job-empty" }, f.deps);
  await owner.finish("job-empty");
  const snapshot = f.deps.withStateSnapshot;
  let observed;
  f.deps.withStateSnapshot = (root, inspect, options) => { observed = options?.timeoutMs; return snapshot(root, inspect); };
  assert.equal(readDirectAgentStop("mock", "job", f.indexed, { ...f.deps, timeoutMs: 37 }), true);
  assert.equal(observed, 37);
  assert.equal(await waitForDirectAgentStop("mock", "job", f.indexed, { ...f.deps, timeoutMs: 30 }), true);
  assert.ok(observed >= 0 && observed <= 30);
});

test("an optimistic direct ACK cannot bypass the locked generation recheck", async () => {
  const f = fixture(); const owner = registerDirectAgentOwner("mock", "job", { close: async () => "job-empty" }, f.deps);
  await owner.finish("job-empty");
  const expected = { ...f.indexed };
  const candidate = { indexed: { ...f.indexed }, stored: { ...f.stored() } };
  f.indexed.grokDirectGeneration = f.stored().grokDirectGeneration = "new-generation";
  assert.equal(await waitForDirectAgentStop("mock", "job", expected, { ...f.deps, readCandidate: () => candidate, timeoutMs: 10 }), false);
});
