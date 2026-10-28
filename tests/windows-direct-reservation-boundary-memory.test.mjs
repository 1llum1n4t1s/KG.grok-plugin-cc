import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// 実際の Windows spawn を呼ばず、利用者経路の同期境界と予約検査を同じ VM 内で実行する。
const acp = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const clientSource = acp.slice(acp.indexOf("class SpawnedAcpClient"), acp.indexOf("class BrokerAcpClient"));
const admission = fs.readFileSync(new URL("../plugins/grok/scripts/lib/direct-start-admission.mjs", import.meta.url), "utf8");
const verifySource = admission.slice(admission.indexOf("export function verifyDirectStartWithinContext"), admission.indexOf("/** 自分の確定証拠"))
  .replaceAll("export function ", "function ");
const windowsAgent = fs.readFileSync(new URL("../plugins/grok/scripts/lib/windows-agent.mjs", import.meta.url), "utf8");
const windowsAgentSource = windowsAgent.slice(windowsAgent.indexOf("export async function spawnWindowsAgent"))
  .replace("export async function spawnWindowsAgent", "async function spawnWindowsAgent");
assert.ok(clientSource.includes("class SpawnedAcpClient") && verifySource.includes("function verifyDirectStartWithinContext") &&
  verifySource.includes("function verifyDirectStart("));

function fixture(variant) {
  const owner = { stateDir: "C:\\fixture", hostId: "host", volumeGuid: "volume", directoryIdentity: { dev: "1", ino: "2" } };
  const markerIdentity = { dev: "1", ino: "10", mode: "33152", uid: "0", gid: "0" };
  const token = { generation: "fixture-generation", ownerIdentity: owner, markerIdentity, markerSize: "128" };
  const marker = { pending: { generation: token.generation, ownerPid: 41, ownerIdentity: owner },
    released: undefined, confirmed: undefined, fileIdentity: { ...markerIdentity }, fileSize: token.markerSize };
  const store = { markers: [marker], brokerPending: false, snapshots: 0, checks: 0, starts: 0, handshakes: 0, proofs: [] };
  const proc = new EventEmitter();
  Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const owned = { proc, ready: Promise.resolve(), stopConfirmed: false, async close() { this.stopConfirmed = true; return true; } };
  const context = vm.createContext({ process: { platform: "win32", pid: 41, env: {} }, setTimeout, Promise,
    quoteIfNeeded: value => value, DIRECT_HANDSHAKE_TIMEOUT_MS: 100,
    withTimeout: value => value, waitForExitWithTimeout: async () => {},
    fail: detail => { throw new Error(`Direct startup admission ${detail}`); },
    identity: value => { value.check(); return owner; },
    sameIdentity: (a, b) => a?.hostId === b?.hostId && a?.volumeGuid === b?.volumeGuid &&
      a?.directoryIdentity?.dev === b?.directoryIdentity?.dev && a?.directoryIdentity?.ino === b?.directoryIdentity?.ino,
    sameFileIdentity: (a, b) => ["dev", "ino", "mode", "uid", "gid"].every(key => String(a?.[key]) === String(b?.[key])),
    requireNoLegacyAdmission: () => {}, entries: () => ({ markers: store.markers }),
    withStateSnapshot: (_cwd, run) => { store.snapshots++; return run({}, { check() { store.checks++; } }); },
    reserveDirectAdmission: () => {
      if (variant === "missing") { store.markers = []; store.brokerPending = true; }
      if (variant === "confirmed") { marker.released = { proof: "never-started" }; marker.confirmed = { proof: "never-started" }; store.brokerPending = true; }
      if (variant === "identical") marker.fileIdentity = { ...markerIdentity, ino: "11" };
      if (variant === "owner") marker.pending = { ...marker.pending, ownerPid: 42 };
      return token;
    },
    finishDirectStart: (_cwd, _token, proof) => { store.proofs.push(proof); return variant === "valid"; },
    spawnWindowsAgent: async (_cwd, _command, _args, options) => { options.beforeSpawn?.(); store.starts++; return owned; },
    AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.closed = false; this.framer = { close() {} }; this.stderr = ""; }
      async performInitialize() { store.handshakes++; } }
  });
  vm.runInContext(`${verifySource}\n${clientSource}\nglobalThis.connect=connectDirectClient; globalThis.verify=verifyDirectStart;`, context);
  return { context, store, token };
}

for (const variant of ["missing", "confirmed", "identical", "owner"]) {
  test(`Windows reservation verification rejects ${variant} before spawn`, async () => {
    const { context, store } = fixture(variant);
    let client;
    try {
      await assert.rejects(async () => { client = await context.connect("mock", {}); }, /identity|owner|reservation|marker|generation/i);
      assert.equal(store.snapshots, 1, "the marker must be checked within a state snapshot");
      assert.equal(store.starts, 0, "no Windows agent may spawn for a changed reservation");
      assert.equal(store.handshakes, 0);
      if (["missing", "confirmed"].includes(variant)) assert.equal(store.brokerPending, true);
    } finally { if (client) await client.close(); }
  });

  test(`Windows verification boundary rejects ${variant} with no filesystem side effects`, () => {
    const { context, store, token } = fixture(variant);
    context.reserveDirectAdmission();
    assert.throws(() => context.verify("mock", token), /identity|owner|reservation|marker|generation/i);
    assert.equal(store.snapshots, 1);
    assert.equal(store.starts, 0);
  });
}

test("Windows direct spawn checks a valid reservation before starting", async () => {
  const { context, store } = fixture("valid");
  const client = await context.connect("mock", {});
  try {
    assert.equal(store.snapshots, 2);
    assert.equal(store.starts, 1);
    assert.equal(store.handshakes, 1);
  } finally { await client.close(); }
});

test("Windows broker-owned agent checks its authorization before starting", async () => {
  const { context, store } = fixture("valid");
  let client;
  try {
    await assert.rejects(async () => { client = await context.connect("mock", { beforeDirectSpawn: () => { throw new Error("broker grant changed"); } }, true); }, /grant changed/);
    assert.equal(store.starts, 0);
    assert.equal(store.handshakes, 0);
  } finally { if (client) await client.close(); }
});

test("Windows broker-owned agent consumes a rejecting thenable before any spawn", async () => {
  const { context, store } = fixture("valid");
  let rejectionObserved = false;
  const thenable = { then(_resolve, reject) { rejectionObserved = true; reject(new Error("fixture rejection")); } };
  await assert.rejects(context.connect("mock", { beforeDirectSpawn: () => thenable }, true), /must be synchronous/);
  await Promise.resolve();
  assert.equal(rejectionObserved, true);
  assert.equal(store.starts, 0);
});

test("Windows supervisor rechecks the direct reservation after pipe listen and before spawn", async () => {
  const owner = { stateDir: "C:\\fixture", hostId: "host", volumeGuid: "volume", directoryIdentity: { dev: "1", ino: "2" } };
  const markerIdentity = { dev: "1", ino: "10", mode: "33152", uid: "0", gid: "0" };
  const token = { generation: "fixture-generation", ownerIdentity: owner, markerIdentity, markerSize: "128" };
  const marker = { pending: { generation: token.generation, ownerPid: 41, ownerIdentity: owner },
    fileIdentity: markerIdentity, fileSize: token.markerSize };
  const store = { markers: [marker], snapshots: 0, starts: 0, brokerPending: false, listen: null, serverClosed: false };
  const server = new EventEmitter();
  server.listen = (_pipe, callback) => { store.listen = callback; };
  server.close = () => { store.serverClosed = true; };
  const context = vm.createContext({ process: { platform: "win32", pid: 41, env: {} }, setTimeout, clearTimeout, Promise, Buffer, path,
    net: { createServer: () => server }, randomUUID: () => "fixture-uuid", supervisorScript: "fixture-supervisor.ps1",
    getProcessSnapshot: () => ({ startKey: "win32-filetime:123" }), buildShellCommand: () => "fixture command",
    spawn: () => { store.starts++; throw new Error("fixture prevented supervisor spawn"); },
    quoteIfNeeded: value => value, DIRECT_HANDSHAKE_TIMEOUT_MS: 100,
    withTimeout: value => value, waitForExitWithTimeout: async () => {},
    fail: detail => { throw new Error(`Direct startup admission ${detail}`); },
    identity: value => { value.check(); return owner; },
    sameIdentity: (a, b) => a?.hostId === b?.hostId && a?.volumeGuid === b?.volumeGuid &&
      a?.directoryIdentity?.dev === b?.directoryIdentity?.dev && a?.directoryIdentity?.ino === b?.directoryIdentity?.ino,
    sameFileIdentity: (a, b) => ["dev", "ino", "mode", "uid", "gid"].every(key => String(a?.[key]) === String(b?.[key])),
    requireNoLegacyAdmission: () => {}, entries: () => ({ markers: store.markers }),
    withStateSnapshot: (_cwd, run) => { store.snapshots++; return run({}, { check() {} }); },
    reserveDirectAdmission: () => token,
    finishDirectStart: () => false,
    AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.closed = false; this.framer = { close() {} }; this.stderr = ""; }
      async performInitialize() {} }
  });
  vm.runInContext(`${verifySource}\n${windowsAgentSource}\n${clientSource}\nglobalThis.connect=connectDirectClient;`, context);
  const running = context.connect("mock", {});
  assert.equal(typeof store.listen, "function", "the first reservation check must reach the pipe-listen gate");
  assert.equal(store.snapshots, 1, "the reservation must be checked before pipe preparation");
  store.markers = [];
  store.brokerPending = true;
  store.listen();
  await assert.rejects(running, /identity|owner|reservation|marker|generation/i);
  assert.equal(store.snapshots, 2, "the reservation must be checked again after the asynchronous pipe listen");
  assert.equal(store.starts, 0, "no supervisor may spawn after reservation loss");
  assert.equal(store.brokerPending, true);
  assert.equal(store.serverClosed, true);
});

for (const variant of ["synchronous", "thenable"]) {
  test(`Windows supervisor ${variant} pre-spawn guard closes the pipe on failure`, async () => {
    const events = [];
    const server = new EventEmitter();
    let listenCallback;
    server.listen = (_pipe, callback) => { events.push("listen"); listenCallback = callback; };
    server.close = () => { events.push("close"); };
    const context = vm.createContext({ process: { pid: 41, env: {} }, Promise, Buffer, path, setTimeout, clearTimeout,
      net: { createServer: () => server }, randomUUID: () => "fixture-uuid", supervisorScript: "fixture-supervisor.ps1",
      getProcessSnapshot: () => ({ startKey: "win32-filetime:123" }), buildShellCommand: () => "fixture command",
      spawn: () => { events.push("spawn"); throw new Error("fixture prevented supervisor spawn"); }
    });
    vm.runInContext(`${windowsAgentSource}\nglobalThis.start=spawnWindowsAgent;`, context);
    const running = context.start("mock", "grok", [], { beforeSpawn() {
      events.push("check");
      if (variant === "thenable") return Promise.resolve(true);
      return true;
    } });
    assert.deepEqual(events, ["listen"]);
    listenCallback();
    await assert.rejects(running, variant === "thenable" ? /must be synchronous/ : /fixture prevented supervisor spawn/);
    assert.deepEqual(events, variant === "thenable" ? ["listen", "check", "close"] : ["listen", "check", "spawn", "close"]);
  });
}

test("Windows supervisor consumes a rejecting thenable when enforcing the synchronous guard", async () => {
  const events = [];
  const server = new EventEmitter();
  let listenCallback, rejectionObserved = false;
  server.listen = (_pipe, callback) => { listenCallback = callback; };
  server.close = () => { events.push("close"); };
  const context = vm.createContext({ process: { pid: 41, env: {} }, Promise, Buffer, path, setTimeout, clearTimeout,
    net: { createServer: () => server }, randomUUID: () => "fixture-uuid", supervisorScript: "fixture-supervisor.ps1",
    getProcessSnapshot: () => ({ startKey: "win32-filetime:123" }), buildShellCommand: () => "fixture command",
    spawn: () => { events.push("spawn"); throw new Error("unexpected supervisor spawn"); }
  });
  vm.runInContext(`${windowsAgentSource}\nglobalThis.start=spawnWindowsAgent;`, context);
  const running = context.start("mock", "grok", [], { beforeSpawn() {
    return { then(_resolve, reject) { rejectionObserved = true; reject(new Error("fixture rejection")); } };
  } });
  listenCallback();
  await assert.rejects(running, /must be synchronous/);
  await Promise.resolve();
  assert.equal(rejectionObserved, true, "the rejected thenable must have a rejection handler");
  assert.deepEqual(events, ["close"]);
});

test("Windows cancellation while pipe listen is pending proves never-started and releases admission", async () => {
  const owner = { stateDir: "C:\\fixture", hostId: "host", volumeGuid: "volume", directoryIdentity: { dev: "1", ino: "2" } };
  const markerIdentity = { dev: "1", ino: "10", mode: "33152", uid: "0", gid: "0" };
  const token = { generation: "fixture-generation", ownerIdentity: owner, markerIdentity, markerSize: "128" };
  const marker = { pending: { generation: token.generation, ownerPid: 41, ownerIdentity: owner },
    fileIdentity: markerIdentity, fileSize: token.markerSize };
  const state = { starts: 0, snapshots: 0, listen: null, closed: false, ownerProofs: [], admissionProofs: [] };
  const server = new EventEmitter();
  server.listen = (_pipe, callback) => { state.listen = callback; };
  server.close = () => { state.closed = true; };
  const context = vm.createContext({ process: { platform: "win32", pid: 41, env: {} }, setTimeout, clearTimeout, Promise, Buffer, path,
    net: { createServer: () => server }, randomUUID: () => "fixture-uuid", supervisorScript: "fixture-supervisor.ps1",
    getProcessSnapshot: () => ({ startKey: "win32-filetime:123" }), buildShellCommand: () => "fixture command",
    spawn: () => { state.starts++; throw new Error("fixture prevented supervisor spawn"); },
    quoteIfNeeded: value => value, DIRECT_HANDSHAKE_TIMEOUT_MS: 100,
    withTimeout: value => value, waitForExitWithTimeout: async () => {},
    fail: detail => { throw new Error(`Direct startup admission ${detail}`); },
    identity: value => { value.check(); return owner; },
    sameIdentity: (a, b) => a?.hostId === b?.hostId && a?.volumeGuid === b?.volumeGuid &&
      a?.directoryIdentity?.dev === b?.directoryIdentity?.dev && a?.directoryIdentity?.ino === b?.directoryIdentity?.ino,
    sameFileIdentity: (a, b) => ["dev", "ino", "mode", "uid", "gid"].every(key => String(a?.[key]) === String(b?.[key])),
    requireNoLegacyAdmission: () => {}, entries: () => ({ markers: [marker] }),
    withStateSnapshot: (_cwd, run) => { state.snapshots++; return run({}, { check() {} }); },
    reserveDirectAdmission: () => token,
    finishDirectStart: (_cwd, _token, proof) => { state.admissionProofs.push(proof); return true; },
    AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.closed = false; this.framer = { close() {} }; this.stderr = ""; }
      async performInitialize() {} }
  });
  vm.runInContext(`${verifySource}\n${windowsAgentSource}\n${clientSource}\nglobalThis.connect=connectDirectClient;`, context);
  let control;
  const running = context.connect("mock", { directAgentStarting(value) {
    control = value;
    return { async finish(proof) { state.ownerProofs.push(proof); return Boolean(proof); } };
  } });
  const settled = running.then(() => ({ accepted: true }), error => ({ error }));
  assert.equal(typeof state.listen, "function");
  const closing = control.close();
  state.listen();
  const proof = await closing;
  const result = await settled;
  assert.equal(state.starts, 0, "the supervisor must never spawn after cancellation");
  assert.equal(proof, "never-started");
  assert.deepEqual(state.ownerProofs, ["never-started"]);
  assert.deepEqual(state.admissionProofs, ["never-started"]);
  assert.match(result.error?.message ?? "", /closed|cancelled/i);
  assert.notEqual(result.error?.turnStopUnconfirmed, true);
  assert.equal(state.closed, true, "the listening pipe must be closed");
});
