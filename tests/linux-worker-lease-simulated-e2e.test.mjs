import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 生存中の worker を終了と判定、終了後も子が FD を保持、
// observer の commit 前に競合者が slot を奪取、不正 epoch を終了証拠にする。
// /proc・namespace・mount・flock は模擬値。Mac lockf の競合は Linux の
// flock、mount namespace、PID 再利用の実証ではない。
const mac = { skip: process.platform !== "darwin", timeout: 20000 };
const generation = "11111111-1111-4111-8111-111111111111";
const fixture = new URL("./fixtures/linux-worker-lease-simulated.mjs", import.meta.url);

function setup(t) {
  const directory = makeTempDir("grok-linux-worker-lease-simulated-");
  fs.mkdirSync(path.join(directory, "worker-leases-v1"), { mode: 0o700 });
  fs.mkdirSync(path.join(directory, "worker-leases-v1", generation), { mode: 0o700 });
  const children = [];
  const markers = [];
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    for (const marker of markers) {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(fs.existsSync(marker), `descendant did not finish; retained ${directory}`);
    }
    removeTempFixture(directory, { recursive: true, force: true });
  });
  return { directory, children, markers };
}
async function start(scope, request) {
  const child = fork(fixture, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  scope.children.push({ child, closed });
  child.send({ directory: scope.directory, stateGeneration: generation, ...request });
  const message = await Promise.race([
    once(child, "message").then(([value]) => value),
    closed.then(() => { throw new Error("fixture exited before reporting"); })
  ]);
  assert.notEqual(message.type, "error", message.message);
  return { child, closed, message };
}
async function observe(scope, lease, options = {}) {
  const observer = await start(scope, { action: "probe", lease, ...options });
  await observer.closed;
  return observer.message;
}

test("simulated Linux worker lease survives while its real Node owner is alive", mac, async t => {
  const scope = setup(t);
  const owner = await start(scope, { action: "acquire" });
  assert.equal(owner.message.type, "acquired");
  const lease = owner.message.lease;
  assert.deepEqual(await observe(scope, lease), { result: { status: "unknown" }, callbackCount: 0 });
  owner.child.send("finish");
  await owner.closed;
  assert.deepEqual(await observe(scope, lease), { result: { status: "available", value: "committed" }, callbackCount: 1 });
  assert.deepEqual(await observe(scope, lease, { stateGeneration: "22222222-2222-4222-8222-222222222222" }), { result: { status: "unknown" }, callbackCount: 0 });
});

test("observer holds the simulated flock throughout its synchronous commit", mac, async t => {
  const scope = setup(t);
  const owner = await start(scope, { action: "acquire" });
  owner.child.send("finish");
  await owner.closed;
  const observed = await observe(scope, owner.message.lease, { contend: true });
  assert.deepEqual(observed, {
    result: { status: "available", value: "committed" }, callbackCount: 1,
    nested: { result: { status: "unknown" }, callbackCount: 0 }
  });
});

test("unrelated descendant does not inherit the worker lease FD", mac, async t => {
  const scope = setup(t);
  const marker = path.join(scope.directory, "descendant-exited");
  const owner = await start(scope, { action: "acquire", descendantMarker: marker });
  scope.markers.push(marker);
  owner.child.kill("SIGKILL");
  await owner.closed;
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(await observe(scope, owner.message.lease), { result: { status: "available", value: "committed" }, callbackCount: 1 });
});

test("another open of the same lease inode is not the worker's owned FD", mac, async t => {
  const scope = setup(t);
  const result = await start(scope, { action: "forged-fd" });
  await result.closed;
  assert.equal(result.message.accepted, false);
});

test("reusing the worker's FD number for a new open does not preserve ownership", mac, async t => {
  const scope = setup(t);
  const result = await start(scope, { action: "reused-fd" });
  await result.closed;
  assert.equal(result.message.sameNumber, true, "fixture must reproduce FD number reuse");
  assert.equal(result.message.accepted, false);
});

test("owner handles are private, bound to their epoch, and invalid after release", mac, async t => {
  const scope = setup(t);
  const result = await start(scope, { action: "owner-lifecycle" });
  await result.closed;
  assert.deepEqual(result.message, { type: "lifecycle-result", fdExposed: false, valid: true, forged: false, wrongEpoch: false, wrongClaim: false, acceptedV4: false, acceptedV5: false, released: true, afterRelease: false, releasedAgain: false });
});

test("flock utility failure is not accepted as evidence of contention", mac, async t => {
  const scope = setup(t);
  const result = await start(scope, { action: "flock-error" });
  await result.closed;
  assert.deepEqual(result.message, { type: "flock-error-result", accepted: false });
});

test("rejecting a thenable does not leave an unhandled rejection", mac, async t => {
  const scope = setup(t);
  const owner = await start(scope, { action: "acquire" });
  owner.child.send("finish");
  await owner.closed;
  const result = await start(scope, { action: "reject-thenable", lease: owner.message.lease });
  await result.closed;
  assert.match(result.message.message, /synchronous/);
  assert.equal(result.message.unhandled, false);
});

test("a context check returning a rejected promise cannot authorize a commit", mac, async t => {
  const scope = setup(t);
  const owner = await start(scope, { action: "acquire" });
  owner.child.send("finish");
  await owner.closed;
  const result = await start(scope, { action: "async-check", lease: owner.message.lease });
  await result.closed;
  assert.deepEqual(result.message, { type: "async-check-result", result: { status: "unknown" }, callbackCount: 0, unhandled: false });
});
