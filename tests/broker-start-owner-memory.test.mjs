import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import test from "node:test";

// 先行条件: timeout→PID再利用、exit配送前のexitCode、exit callbackからの停止禁止、
// 生存直子groupへの同期signal、SIGTERM無視/拒否、spawn失敗、Windows旧互換、ログ保持。
// fs操作・spawn・signal・timerを全て仮想化し、実ファイル/プロセス/削除を使わない。
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/\bexport /g, "")
  .replace(/import\.meta\.url/g, JSON.stringify("file:///virtual/lib/broker-lifecycle.mjs"));
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const EPOCH = "11111111-1111-4111-8111-111111111111";
const brokerDirFor = platform => platform === "linux" ? `/state/broker-v3/${EPOCH}` : "/state/broker-v2";
const confirmedSession = (session) => Buffer.from([
  { version: 2, epoch: EPOCH, event: "pending", generation: session.generation, ownerPid: 777, platform: "linux", lockToken: "owner",
    endpoint: session.endpoint, sessionDir: "/candidate", pidFile: "/candidate/pid", logFile: "/candidate/log" },
  { version: 2, epoch: EPOCH, event: "spawned", generation: session.generation, pid: session.pid, pgid: session.pid },
  { version: 2, epoch: EPOCH, event: "settled", generation: session.generation, pid: session.pid, outcome: "ready" },
  { version: 2, epoch: EPOCH, event: "confirmed", generation: session.generation, pid: session.pid, outcome: "ready" }
].map(record => `${JSON.stringify(record)}\n`).join(""));

function fixture({ platform = "linux", ready = false, onSignal = "exit", groupState = "gone" } = {}) {
  const brokerDir = brokerDirFor(platform);
  const child = new EventEmitter();
  const channel = new EventEmitter();
  channel.write = (line) => {
    const grant = JSON.parse(line);
    Promise.resolve().then(() => channel.emit("data", Buffer.from(`${JSON.stringify({ version: 1, event: "ready", generation: grant.generation,
      endpoint: grant.endpoint, pid: grant.pid, nonce: grant.nonce, ...(platform === "linux" ? { epoch: grant.ownerIdentity.epoch } : {}) })}\n`)));
  };
  channel.destroy = () => {};
  Object.assign(child, { pid: 456, exitCode: null, signalCode: null, killed: false, unref() {},
    stdio: [null, null, null, channel],
    kill() { calls.ownedHandleStops++; child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); return true; } });
  const calls = { numeric: [], queries: [], groups: [], probes: [], removed: [], warnings: [], spawned: [], saved: [], mutations: [], migration: [], scopes: [], resolutions: [], ownedHandleStops: 0 };
  const timers = [];
  const files = new Map([[path.posix.join(brokerDir, "broker.lock"), Buffer.from("lock")]]);
  const handles = new Map();
  const handleFlags = new Map();
  const identities = new Map();
  const directories = new Set(["/state", "/session", "/tmp", ...(platform === "linux" ? ["/state/broker-v3"] : []), brokerDir]);
  const faults = { writeEvent: null, fsyncEvent: null, closeEvent: null, directorySyncEvent: null, deadlineEvent: null,
    partialEvent: null, save: false, migration: null, scopeCost: 0, scopeHook: null, rejectAfterSpawn: false };
  let nextDescriptor = 5;
  let lastJournalEvent = null;
  let partialWritePending = false;
  const missing = () => Object.assign(new Error("missing virtual file"), { code: "ENOENT" });
  const stat = (name, options = {}) => {
    if (!files.has(name) && !directories.has(name)) throw missing();
    if (!identities.has(name)) identities.set(name, identities.size + 1);
    const num = value => options.bigint ? BigInt(value) : value;
    return { dev: num(1), ino: num(identities.get(name)), size: num(files.get(name)?.length ?? 0),
      mode: num(directories.has(name) ? 0o40700 : 0o100600), uid: num(1), gid: num(1), nlink: num(1),
      mtimeMs: num(1), ctimeMs: num(1), mtimeNs: 1n, ctimeNs: 1n,
      isFile: () => files.has(name), isDirectory: () => directories.has(name), isSymbolicLink: () => false };
  };
  let phase = "outside";
  let now = 0;
  const context = vm.createContext({
    fs: {
      constants: fs.constants,
      lstatSync: stat,
      fstatSync: (descriptor, options) => stat(handles.get(descriptor), options),
      mkdirSync: (name) => { calls.mutations.push(["mkdir", name]); directories.add(name); },
      writeFileSync: (name, bytes, options) => {
        calls.mutations.push(["write", name]);
        if (name.startsWith(`${brokerDir}/broker.json.`)) {
          if (faults.save) throw new Error("broker save failure");
          calls.saved.push(JSON.parse(bytes));
        }
        if (options?.flag === "wx" && files.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        files.set(name, Buffer.from(bytes));
      },
      renameSync: (from, to) => { calls.mutations.push(["rename", from, to]); files.set(to, files.get(from)); files.delete(from);
        if (identities.has(from)) { identities.set(to, identities.get(from)); identities.delete(from); } },
      rmSync: (name) => { calls.removed.push(name); files.delete(name); },
      openSync: (name, flags) => {
        const create = flags === "a" || (typeof flags === "number" && Boolean(flags & fs.constants.O_CREAT));
        const exclusive = typeof flags === "number" && Boolean(flags & fs.constants.O_EXCL);
        if (create && exclusive && files.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        if (create && !files.has(name)) files.set(name, Buffer.alloc(0));
        if (!files.has(name) && !directories.has(name)) throw missing();
        const descriptor = nextDescriptor++; handles.set(descriptor, name); handleFlags.set(descriptor, flags); return descriptor;
      },
      closeSync: (descriptor) => {
        if ((handleFlags.get(descriptor) === "a" || (typeof handleFlags.get(descriptor) === "number" && Boolean(handleFlags.get(descriptor) & fs.constants.O_APPEND))) && handles.get(descriptor)?.endsWith("broker-admission.jsonl") && faults.closeEvent === lastJournalEvent) throw new Error("journal close failure");
        handles.delete(descriptor); handleFlags.delete(descriptor);
      }, existsSync: name => files.has(name) || directories.has(name) || name.startsWith("/session/"),
      readFileSync: (name, encoding) => {
        if (!files.has(name)) throw missing();
        return encoding ? files.get(name).toString(encoding) : Buffer.from(files.get(name));
      },
      readSync: (descriptor, buffer, offset, length, position) => {
        const name = handles.get(descriptor);
        if (!files.has(name)) throw missing();
        return files.get(name).copy(buffer, offset, position, position + length);
      },
      writeSync: (descriptor, buffer, offset, length) => {
        if (partialWritePending) { partialWritePending = false; throw new Error("partial journal write"); }
        const name = handles.get(descriptor); const bytes = buffer.subarray(offset, offset + length);
        let event; try { event = JSON.parse(bytes.toString()).event; } catch { /* partial write */ }
        if (event && faults.writeEvent === event) throw new Error("journal write failure");
        if (event) lastJournalEvent = event;
        const size = event && faults.partialEvent === event ? Math.floor(bytes.length / 2) : bytes.length;
        if (size !== bytes.length) partialWritePending = true;
        files.set(name, Buffer.concat([files.get(name), bytes.subarray(0, size)]));
        if (event && faults.deadlineEvent === event) now += 5000;
        return size;
      },
      fsyncSync: (descriptor) => {
        if (handles.get(descriptor)?.endsWith("broker-admission.jsonl") && faults.fsyncEvent === lastJournalEvent) throw new Error("journal fsync failure");
        if (handles.get(descriptor) === brokerDir && faults.directorySyncEvent === lastJournalEvent) throw new Error("broker directory sync failure");
      },
      unlinkSync: (name) => { calls.removed.push(name); files.delete(name); }, rmdirSync() {}
    },
    path: path.posix, os: { tmpdir: () => "/tmp" }, process: { platform, pid: 1234, execPath: "/node", env: {}, stderr: { write: (text) => calls.warnings.push(text) },
      kill: (pid, signal) => {
        if (signal === 0) {
          calls.probes.push(pid);
          if (groupState === "gone") throw Object.assign(new Error("no group"), { code: "ESRCH" });
          if (groupState === "denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
          return true;
        }
        assert.equal(phase, "timer");
        calls.groups.push({ pid, signal });
        if (onSignal === "throw") throw new Error("EPERM");
        if (onSignal === "exit") { child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); }
        return true;
      } },
    spawn: (_command, _args, options) => { calls.spawned.push(options); return child; },
    processCommandContains: (pid) => { calls.queries.push(pid); return true; },
    terminateProcessTree: (pid) => { calls.numeric.push(pid); return true; },
    randomUUID: () => "generation", resolveStateDir: (_cwd, options) => { calls.resolutions.push(options); return "/state"; },
    stateFallbackTempDir: () => "/tmp",
    withStateSnapshot(_cwd, callback) {
      return callback({}, { stateDir: "/state", directoryIdentity: { dev: "1", ino: "2" }, hostId: "host", volumeGuid: null,
        epoch: platform === "linux" ? EPOCH : null, check() {} });
    },
    requireNoDirectStart(context) { if (platform === "linux") assert.equal(context.epoch, EPOCH); context.check(); },
    requireNoLegacyAdmission(context) { if (platform === "linux") assert.equal(context.epoch, EPOCH); context.check(); },
    requireStateLockMigration: (stateDir) => { calls.migration.push(stateDir); if (faults.migration) throw new Error(faults.migration); },
    withStateLockMigrationScope(stateDir, callback, options = {}) {
      calls.scopes.push({ stateDir, ...options });
      const deadline = now + (options.timeoutMs ?? Infinity);
      now += faults.scopeCost;
      faults.scopeHook?.(calls.scopes.length);
      let active = true;
      const check = () => {
        assert.equal(active, true, "expired migration scope cannot be reused");
        calls.migration.push(stateDir);
        if (faults.migration) throw new Error(faults.migration);
        if (now >= deadline) throw new Error("migration scope deadline expired");
      };
      Object.defineProperty(check, "epoch", { value: platform === "linux" ? EPOCH : null });
      try {
        check(); const result = callback(check);
        if (faults.rejectAfterSpawn && calls.spawned.length) faults.migration = "migration failed at scope completion";
        check(); return result;
      } finally { active = false; }
    },
    URL, Buffer, AbortController, Date: { now: () => now }, performance: { now: () => now },
    setTimeout: (callback, delay) => { const timer = { callback, delay, due: now + delay, active: true, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.active = false; }
  });
  vm.runInContext(source, context);
  const original = { saveBrokerSession: context.saveBrokerSession, clearBrokerSession: context.clearBrokerSession,
    waitForBrokerEndpoint: context.waitForBrokerEndpoint };
  const readStoredSession = context.loadBrokerSession;
  context.loadBrokerSession = () => null;
  context.createBrokerSessionDir = () => "/session";
  context.createBrokerEndpoint = () => "unix:/session/socket";
  context.parseBrokerEndpoint = () => ({ kind: "unix", path: "/session/socket" });
  context.waitForBrokerEndpoint = async () => ready;
  context.isBrokerEndpointReady = async (endpoint, generation, timeoutMs) => {
    assert.equal(typeof endpoint, "string");
    assert.equal(typeof generation, "string");
    assert.ok(timeoutMs > 0);
    return ready;
  };
  const start = () => context.startBrokerSession("/repo", { scriptPath: "/broker.mjs" }, "lock");
  const tick = async () => {
    const timer = timers.filter((item) => item.active).sort((a, b) => a.due - b.due)[0];
    if (timer) { timer.active = false; now = Math.max(now, timer.due); phase = "timer"; timer.callback(); phase = "outside"; }
    await flush();
    return Boolean(timer);
  };
  return { context, child, calls, timers, files, faults, brokerDir, readStoredSession, original, start, tick, advance: ms => { now += ms; }, now: () => now };
}

// 失敗条件: 同期helperごとのcold照会、awaitを越すscope再利用、残予算の再設定、
// connect待ち中のmarker/世代変更、照会中に期限を超えた後のshutdown送信。
test("one synchronous stopped-agent transaction shares one cold migration scope", () => {
  const f = fixture({ platform: "win32" }); f.faults.scopeCost = 400;
  const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "pipe:owned", ownerPlatform: "win32" };
  f.context.loadBrokerSession = () => session;
  f.files.delete(`${f.brokerDir}/broker.lock`);
  assert.equal(f.context.recordBrokerAgentStopped("/repo", session), "saved");
  assert.equal(f.calls.scopes.length, 1);
  assert.equal(f.calls.saved[0].shutdownAgentTerminatedGeneration, session.generation);
  assert.equal(f.calls.removed.filter(name => name.endsWith("broker.lock")).length, 1);
});

for (const fault of ["throw", "false", "deadline"]) {
  test(`idle shutdown checks the actual connect/write boundary: ${fault}`, async () => {
    const f = fixture();
    const socket = new EventEmitter(); const writes = [];
    socket.setEncoding = () => socket;
    socket.write = text => writes.push(text);
    socket.destroy = () => socket.emit("close");
    f.context.net = { createConnection: () => socket };
    const result = f.context.requestIdleBrokerShutdown({ endpoint: "unix:/session/socket", generation: "generation" }, 100, {
      beforeSend() {
        if (fault === "throw") throw new Error("migration became invalid");
        if (fault === "deadline") { f.advance(101); return true; }
        return false;
      }
    });
    socket.emit("connect");
    socket.emit("data", '{"id":1,"result":{"_meta":{"grokBrokerGeneration":"generation"}}}\n');
    assert.equal(await result, false);
    assert.deepEqual(writes.map(line => JSON.parse(line).method), ["initialize"]);
  });
}

test("idle shutdown rejects an ACK delivered after its absolute deadline", async () => {
  const f = fixture(); const socket = new EventEmitter();
  socket.setEncoding = () => socket; socket.write = () => {};
  socket.destroy = () => socket.emit("close");
  f.context.net = { createConnection: () => socket };
  const result = f.context.requestIdleBrokerShutdown({ endpoint: "unix:/session/socket", generation: "generation" }, 100);
  socket.emit("connect");
  socket.emit("data", '{"id":1,"result":{"_meta":{"grokBrokerGeneration":"generation"}}}\n');
  f.advance(101);
  socket.emit("data", '{"id":2,"result":{"closing":true,"generation":"generation"}}\n');
  assert.equal(await result, false);
});

test("endpoint readiness bounds a socket that emits neither connect nor error", async () => {
  const f = fixture(); const socket = new EventEmitter(); let destroyed = 0;
  socket.destroy = () => { destroyed++; socket.emit("close"); };
  f.context.net = { createConnection: () => socket };
  const result = f.original.waitForBrokerEndpoint("unix:/session/socket", 100);
  assert.ok(f.timers.some(timer => timer.active), "a silent socket needs its own remaining-time timer");
  await f.tick();
  assert.equal(await result, false);
  assert.ok(destroyed > 0);
});

test("a synchronous public save resolves its state directory once and shares no scope with the next call", () => {
  const f = fixture();
  f.original.saveBrokerSession("/repo", { generation: "first", epoch: EPOCH }, "lock");
  assert.equal(f.calls.scopes.length, 1);
  assert.equal(f.calls.resolutions.length, 1);
  f.original.saveBrokerSession("/repo", { generation: "second", epoch: EPOCH }, "lock");
  assert.equal(f.calls.scopes.length, 2);
  assert.equal(f.calls.resolutions.length, 2);
});

test("cold 400ms validation phases fit successful idle cleanup into its total 1250ms budget", async () => {
  const f = fixture(); f.faults.scopeCost = 400;
  const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket", ownerPlatform: "linux",
    ownedGroup: { pgid: 456, generation: "generation", platform: "linux" } };
  f.files.set(`${f.brokerDir}/broker.json`, Buffer.from(JSON.stringify(session)));
  f.files.set(`${f.brokerDir}/broker-admission.jsonl`, confirmedSession(session));
  f.files.delete(`${f.brokerDir}/broker.lock`);
  f.context.loadBrokerSession = f.readStoredSession;
  f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: "/session/broker.pid", log: "/session/broker.log" });
  const socket = new EventEmitter(); socket.setEncoding = () => socket;
  socket.destroy = () => socket.emit("close");
  socket.write = line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") socket.emit("data", '{"id":1,"result":{"_meta":{"grokBrokerGeneration":"generation"}}}\n');
    else {
      assert.equal(request.method, "broker/shutdownIfIdle");
      socket.emit("data", '{"id":2,"result":{"closing":true,"generation":"generation"}}\n');
    }
  };
  f.context.net = { createConnection: () => socket };
  const result = f.context.cleanupIdleBrokerSession("/repo", session, { timeoutMs: 1250 });
  socket.emit("connect");
  assert.equal(await result, true);
  assert.ok(f.calls.scopes.length >= 1 && f.calls.scopes.length <= 3);
  assert.ok(f.now() < 1250);
  assert.equal(f.files.has(`${f.brokerDir}/broker.json`), false);
  assert.equal(f.files.has(`${f.brokerDir}/broker.lock`), false);
  assert.ok(f.calls.removed.every(name => !name.startsWith("/session/")));
});

test("idle cleanup defaults to 1800ms but preserves an explicit shorter deadline", async () => {
  for (const timeoutMs of [undefined, 1250]) {
    const f = fixture(); f.faults.scopeCost = 500;
    const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket", ownerPlatform: "linux",
      ownedGroup: { pgid: 456, generation: "generation", platform: "linux" } };
    f.files.set(`${f.brokerDir}/broker.json`, Buffer.from(JSON.stringify(session)));
    f.files.set(`${f.brokerDir}/broker-admission.jsonl`, confirmedSession(session));
    f.files.delete(`${f.brokerDir}/broker.lock`);
    f.context.loadBrokerSession = f.readStoredSession;
    f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: "/session/broker.pid", log: "/session/broker.log" });
    const socket = new EventEmitter(); socket.setEncoding = () => socket;
    socket.destroy = () => socket.emit("close");
    socket.write = line => {
      const request = JSON.parse(line);
      if (request.method === "initialize") socket.emit("data", '{"id":1,"result":{"_meta":{"grokBrokerGeneration":"generation"}}}\n');
      else {
        assert.equal(request.method, "broker/shutdownIfIdle");
        socket.emit("data", '{"id":2,"result":{"closing":true,"generation":"generation"}}\n');
      }
    };
    f.context.net = { createConnection: () => socket };
    const result = f.context.cleanupIdleBrokerSession("/repo", session, { timeoutMs });
    socket.emit("connect");
    assert.equal(await result, timeoutMs === undefined);
    assert.equal(f.calls.scopes[0].timeoutMs, timeoutMs ?? 1800);
    if (timeoutMs !== undefined) {
      assert.equal(f.files.has(`${f.brokerDir}/broker.json`), true);
      assert.deepEqual(f.calls.saved, []);
      assert.deepEqual(f.calls.removed, []);
    }
  }
});

test("an expired cleanup budget cannot start validation or request shutdown", async () => {
  const f = fixture();
  const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket",
    ownedGroup: { pgid: 456, generation: "generation", platform: "linux" } };
  f.files.set(`${f.brokerDir}/broker.json`, Buffer.from(JSON.stringify(session)));
  f.context.loadBrokerSession = f.readStoredSession;
  f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: "/session/broker.pid", log: "/session/broker.log" });
  f.faults.scopeCost = 400;
  let notifications = 0;
  f.context.requestIdleBrokerShutdown = async () => { notifications++; return true; };
  f.context.recordBrokerShutdown = () => "superseded";
  const result = f.context.cleanupIdleBrokerSession("/repo", session, { timeoutMs: 300 });
  await assert.rejects(result, /deadline|timed out|budget/i);
  assert.equal(notifications, 0);
  assert.deepEqual(f.calls.mutations, []);
  assert.deepEqual(f.calls.removed, []);
  assert.ok(f.calls.resolutions.some(options => options?.deadline === 300));
});

test("scope completion failure preserves and stops the Windows child handle captured during spawn", async () => {
  const f = fixture({ platform: "win32", ready: true }); f.faults.rejectAfterSpawn = true;
  await assert.rejects(f.start(), /scope completion/);
  assert.equal(f.calls.spawned.length, 1);
  assert.equal(f.calls.ownedHandleStops, 1);
  assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned"]);
  assert.deepEqual(f.calls.saved, []);
  assert.deepEqual(f.calls.removed, []);
});

test("startup deadline after spawn keeps the lock and admission pending instead of deleting without a budget", async () => {
  const f = fixture({ ready: true }); f.faults.scopeCost = 400;
  f.files.delete(`${f.brokerDir}/broker.lock`);
  f.context.waitForBrokerEndpoint = async () => { f.advance(1500); return true; };
  const rejected = assert.rejects(f.context.ensureBrokerSession("/repo", { timeoutMs: 2000, scriptPath: "/broker.mjs" }), /deadline|timed out/i);
  await flush(); for (let index = 0; index < 5; index++) await f.tick(); await rejected;
  assert.equal(f.calls.spawned.length, 1);
  assert.equal(f.files.has(`${f.brokerDir}/broker.lock`), true);
  assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned"]);
  assert.deepEqual(f.calls.saved, []);
  assert.deepEqual(f.calls.removed, []);
});

for (const socketFailure of ["silent", "error"]) {
  test(`real readiness waiting reserves confirmation and persistence time before direct fallback: ${socketFailure}`, async () => {
    const f = fixture(); f.faults.scopeCost = 400;
    f.context.waitForBrokerEndpoint = f.original.waitForBrokerEndpoint;
    f.context.net = { createConnection() {
      const socket = new EventEmitter();
      socket.destroy = () => socket.emit("close");
      if (socketFailure === "error") Promise.resolve().then(() => socket.emit("error", new Error("not ready")));
      return socket;
    } };
    const completed = f.context.startBrokerSession("/repo", { scriptPath: "/broker.mjs", timeoutMs: 2000 }, "lock")
      .then(value => ({ value }), error => ({ error }));
    await flush(); for (let index = 0; index < 90; index++) await f.tick();
    const outcome = await completed;
    assert.equal(outcome.error, undefined, outcome.error?.message);
    assert.equal(outcome.value, null);
    assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned", "settled", "confirmed"]);
    assert.equal(records(f).at(-1).outcome, "stopped");
    assert.ok(f.now() < 2000);
    assert.deepEqual(f.calls.groups, [{ pid: -456, signal: "SIGTERM" }]);
  });
}

test("the default startup preserves 2000ms of readiness and a slow confirmed stop before settling", async () => {
  const f = fixture(); f.faults.scopeCost = 400;
  f.context.waitForBrokerEndpoint = f.original.waitForBrokerEndpoint;
  f.context.net = { createConnection() {
    const socket = new EventEmitter(); socket.destroy = () => socket.emit("close"); return socket;
  } };
  let gone = false;
  const originalKill = f.context.process.kill;
  f.context.process.kill = (pid, signal) => {
    if (signal === 0 && pid < 0) {
      if (gone) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }
    const result = originalKill(pid, signal);
    if (signal === "SIGTERM") f.context.setTimeout(() => { gone = true; }, 1000);
    return result;
  };
  const completed = f.start().then(value => ({ value }), error => ({ error }));
  await flush(); for (let index = 0; index < 160; index++) await f.tick();
  const outcome = await completed;
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.value, null);
  assert.equal(f.calls.scopes[0].timeoutMs, 4500);
  assert.ok(f.now() >= 3800 && f.now() < 4500, "ready 2000ms + slow stop 1000ms + two cold scopes");
  assert.equal(records(f).at(-1).outcome, "stopped");
});

test("readiness waiting races the owned child's early exit and closes its silent socket", async () => {
  const f = fixture(); f.faults.scopeCost = 400;
  f.context.waitForBrokerEndpoint = f.original.waitForBrokerEndpoint;
  let destroyed = 0;
  f.context.net = { createConnection() {
    const socket = new EventEmitter(); socket.destroy = () => { destroyed++; socket.emit("close"); }; return socket;
  } };
  const completed = f.start().then(value => ({ value }), error => ({ error }));
  f.context.setTimeout(() => { f.child.exitCode = 1; f.child.emit("exit", 1, null); }, 100);
  await flush(); for (let index = 0; index < 30; index++) await f.tick();
  const outcome = await completed;
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.value, null);
  assert.ok(f.now() < 1000);
  assert.ok(destroyed > 0);
  assert.equal(f.timers.some(timer => timer.active), false, "the losing socket waiter and retry/stop timers are released");
  assert.deepEqual(f.calls.groups, []);
  assert.equal(records(f).at(-1).outcome, "stopped");
});

test("an unconfirmed owned group cannot extend an explicit startup deadline", async () => {
  const f = fixture({ onSignal: "ignore" }); f.faults.scopeCost = 100;
  f.context.waitForBrokerEndpoint = f.original.waitForBrokerEndpoint;
  f.context.net = { createConnection() {
    const socket = new EventEmitter(); socket.destroy = () => socket.emit("close"); return socket;
  } };
  const rejected = assert.rejects(f.context.startBrokerSession("/repo", { scriptPath: "/broker.mjs", timeoutMs: 1000 }, "lock"), /unconfirmed|not.*confirm|timed out/i);
  await flush(); for (let index = 0; index < 100; index++) await f.tick(); await rejected;
  assert.ok(f.now() <= 1000);
  assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned"]);
  assert.deepEqual(f.calls.removed, []);
});

test("the virtual timer clock never moves backward when a due timer is delivered late", async () => {
  const f = fixture(); let delivered = false;
  f.context.setTimeout(() => { delivered = true; }, 10);
  f.advance(20); await f.tick();
  assert.equal(delivered, true);
  assert.equal(f.now(), 20);
});

for (const scenario of ["valid", "invalid-marker", "slow-validation", "pending-journal"]) {
  test(`an orphan broker lock reaches only a freshly verified bounded fallback: ${scenario}`, async () => {
    const f = fixture(); f.faults.scopeCost = scenario === "slow-validation" ? 1100 : 400;
    const journal = `${f.brokerDir}/broker-admission.jsonl`;
    const settled = confirmedSession({ generation: "previous-stopped", endpoint: "unix:/previous/socket", pid: 789 })
      .toString().replaceAll('"outcome":"ready"', '"outcome":"stopped"');
    f.files.set(journal, Buffer.from(settled));
    let injectedAtFinalScope = false;
    if (["invalid-marker", "pending-journal"].includes(scenario)) f.faults.scopeHook = index => {
      if (index !== 5) return;
      injectedAtFinalScope = true;
      if (scenario === "invalid-marker") f.faults.migration = "migration became invalid";
      else f.files.set(journal, Buffer.concat([f.files.get(journal), Buffer.from(JSON.stringify({ version: 2, epoch: EPOCH, event: "pending",
        generation: "later-owner", ownerPid: 789, platform: "linux", lockToken: "lock", endpoint: "unix:/later/socket",
        sessionDir: "/later", pidFile: "/later/broker.pid", logFile: "/later/broker.log" }) + "\n")]));
    };
    const completed = f.context.ensureBrokerSession("/repo").then(value => ({ value }), error => ({ error }));
    await flush(); for (let index = 0; index < 100; index++) await f.tick();
    const outcome = await completed;
    if (scenario === "valid") {
      assert.equal(outcome.error, undefined, outcome.error?.message);
      assert.equal(outcome.value, null);
      assert.ok(f.now() <= 2400, "the 2000ms rival phase follows the initial 400ms validation");
      assert.ok(f.calls.scopes.length >= 2, "fallback requires a fresh final migration scope");
    } else if (scenario === "pending-journal") {
      assert.equal(injectedAtFinalScope, true, "pending must arrive before the reserved final scope verifies admission");
      assert.match(outcome.error?.message ?? "", /admission.*pending/i);
    } else {
      if (scenario === "invalid-marker") assert.equal(injectedAtFinalScope, true, "migration must become invalid before final verification");
      assert.match(outcome.error?.message ?? "", /migration|timed out|deadline/i);
    }
    assert.deepEqual(f.calls.spawned, []);
    assert.deepEqual(f.calls.removed, []);
    assert.equal(f.files.get(`${f.brokerDir}/broker.lock`).toString(), "lock");
  });
}

test("an orphan broker lock without a journal cannot fall back to direct startup", async () => {
  const f = fixture();
  const rejected = assert.rejects(f.context.ensureBrokerSession("/repo"), /missing.*lock|offline recovery/i);
  await flush(); for (let index = 0; index < 100; index++) await f.tick();
  await rejected;
  assert.deepEqual(f.calls.spawned, []);
  assert.deepEqual(f.calls.removed, []);
  assert.equal(f.files.get(`${f.brokerDir}/broker.lock`).toString(), "lock");
});

for (const ownerState of ["live", "already-exited"]) {
  test(`Windows failed startup never promotes a numeric PID lookup to owned termination: ${ownerState}`, async () => {
    const f = fixture({ platform: "win32" });
    if (ownerState === "already-exited") {
      f.child.exitCode = 0; f.child.emit("exit", 0, null);
    }
    await assert.rejects(f.start(), /unconfirmed|not.*confirm/i);
    assert.deepEqual(f.calls.numeric, []);
    assert.deepEqual(f.calls.queries, []);
    assert.equal(f.calls.ownedHandleStops, ownerState === "live" ? 1 : 0);
    assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned"]);
    assert.deepEqual(f.calls.removed, []);
  });
}

// 失敗条件: 未移行・不正marker・非対応OS、heldLockによる迂回、待機中の検証失効。
// どの場合もspawn/停止通知/全ファイル副作用を禁止し、loadと空cleanupは読取りだけに保つ。
for (const failure of ["explicit offline migration required", "invalid migration protocol", "unsupported migration platform"]) {
  test(`migration rejection blocks every broker write/admission entry: ${failure}`, async () => {
    for (const operation of ["save", "save-held", "acquire", "release", "clear", "journal", "sync", "spawn", "start", "ensure"]) {
      const f = fixture({ ready: true });
      f.faults.migration = failure;
      const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket" };
      f.context.loadBrokerSession = () => operation === "clear" ? session : null;
      if (operation === "clear") f.files.set(`${f.brokerDir}/broker.json`, Buffer.from(JSON.stringify(session)));
      const before = [...f.files].map(([name, bytes]) => [name, bytes.toString()]);
      const invoke = () => {
        switch (operation) {
          case "save": return f.original.saveBrokerSession("/repo", session);
          case "save-held": return f.original.saveBrokerSession("/repo", session, "lock");
          case "acquire": return f.context.acquireBrokerLock("/repo");
          case "release": return f.context.releaseBrokerLock("/repo", "lock");
          case "clear": return f.original.clearBrokerSession("/repo", session);
          case "journal": return f.context.appendBrokerAdmission("/repo", { event: "pending" }, "lock");
          case "sync": return f.context.syncSavedBrokerSession("/repo");
          case "spawn": return f.context.spawnBrokerProcess({ cwd: "/repo", logFile: "/session/broker.log" });
          case "start": return f.start();
          case "ensure": return f.context.ensureBrokerSession("/repo");
        }
      };
      if (["start", "ensure"].includes(operation)) await assert.rejects(invoke, /migration/);
      else if (operation === "release") invoke(); // releaseは既存のbest-effort契約を保つ。
      else assert.throws(invoke, /migration/);
      assert.ok(f.calls.migration.length > 0, operation);
      assert.deepEqual(f.calls.mutations, [], operation);
      assert.deepEqual(f.calls.removed, [], operation);
      assert.deepEqual(f.calls.spawned, [], operation);
      assert.deepEqual([...f.files].map(([name, bytes]) => [name, bytes.toString()]), before, operation);
    }
  });

  test(`migration rejection precedes idle shutdown notification: ${failure}`, async () => {
    const f = fixture(); f.faults.migration = failure;
    const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket",
      ownedGroup: { pgid: 456, generation: "generation", platform: "linux" } };
    let notifications = 0;
    f.files.set(`${f.brokerDir}/broker.json`, Buffer.from(JSON.stringify(session)));
    f.context.loadBrokerSession = f.readStoredSession;
    f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: "/session/broker.pid", log: "/session/broker.log" });
    f.context.requestIdleBrokerShutdown = async () => { notifications++; return true; };
    f.context.recordBrokerShutdown = () => { f.calls.saved.push(session); return "saved"; };
    await assert.rejects(f.context.cleanupIdleBrokerSession("/repo", session), /migration/);
    assert.equal(notifications, 0);
    assert.deepEqual(f.calls.removed, []);
    assert.deepEqual(f.calls.mutations, []);
  });
}

for (const platform of ["linux", "darwin", "win32"]) test(`read-only behavior before migration remains safe: ${platform}`, async () => {
  const f = fixture({ platform }); f.faults.migration = "migration required";
  f.context.fs.existsSync = name => f.files.has(name);
  if (platform === "linux") assert.throws(() => f.readStoredSession("/repo"), /migration/);
  else assert.equal(f.readStoredSession("/repo"), null);
  assert.equal(await f.context.cleanupIdleBrokerSession("/repo", null), false);
  if (platform === "linux") assert.throws(() => f.original.clearBrokerSession("/repo"), /migration/);
  else assert.equal(f.original.clearBrokerSession("/repo"), true);
  if (platform !== "linux") assert.deepEqual(f.calls.migration, []);
  assert.deepEqual(f.calls.mutations, []);
  assert.deepEqual(f.calls.removed, []);
});

for (const migrated of [false, true]) {
  for (const expected of [null, { pid: 456, generation: "generation", endpoint: "unix:/session/socket" }]) {
    test(`malformed broker JSON remains preserved: migrated=${migrated}, expected=${Boolean(expected)}`, () => {
      const f = fixture();
      const brokerFile = `${f.brokerDir}/broker.json`;
      f.files.set(brokerFile, Buffer.from("{incomplete"));
      f.files.delete(`${f.brokerDir}/broker.lock`);
      f.context.fs.existsSync = name => f.files.has(name);
      f.context.loadBrokerSession = f.readStoredSession;
      if (!migrated) {
        f.faults.migration = "migration required";
        assert.throws(() => f.original.clearBrokerSession("/repo", expected), /migration/);
        assert.deepEqual(f.calls.mutations, []);
        assert.deepEqual(f.calls.removed, []);
      } else {
        assert.throws(() => f.original.clearBrokerSession("/repo", expected), /saved broker session is invalid|recovery/i);
        assert.ok(f.calls.migration.length > 0);
        assert.equal(f.files.has(brokerFile), true);
      }
      assert.equal(f.files.get(brokerFile).toString(), "{incomplete");
    });
  }
}

test("clear compares the generation read after lock acquisition before deleting", () => {
  const f = fixture();
  const brokerFile = `${f.brokerDir}/broker.json`;
  const original = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket" };
  const replacement = { ...original, generation: "replacement" };
  f.files.set(brokerFile, Buffer.from(JSON.stringify(original)));
  f.files.delete(`${f.brokerDir}/broker.lock`);
  f.context.fs.existsSync = name => f.files.has(name);
  f.context.loadBrokerSession = f.readStoredSession;
  const writeFile = f.context.fs.writeFileSync;
  f.context.fs.writeFileSync = (name, bytes, options) => {
    writeFile(name, bytes, options);
    if (name.endsWith("broker.lock")) f.files.set(brokerFile, Buffer.from(JSON.stringify(replacement)));
  };
  assert.equal(f.original.clearBrokerSession("/repo", original), false);
  assert.deepEqual(JSON.parse(f.files.get(brokerFile).toString()), replacement);
  assert.equal(f.calls.removed.includes(brokerFile), false);
});

test("idle cleanup rechecks migration after shutdown acknowledgement before marking or deleting", async () => {
  const f = fixture();
  const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket",
    ownedGroup: { pgid: 456, generation: "generation", platform: "linux" } };
  f.context.loadBrokerSession = () => session;
  f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: "/session/broker.pid", log: "/session/broker.log" });
  f.context.requestIdleBrokerShutdown = async () => { f.faults.migration = "migration became invalid"; return true; };
  f.context.recordBrokerShutdown = () => { f.calls.saved.push(session); return "saved"; };
  await assert.rejects(f.context.cleanupIdleBrokerSession("/repo", session), /migration/);
  assert.deepEqual(f.calls.removed, []);
  assert.deepEqual(f.calls.saved, []);
  assert.deepEqual(f.calls.mutations, []);
});

test("startup rechecks migration after endpoint waiting before saving or settling admission", async () => {
  const f = fixture({ ready: true });
  f.context.waitForBrokerEndpoint = async () => { f.faults.migration = "migration became invalid"; return true; };
  const rejected = assert.rejects(f.start(), /migration/);
  await flush(); await f.tick(); await rejected;
  assert.deepEqual(f.calls.saved, []);
  assert.deepEqual(f.calls.removed, []);
  assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned"]);
});

test("ensure rechecks migration after admission waiting before acquiring a broker lock", async () => {
  const f = fixture();
  f.context.readBrokerAdmission = () => ({ pending: { generation: "pending" } });
  f.context.waitForBrokerAdmission = async () => { f.faults.migration = "migration became invalid"; };
  f.context.acquireBrokerLock = () => { throw new Error("unexpected lock acquisition"); };
  await assert.rejects(f.context.ensureBrokerSession("/repo"), /migration/);
  assert.deepEqual(f.calls.mutations, []);
  assert.deepEqual(f.calls.removed, []);
  assert.deepEqual(f.calls.spawned, []);
});

for (const route of ["existing", "rival", "current"]) {
  test(`broker reuse rechecks migration after endpoint waiting: ${route}`, async () => {
    const f = fixture();
    const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket", authMode: "browser" };
    f.files.set(`${f.brokerDir}/broker-admission.jsonl`, confirmedSession(session));
    let reads = 0;
    f.context.loadBrokerSession = () => route === "rival" && ++reads === 1 ? null : session;
    if (route === "rival") f.context.acquireBrokerLock = () => null;
    f.context.isBrokerEndpointReady = async () => { f.faults.migration = "migration became invalid"; return true; };
    const invoke = () => route === "current" ? f.start() : f.context.ensureBrokerSession("/repo");
    await assert.rejects(invoke, /migration/);
    assert.deepEqual(f.calls.saved, []);
    assert.deepEqual(f.calls.spawned, []);
    assert.deepEqual(f.calls.mutations, []);
    assert.deepEqual(f.calls.removed, []);
  });
}

// admission確認→broker.json読取り→endpoint待機の間に別ownerが公開し得る。
// 未settled世代や待機後の別PID/endpoint/generationを既存brokerとして採用してはいけない。
for (const race of ["pre-read-pending", "post-ready-pending", "generation", "endpoint", "pid", "lock-held"]) {
  test(`existing broker adoption revalidates settled admission and identity under its lock: ${race}`, async () => {
    const f = fixture({ ready: true });
    const file = `${f.brokerDir}/broker.json`, journal = `${f.brokerDir}/broker-admission.jsonl`;
    const session = { epoch: EPOCH, pid: 456, generation: "candidate", endpoint: "unix:/candidate/socket", authMode: "browser" };
    f.files.set(file, Buffer.from(JSON.stringify(session))); f.files.set(journal, confirmedSession(session)); f.files.delete(`${f.brokerDir}/broker.lock`);
    const pending = () => f.files.set(journal, Buffer.from(JSON.stringify({ version: 2, epoch: EPOCH, event: "pending", generation: "candidate",
      ownerPid: 777, platform: "linux", lockToken: "peer", endpoint: session.endpoint, sessionDir: "/candidate",
      pidFile: "/candidate/broker.pid", logFile: "/candidate/broker.log" }) + "\n"));
    f.context.loadBrokerSession = () => { if (race === "pre-read-pending") pending(); return f.readStoredSession("/repo"); };
    f.context.isBrokerEndpointReady = async () => {
      if (race === "post-ready-pending") pending();
      if (["generation", "endpoint", "pid"].includes(race)) {
        f.files.set(file, Buffer.from(JSON.stringify({ ...session, [race]: race === "pid" ? 999 : "replacement" })));
      }
      if (race === "lock-held") f.files.set(`${f.brokerDir}/broker.lock`, Buffer.from("peer-lock"));
      return true;
    };
    await assert.rejects(f.context.ensureBrokerSession("/repo"), /admission|pending|generation|identity|unconfirmed|locked/i);
    assert.deepEqual(f.calls.spawned, []); assert.deepEqual(f.calls.saved, []);
    assert.equal(f.files.has(file), true);
    if (race === "lock-held") assert.equal(f.files.get(`${f.brokerDir}/broker.lock`).toString(), "peer-lock");
  });
}

for (const route of ["existing", "rival", "current-held"]) {
  test(`a settled unchanged broker is adopted with a fresh locked identity check: ${route}`, async () => {
    const f = fixture({ ready: true });
    const session = { epoch: EPOCH, pid: 456, generation: "settled", endpoint: "unix:/settled/socket", authMode: "browser" };
    f.files.set(`${f.brokerDir}/broker.json`, Buffer.from(JSON.stringify(session)));
    f.files.set(`${f.brokerDir}/broker-admission.jsonl`, confirmedSession(session));
    if (route !== "current-held") f.files.delete(`${f.brokerDir}/broker.lock`);
    let reads = 0, acquires = 0, lockedChecks = 0;
    f.context.loadBrokerSession = () => route === "rival" && ++reads === 1 ? null : f.readStoredSession("/repo");
    if (route === "rival") {
      const acquire = f.context.acquireBrokerLock;
      f.context.acquireBrokerLock = cwd => ++acquires === 1 ? null : acquire(cwd);
    }
    const settled = f.context.requireSettledBrokerAdmission;
    f.context.requireSettledBrokerAdmission = cwd => {
      assert.ok(f.files.has(`${f.brokerDir}/broker.lock`), "adoption checks require broker lock ownership");
      lockedChecks++; return settled(cwd);
    };
    const result = await (route === "current-held" ? f.start() : f.context.ensureBrokerSession("/repo"));
    assert.equal(result.generation, session.generation); assert.equal(result.endpoint, session.endpoint); assert.equal(result.pid, session.pid);
    assert.ok(lockedChecks > (route === "current-held" ? 1 : 0), "the check must happen after endpoint waiting");
    assert.deepEqual(f.calls.spawned, []); assert.deepEqual(f.calls.saved, []);
  });
}

// nullはACP callerのdirect起動へ進む。fallback判定時にも新しいpending admissionを無視しない。
for (const reason of ["ready-false", "auth-mismatch"]) test(`broker fallback rechecks fresh admission before returning null: ${reason}`, async () => {
  const f = fixture(); const session = { epoch: EPOCH, pid: 456, generation: "pending-fallback", endpoint: "unix:/pending-fallback/socket",
    authMode: reason === "auth-mismatch" ? "api-key" : "browser" };
  const pending = () => f.files.set(`${f.brokerDir}/broker-admission.jsonl`, Buffer.from(JSON.stringify({ version: 2, epoch: EPOCH, event: "pending",
    generation: session.generation, ownerPid: 777, platform: "linux", lockToken: "peer", endpoint: session.endpoint,
    sessionDir: "/pending", pidFile: "/pending/pid", logFile: "/pending/log" }) + "\n"));
  f.context.loadBrokerSession = () => { if (reason === "auth-mismatch") pending(); return session; };
  f.context.isBrokerEndpointReady = async () => { pending(); return false; };
  await assert.rejects(f.context.ensureBrokerSession("/repo"), /admission|pending|unconfirmed/i);
  assert.deepEqual(f.calls.spawned, []); assert.deepEqual(f.calls.saved, []); assert.deepEqual(f.calls.removed, []);
});

test("idle cleanup rechecks migration after exit waiting before deleting artifacts", async () => {
  const f = fixture();
  const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "unix:/session/socket", shutdownAcceptedGeneration: "generation",
    ownedGroup: { pgid: 456, generation: "generation", platform: "linux" } };
  f.context.loadBrokerSession = () => session;
  f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: "/session/broker.pid", log: "/session/broker.log" });
  let probes = 0;
  f.context.process.kill = () => {
    if (++probes === 1) return true;
    f.faults.migration = "migration became invalid";
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const rejected = assert.rejects(f.context.cleanupIdleBrokerSession("/repo", session), /migration/);
  await flush(); await f.tick(); await rejected;
  assert.deepEqual(f.calls.removed, []);
  assert.deepEqual(f.calls.mutations, []);
});

test("POSIX startup failure signals only its detached owned group from a timer", async () => {
  const f = fixture();
  const result = f.start(); await flush(); await f.tick();
  assert.equal(await result, null);
  assert.equal(f.calls.spawned[0].detached, true);
  assert.deepEqual(f.calls.groups, [{ pid: -456, signal: "SIGTERM" }]);
  assert.deepEqual(f.calls.numeric, []); assert.deepEqual(f.calls.queries, []);
  assert.equal(f.calls.removed.includes("/session/broker.log"), false);
});

for (const state of ["exit-event", "exit-code-before-event", "signal-before-event", "pid-replaced", "previously-signaled"]) {
  test(`POSIX startup does not signal a reused/unowned PID: ${state}`, async () => {
    const f = fixture();
    const result = f.start(); await flush();
    if (state === "exit-event") { f.child.exitCode = 0; f.child.emit("exit", 0, null); }
    if (state === "exit-code-before-event") f.child.exitCode = 0;
    if (state === "signal-before-event") f.child.signalCode = "SIGTERM";
    if (state === "pid-replaced") f.child.pid = 999;
    if (state === "previously-signaled") f.child.killed = true;
    const settled = result.then((value) => ({ value }), (error) => ({ error }));
    for (let index = 0; index < 80; index += 1) await f.tick();
    const outcome = await settled;
    if (["pid-replaced", "previously-signaled"].includes(state)) assert.match(outcome.error?.message ?? "", /not.*(?:confirm|stop)|unconfirmed/i);
    else assert.equal(outcome.value, null);
    assert.deepEqual(f.calls.groups, []); assert.deepEqual(f.calls.numeric, []); assert.deepEqual(f.calls.queries, []);
  });
}

for (const onSignal of ["ignore", "throw"]) {
  test(`POSIX startup retains recovery evidence if child stop is unconfirmed: ${onSignal}`, async () => {
    const f = fixture({ onSignal }); const result = f.start();
    const rejected = assert.rejects(result, /not.*(?:confirm|stop)|unconfirmed/i);
    await flush(); for (let index = 0; index < 80; index += 1) await f.tick();
    await rejected;
    assert.deepEqual(f.calls.removed, []); assert.deepEqual(f.calls.numeric, []); assert.deepEqual(f.calls.queries, []);
  });
}

test("ready broker is saved without stopping its child/group", async () => {
  const f = fixture({ ready: true }); assert.ok(await f.start());
  assert.equal(f.calls.saved.length, 1); assert.deepEqual(f.calls.groups, []); assert.deepEqual(f.calls.numeric, []);
  assert.equal(f.calls.saved[0].ownedGroup?.pgid, 456);
  assert.equal(f.calls.saved[0].ownedGroup?.generation, f.calls.saved[0].generation);
});

for (const scenario of ["group-alive", "group-denied", "group-gone", "legacy", "manual", "win32-unconfirmed", "win32-confirmed", "win32-wrong-proof", "generation-changed", "ack-superseded", "deadline-at-proof"]) {
  test(`idle shutdown requires owned group absence before removing records: ${scenario}`, async () => {
    const f = fixture({ platform: scenario.startsWith("win32") ? "win32" : "linux" });
    const session = { epoch: EPOCH, endpoint: "unix:/session/socket", sessionDir: "/session", pidFile: "/session/broker.pid",
      logFile: "/session/broker.log", pid: 456, generation: "generation", shutdownAcceptedGeneration: "generation",
      ownerPlatform: scenario.startsWith("win32") ? "win32" : "linux",
      ownedGroup: { pgid: scenario === "manual" ? 999 : 456, generation: "generation", platform: "linux" } };
    if (scenario === "win32-confirmed") session.shutdownAgentTerminatedGeneration = "generation";
    if (scenario === "win32-wrong-proof") session.shutdownAgentTerminatedGeneration = "other";
    if (scenario === "legacy") delete session.ownedGroup;
    if (scenario === "group-gone") f.files.set(`${f.brokerDir}/broker-admission.jsonl`, confirmedSession(session));
    if (scenario === "ack-superseded") {
      delete session.shutdownAcceptedGeneration;
      f.context.requestIdleBrokerShutdown = async () => true;
      f.context.recordBrokerShutdown = () => "superseded";
    }
    let reads = 0;
    f.context.loadBrokerSession = () => ++reads > 1 && scenario === "generation-changed" ? { ...session, generation: "rival" } : session;
    f.context.brokerCleanupPaths = () => ({ dir: "/session", pid: session.pidFile, log: session.logFile, socket: "/session/socket" });
    f.context.clearBrokerSessionWithin = () => true;
    f.context.process.kill = (pid, signal) => {
      assert.equal(signal, 0); f.calls.probes.push(pid);
      if (pid < 0 && scenario === "deadline-at-proof") f.context.performance.now = () => 101;
      if (pid < 0 && scenario === "group-alive") return true;
      if (pid < 0 && scenario === "group-denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    const result = f.context.cleanupIdleBrokerSession("/repo", session, { timeoutMs: 100 });
    await flush(); for (let index = 0; index < 12; index += 1) await f.tick();
    const expected = ["group-gone", "win32-confirmed"].includes(scenario);
    assert.equal(await result, expected);
    if (!expected) assert.deepEqual(f.calls.removed, []);
    if (scenario === "group-gone") {
      assert.ok(f.calls.probes.includes(-456));
      assert.deepEqual(f.calls.removed, [], "POSIX broker artifacts remain as evidence");
    }
  });
}

test("Windows Job termination proof is persisted only for the matching broker generation", () => {
  const f = fixture({ platform: "win32" });
  const session = { epoch: EPOCH, pid: 456, generation: "generation", endpoint: "pipe:owned", ownerPlatform: "win32" };
  f.context.loadBrokerSession = () => session;
  f.context.acquireBrokerLock = () => "lock"; f.context.releaseBrokerLock = () => {};
  assert.equal(f.context.recordBrokerAgentStopped("/repo", session), "saved");
  assert.equal(f.calls.saved[0].shutdownAgentTerminatedGeneration, session.generation);
  f.context.loadBrokerSession = () => ({ ...session, generation: "rival" });
  assert.equal(f.context.recordBrokerAgentStopped("/repo", session), "superseded");
  assert.equal(f.calls.saved.length, 1);
});

test("failed spawn is observed without signaling an unknown PID", async () => {
  const f = fixture(); f.child.pid = undefined;
  f.context.waitForBrokerEndpoint = async () => {
    f.child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    return false;
  };
  const result = f.start(); await flush(); for (let index = 0; index < 4; index += 1) await f.tick();
  assert.equal(await result, null); assert.deepEqual(f.calls.groups, []); assert.deepEqual(f.calls.numeric, []);
});

test("Windows startup failure preserves a durable unresolved record and log", async () => {
  const f = fixture({ platform: "win32" }); await assert.rejects(f.start(), /unconfirmed|not.*confirm/i);
  assert.deepEqual(f.calls.numeric, []); assert.deepEqual(f.calls.groups, []);
  assert.equal(f.calls.ownedHandleStops, 1);
  assert.equal(f.calls.removed.includes("/session/broker.log"), false);
});

const journalFile = f => `${f.brokerDir}/broker-admission.jsonl`;
const records = (f) => f.files.get(journalFile(f))?.toString().trim().split("\n").map((line) => JSON.parse(line)) ?? [];
async function rejectAdmission(f, pattern = /pending|unconfirmed|admission|journal/i) {
  const rejected = assert.rejects(f.context.ensureBrokerSession("/repo"), pattern);
  await flush(); for (let index = 0; index < 80; index += 1) await f.tick(); await rejected;
}

// 失敗条件: Windowsの所有handle終了を配下agentの停止証明へ昇格し、stopped/confirmedや
// 次のbroker/direct開始を許可してしまう。初回のlock解放後も同じpending世代を保全する。
test("Windows unconfirmed agent termination retains pending spawn records and rejects reentry", async () => {
  const f = fixture({ platform: "win32" }); f.files.delete(`${f.brokerDir}/broker.lock`);
  let generation = 0; f.context.randomUUID = () => `windows-owner-${++generation}`;
  await assert.rejects(f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }), /unconfirmed.*pending/i);
  const before = Buffer.from(f.files.get(journalFile(f)));
  const rows = records(f);
  assert.deepEqual(rows.map(record => record.event), ["pending", "spawned"]);
  assert.equal(rows[0].platform, "win32"); assert.equal(rows[1].pgid, null);
  assert.equal(rows[1].generation, rows[0].generation);
  assert.equal(f.context.parseBrokerAdmission(before).pending.generation, rows[0].generation);
  assert.equal(f.child.signalCode, "SIGTERM", "the owned child handle exited without proving agent termination");
  assert.equal(f.calls.ownedHandleStops, 1);
  assert.equal(f.files.has(`${f.brokerDir}/broker.lock`), false, "reentry rejection must come from the journal");
  let directStarts = 0;
  const next = f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }).then(session => {
    if (session === null) directStarts++;
    return session;
  });
  await assert.rejects(next, /pending|unconfirmed/i);
  assert.deepEqual(f.files.get(journalFile(f)), before);
  assert.equal(f.calls.spawned.length, 1); assert.equal(directStarts, 0);
  assert.equal(f.calls.ownedHandleStops, 1);
  assert.deepEqual(f.calls.numeric, []); assert.deepEqual(f.calls.groups, []);
  assert.equal(f.calls.removed.includes(journalFile(f)), false);
  assert.equal(f.files.has("/session/broker.log"), true);
});

// 失敗条件: POSIX group停止確認とsettled同期後も、部分confirmedを受理する、または完全な
// confirmedのfsync失敗を未停止扱いにする。書込み失敗は返し、可視な証拠に応じて次回を判定する。
for (const platform of ["linux", "darwin"]) {
for (const fault of ["partialEvent", "fsyncEvent"]) {
  test(`confirmed stopped generation distinguishes partial bytes from full unsynced proof: ${platform}/${fault}`, async () => {
    const f = fixture({ platform, ready: false, groupState: "gone" });
    f.files.delete(`${f.brokerDir}/broker.lock`);
    let generation = 0; f.context.randomUUID = () => `stopped-owner-${++generation}`;
    f.faults[fault] = "confirmed";
    const failed = assert.rejects(f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }), /journal (?:write|fsync)|partial journal/i);
    await flush(); for (let index = 0; index < 8; index++) await f.tick(); await failed;
    const before = Buffer.from(f.files.get(journalFile(f)));
    const text = before.toString();
    const complete = text.slice(0, text.lastIndexOf("\n") + 1).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(complete.slice(0, 3).map(record => record.event), ["pending", "spawned", "settled"]);
    assert.equal(complete[2].outcome, "stopped"); assert.equal(complete[2].pid, 456);
    assert.equal(f.child.signalCode, "SIGTERM");
    assert.deepEqual(f.calls.groups, [{ pid: -456, signal: "SIGTERM" }]);
    assert.ok(f.calls.probes.includes(-456), "stopped requires group-absence evidence beyond child exit");
    assert.equal(f.calls.spawned.length, 1);
    assert.equal(f.files.has(`${f.brokerDir}/broker.lock`), false);
    assert.equal(f.files.has("/session/broker.log"), true);
    f.faults[fault] = null;
    if (fault === "partialEvent") {
      assert.equal(text.endsWith("\n"), false);
      assert.deepEqual(complete.map(record => record.event), ["pending", "spawned", "settled"]);
      await rejectAdmission(f, /incomplete|corrupt|journal/i);
      assert.deepEqual(f.files.get(journalFile(f)), before);
      assert.equal(f.calls.spawned.length, 1);
    } else {
      assert.deepEqual(complete.map(record => record.event), ["pending", "spawned", "settled", "confirmed"]);
      assert.equal(complete[3].outcome, "stopped"); assert.equal(complete[3].generation, complete[2].generation);
      assert.equal(f.context.parseBrokerAdmission(before).pending, null);
      const nextChild = new EventEmitter();
      Object.assign(nextChild, { pid: 789, exitCode: null, signalCode: null, unref() {}, stdio: f.child.stdio });
      f.context.spawn = (_command, _args, options) => { f.calls.spawned.push(options); return nextChild; };
      f.context.waitForBrokerEndpoint = async () => true;
      const session = await f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" });
      assert.equal(session.pid, 789); assert.notEqual(session.generation, complete[0].generation);
      assert.equal(f.calls.spawned.length, 2);
      assert.deepEqual(f.files.get(journalFile(f)).subarray(0, before.length), before);
      assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned", "settled", "confirmed", "pending", "spawned", "settled", "confirmed"]);
      assert.equal(records(f).at(-1).outcome, "ready");
    }
    assert.deepEqual(f.calls.numeric, []);
    assert.deepEqual(f.calls.groups, [{ pid: -456, signal: "SIGTERM" }]);
    assert.equal(f.calls.removed.includes(journalFile(f)), false);
  });
}
}

test("admission journal blocks another broker after an unconfirmed owned group", async () => {
  const f = fixture({ onSignal: "ignore" }); const result = f.start();
  const rejected = assert.rejects(result, /not.*confirm|unconfirmed/i);
  await flush(); for (let index = 0; index < 80; index += 1) await f.tick(); await rejected;
  assert.deepEqual(records(f).map((record) => record.event), ["pending", "spawned"]);
  assert.equal(records(f)[1].pid, 456); assert.equal(records(f)[1].pgid, 456);
  await rejectAdmission(f);
  assert.equal(f.calls.spawned.length, 1);
});

for (const fault of ["write", "fsync"]) {
  test(`admission pending ${fault} failure cannot spawn`, async () => {
    const f = fixture(); f.faults[`${fault}Event`] = "pending";
    const result = f.start(); const rejected = assert.rejects(result);
    await flush(); for (let index = 0; index < 80; index += 1) await f.tick(); await rejected;
    assert.equal(f.calls.spawned.length, 0);
  });
}

for (const fault of ["writeEvent", "fsyncEvent", "partialEvent"]) {
  test(`admission post-spawn ${fault} failure keeps the durable barrier`, async () => {
    const f = fixture(); f.faults[fault] = "spawned";
    const result = f.start(); const rejected = assert.rejects(result);
    await flush(); for (let index = 0; index < 80; index += 1) await f.tick(); await rejected;
    await rejectAdmission(f);
    assert.equal(f.calls.spawned.length, 1);
  });
}

test("ready-state save failure leaves the journal pending across the next admission", async () => {
  const f = fixture({ ready: true }); f.faults.save = true;
  const rejected = assert.rejects(f.start(), /save/);
  await flush(); await f.tick(); await rejected;
  await rejectAdmission(f);
  assert.deepEqual(records(f).map((record) => record.event), ["pending", "spawned"]);
  assert.equal(f.calls.spawned.length, 1);
});

// 完全なsettled行が可視でも、そのfsync失敗とowner停止未確認を成功済みに昇格させない。
// 次回の既存broker採用・direct fallback・新broker生成の全入口を、失敗注入解除後にも止める。
for (const failureStage of ["fsyncEvent", "closeEvent", "directorySyncEvent"]) {
for (const nextRoute of ["ready-adoption", "direct-fallback", "new-broker"]) {
  test(`a fully written but unsynced settlement cannot authorize another execution: ${failureStage}/${nextRoute}`, async () => {
    const f = fixture({ ready: true, onSignal: "ignore", groupState: "alive" });
    f.context.loadBrokerSession = f.readStoredSession;
    f.files.delete(`${f.brokerDir}/broker.lock`);
    let generation = 0; f.context.randomUUID = () => `unique-${++generation}`;
    f.faults[failureStage] = "settled";
    const failed = assert.rejects(f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }), /sync|close/i);
    await flush(); for (let index = 0; index < 90; index++) await f.tick(); await failed;
    assert.equal(f.calls.spawned.length, 1);
    assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
    assert.equal(records(f).at(-1).event, "settled", "the failure follows a complete visible record");
    assert.equal(f.files.has(`${f.brokerDir}/broker.lock`), false, "the first call has released its startup lock");
    f.faults[failureStage] = null;
    if (nextRoute === "new-broker") f.files.delete(`${f.brokerDir}/broker.json`);
    f.context.waitForBrokerEndpoint = async () => nextRoute !== "direct-fallback";
    f.context.isBrokerEndpointReady = async () => nextRoute !== "direct-fallback";
    let directStarts = 0;
    const next = f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }).then(session => {
      if (session === null) directStarts++;
      return session;
    });
    await assert.rejects(next, /pending|unconfirmed|admission|journal|sync/i);
    assert.equal(f.calls.spawned.length, 1); assert.equal(directStarts, 0);
  });
}
}

// confirmedの前提settled fsyncが成功してから確認行を公開する。確認行の失敗後にready ownerを
// teardownすると、完全な確認行を見た別callerの採用と競合するので、原因を返してownerは保全する。
for (const fault of ["writeEvent", "partialEvent", "fsyncEvent", "closeEvent", "directorySyncEvent", "deadlineEvent"]) {
  test(`confirmation failure preserves the ready owner and distinguishes visible proof from partial bytes: ${fault}`, async () => {
    const f = fixture({ ready: true, onSignal: "exit" }); f.context.loadBrokerSession = f.readStoredSession;
    f.files.delete(`${f.brokerDir}/broker.lock`); f.faults[fault] = "confirmed";
    const failed = assert.rejects(f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }), /sync|close|write|timed out|deadline/i);
    await flush(); for (let index = 0; index < 8; index++) await f.tick(); await failed;
    assert.equal(f.calls.spawned.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
    assert.deepEqual(f.calls.groups, []); assert.deepEqual(f.calls.numeric, []);
    f.faults[fault] = null;
    if (["fsyncEvent", "closeEvent", "directorySyncEvent"].includes(fault)) {
      assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned", "settled", "confirmed"]);
      const next = await f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" });
      assert.equal(next.generation, records(f)[0].generation);
    } else if (fault === "deadlineEvent") {
      assert.equal(f.context.parseBrokerAdmission(f.files.get(journalFile(f))).pending, null, "visible confirmation proves the preceding settlement was synced");
      assert.equal(f.files.has(`${f.brokerDir}/broker.lock`), true, "expired owner cannot silently remove its startup lock");
    } else {
      assert.equal(f.files.get(journalFile(f)).toString().endsWith("\n"), fault !== "partialEvent");
      await assert.rejects(f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }), /journal|incomplete|corrupt/i);
    }
    assert.equal(f.calls.spawned.length, 1);
  });
}

test("legacy settlement without durable confirmation cannot be silently accepted", async () => {
  const f = fixture({ ready: true }); f.files.delete(`${f.brokerDir}/broker.lock`);
  const rows = [
    { version: 1, epoch: EPOCH, event: "pending", generation: "legacy-one", ownerPid: 777, platform: "linux", lockToken: "legacy-owner",
      endpoint: "unix:/legacy/socket", sessionDir: "/legacy", pidFile: "/legacy/broker.pid", logFile: "/legacy/broker.log" },
    { version: 1, epoch: EPOCH, event: "spawned", generation: "legacy-one", pid: 789, pgid: 789 },
    { version: 1, epoch: EPOCH, event: "settled", generation: "legacy-one", pid: 789, outcome: "ready" }
  ];
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n"); f.files.set(journalFile(f), bytes);
  await assert.rejects(f.context.ensureBrokerSession("/repo", { scriptPath: "/broker.mjs" }), /legacy|protocol|pending|confirmation|offline/i);
  assert.deepEqual(f.files.get(journalFile(f)), bytes); assert.deepEqual(f.calls.spawned, []);
});

test("pending admission reserves all three bounded continuation records before any spawn", async () => {
  const f = fixture(); const maximum = 4 * 1024 * 1024, recordMaximum = 64 * 1024, target = maximum - 2.5 * recordMaximum;
  const cycle = (index, padding = 0) => {
    const generation = `history-${index}`, pid = index + 1;
    const rows = [
      { version: 2, epoch: EPOCH, event: "pending", generation, ownerPid: pid, platform: "linux", lockToken: `owner-${index}`,
        endpoint: "unix:/" + "x".repeat(Math.min(padding, 30000)), sessionDir: "/history", pidFile: "/history/pid",
        logFile: "/" + "y".repeat(Math.max(0, padding - 30000)) },
      { version: 2, epoch: EPOCH, event: "spawned", generation, pid, pgid: pid },
      { version: 2, epoch: EPOCH, event: "settled", generation, pid, outcome: "ready" },
      { version: 2, epoch: EPOCH, event: "confirmed", generation, pid, outcome: "ready" }
    ];
    return rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  };
  let bytes = "", index = 0;
  while (Buffer.byteLength(bytes) + Buffer.byteLength(cycle(index, 60000)) <= target) bytes += cycle(index++, 60000);
  const remaining = target - Buffer.byteLength(bytes), minimum = Buffer.byteLength(cycle(index));
  if (remaining >= minimum) bytes += cycle(index, remaining - minimum);
  const buffer = Buffer.from(bytes); f.files.set(journalFile(f), buffer);
  assert.ok(maximum - buffer.length > 2 * recordMaximum + 1000 && maximum - buffer.length < 3 * recordMaximum);
  await assert.rejects(f.start(), /no safe capacity/i);
  assert.deepEqual(f.files.get(journalFile(f)), buffer); assert.deepEqual(f.calls.spawned, []);
});

test("confirmed stop and persisted ready states settle without deleting the journal", async () => {
  for (const ready of [true, false]) {
    const f = fixture({ ready }); const result = f.start(); await flush(); await f.tick(); await result;
    assert.deepEqual(records(f).map(record => record.event), ["pending", "spawned", "settled", "confirmed"]);
    assert.equal(records(f).at(-1).outcome, ready ? "ready" : "stopped");
    assert.equal(f.calls.removed.includes(journalFile(f)), false);
  }
});

for (const contents of ["{broken", `${JSON.stringify({ event: "spawned", generation: "foreign", pid: 789 })}\n`, "x".repeat(4 * 1024 * 1024 + 1)]) {
  test(`invalid/oversized admission journal cannot be treated as empty (${contents.length})`, async () => {
    const f = fixture(); f.files.set(journalFile(f), Buffer.from(contents));
    await assert.rejects(f.context.ensureBrokerSession("/repo"), /admission|journal/i);
    assert.equal(f.calls.spawned.length, 0);
  });
}

test("read-only broker status never modifies an unresolved journal", () => {
  const f = fixture(); f.files.set(journalFile(f), Buffer.from("{partial")); const before = Buffer.from(f.files.get(journalFile(f)));
  assert.equal(f.readStoredSession("/repo"), null);
  assert.deepEqual(f.files.get(journalFile(f)), before); assert.equal(f.calls.spawned.length, 0);
});

for (const groupState of ["alive", "denied", "reused"]) {
  for (const exitBeforeStop of [true, false]) {
    test(`POSIX parent exit is insufficient while group is ${groupState}, early=${exitBeforeStop}`, async () => {
      const f = fixture({ groupState }); const result = f.start();
      const rejected = assert.rejects(result, /not.*(?:confirm|stop)|unconfirmed/i);
      await flush();
      if (exitBeforeStop) { f.child.exitCode = 0; f.child.emit("exit", 0, null); }
      for (let index = 0; index < 80; index += 1) await f.tick();
      await rejected;
      assert.ok(f.calls.probes.length > 0);
      assert.equal(f.calls.groups.length, exitBeforeStop ? 0 : 1);
      assert.deepEqual(f.calls.removed, []); assert.deepEqual(f.calls.numeric, []);
    });
  }
}
