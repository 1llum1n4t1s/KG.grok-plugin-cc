import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const direct = source.slice(source.indexOf("class SpawnedAcpClient"), source.indexOf("async function connectDirectClient"));
function fixture({ spawnFailure = false, remainingGroup = false, groupDenied = false, inherited = false } = {}) {
  let calls = 0;
  const timers = [];
  let finishWait;
  let waits = 0;
  let groupPresent = true;
  let queries = 0;
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, killed: false,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal) { assert.equal(inherited, true); assert.equal(signal, "SIGTERM"); calls += 1; return true; }, unref() {} });
  child.on("close", () => { if (!remainingGroup) groupPresent = false; });
  const context = vm.createContext({ process: { platform: "linux", env: {}, kill(pid, signal) {
    assert.equal(pid, -123);
    if (signal === 0) { queries += 1; if (groupDenied) throw Object.assign(Error("denied"), { code: "EPERM" }); if (!groupPresent) throw Object.assign(Error("gone"), { code: "ESRCH" }); return true; }
    assert.equal(signal, "SIGTERM"); calls += 1; return true;
  } },
    spawn: (_command, _args, options) => { if (spawnFailure) throw Error("spawn failed"); assert.equal(options.detached, !inherited); return child; }, setTimeout: callback => { timers.push(callback); return { unref() {} }; },
    withTimeout: promise => promise, DIRECT_HANDSHAKE_TIMEOUT_MS: 100, CLOSE_TIMEOUT_MS: 0,
    waitForExitWithTimeout: () => { waits += 1; return new Promise(resolve => { finishWait = resolve; }); },
    AcpClientBase: class {
      constructor(cwd, options) { this.cwd = cwd; this.options = options; this.framer = { close() {} }; this.stderr = ""; }
      async performInitialize() {} handleChunk() {} handleExit() { this.exitResolved = true; }
    } });
  vm.runInContext(direct + ";globalThis.Direct=SpawnedAcpClient;", context);
  const client = new context.Direct("mock", inherited ? { posixGroupMode: "inherit" } : {});
  return { client, child, calls: () => calls, queries: () => queries, waits: () => waits, runTimers: () => { for (const timer of timers.splice(0)) timer(); }, finishWait: () => finishWait() };
}

test("POSIX stop refuses a process reference not returned by this client's spawn", async () => {
  const f = fixture(); f.client.proc = f.child;
  const closing = f.client.close(); await Promise.resolve(); f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.calls(), 0);
  assert.equal(f.client.closeStopUnconfirmed, true);
});

test("POSIX stop targets its registered live child only from the timer phase", async () => {
  const f = fixture(); await f.client.initialize();
  const closing = f.client.close();
  assert.equal(f.calls(), 0, "close or another child's exit callback must never signal synchronously");
  await Promise.resolve();
  f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.calls(), 1);
  assert.equal(f.client.closeStopUnconfirmed, true, "successful signal delivery is not an exit confirmation");
});

test("POSIX observed exit forbids later signal even while final stdio is draining", async () => {
  const f = fixture(); await f.client.initialize();
  const closing = f.client.close();
  await Promise.resolve();
  f.child.emit("exit", 0, null);
  f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.calls(), 0);
  assert.equal(f.client.closeStopUnconfirmed, true, "exit alone does not imply stdout/stderr close");
});

test("POSIX reap callback window finishes before a queued stop timer", async () => {
  const f = fixture(); await f.client.initialize();
  // libuvは複数childをreapした後にexit callbackを配送する。別childからcloseを呼ぶ。
  const other = new EventEmitter(); let closing;
  other.on("exit", () => { closing = f.client.close(); });
  other.emit("exit");
  assert.equal(f.calls(), 0);
  await Promise.resolve();
  f.child.exitCode = 0; f.child.emit("exit", 0, null); f.child.emit("close", 0, null);
  f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.calls(), 0);
  assert.notEqual(f.client.closeStopUnconfirmed, true);
});

test("POSIX stop cannot follow a replaced process property to another child", async () => {
  const f = fixture(); await f.client.initialize();
  const closing = f.client.close(); await Promise.resolve(); let otherKills = 0;
  f.client.proc = { pid: 456, exitCode: null, killed: false, kill() { otherKills += 1; }, unref() {} };
  f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.calls(), 0); assert.equal(otherKills, 0);
});

test("POSIX protocol-fatal completion is not physical child closure", async () => {
  const f = fixture(); await f.client.initialize();
  f.client.handleExit(Error("fatal frame"));
  const closing = f.client.close(); await Promise.resolve(); f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.client.closeStopUnconfirmed, true);
});

test("POSIX duplicate close shares one physical exit wait and deadline", async () => {
  const f = fixture(); await f.client.initialize();
  const first = f.client.close(), second = f.client.close();
  await Promise.resolve();
  assert.equal(f.waits(), 1);
  f.child.emit("exit", 0, null); f.child.emit("close", 0, null);
  f.runTimers(); f.finishWait(); await Promise.all([first, second]);
  assert.notEqual(f.client.closeStopUnconfirmed, true);
});

test("POSIX synchronous spawn failure has no process to signal or claim", async () => {
  const f = fixture({ spawnFailure: true });
  await assert.rejects(f.client.initialize(), /spawn failed/);
  await f.client.close();
  assert.equal(f.calls(), 0);
  assert.notEqual(f.client.closeStopUnconfirmed, true);
  assert.equal(f.client.directAgentStopProof(), false);
});

for (const limitation of ["remainingGroup", "groupDenied"]) {
  test(`POSIX group closure stays pending when ${limitation}`, async () => {
    const f = fixture({ [limitation]: true }); await f.client.initialize();
    const closing = f.client.close(); await Promise.resolve(); f.runTimers();
    f.child.emit("exit", 0, null); f.child.emit("close", 0, null); f.finishWait(); await closing;
    assert.equal(f.calls(), 1); assert.ok(f.queries() > 0);
    assert.equal(f.client.closeStopUnconfirmed, true);
    assert.equal(f.client.directAgentStopProof(), false);
  });
}

// brokerは自身のowned groupへagentを残す。agentから親groupへsignalを返してはいけない。
test("broker agent inherits its broker group and only signals its live direct child", async () => {
  const f = fixture({ inherited: true }); await f.client.initialize();
  const closing = f.client.close();
  assert.equal(f.calls(), 0);
  await Promise.resolve();
  f.runTimers();
  f.child.emit("exit", 0, null); f.child.emit("close", 0, null); f.finishWait(); await closing;
  assert.equal(f.calls(), 1);
  assert.equal(f.queries(), 0, "inherited group is not owned by the agent client");
  assert.equal(f.client.directAgentStopProof(), false);
  assert.equal(f.client.closeStopUnconfirmed, true, "root close cannot prove inherited group empty");
});

test("broker agent inherited mode never signals after observed exit", async () => {
  const f = fixture({ inherited: true }); await f.client.initialize();
  const closing = f.client.close();
  await Promise.resolve();
  f.child.exitCode = 0; f.child.emit("exit", 0, null); f.child.emit("close", 0, null);
  f.runTimers(); f.finishWait(); await closing;
  assert.equal(f.calls(), 0); assert.equal(f.queries(), 0);
  assert.equal(f.client.directAgentStopProof(), false);
});

test("broker connect explicitly keeps POSIX agent inside the owned startup group", () => {
  const broker = fs.readFileSync(new URL("../plugins/grok/scripts/acp-broker.mjs", import.meta.url), "utf8");
  assert.match(broker, /GrokAcpClient\.connectBrokerOwned\(cwd,\s*\{[^}]*posixGroupMode:\s*"inherit"/);
});

for (const failure of ["pending", "throw"]) {
  test(`broker shutdown retains PID evidence when agent cleanup is ${failure}`, async () => {
    const broker = fs.readFileSync(new URL("../plugins/grok/scripts/acp-broker.mjs", import.meta.url), "utf8");
    const shutdown = broker.slice(broker.indexOf("  async function shutdown(server)"), broker.indexOf("  const server = net.createServer"));
    let deletions = 0;
    let flushed = false;
    const socket = new EventEmitter();
    socket.end = callback => { queueMicrotask(() => { flushed = true; callback(); }); };
    const context = vm.createContext({ sockets: [socket], shutdownPromise: null, closing: false,
      process: { platform: "darwin" }, setTimeout, clearTimeout,
      agent: { closeStopUnconfirmed: failure === "pending", async close() { if (failure === "throw") throw Error("lost stop proof"); } },
      listenTarget: { kind: "unix", path: "owned socket" }, pidFile: "owned pid",
      fs: { existsSync: () => true, unlinkSync: () => { deletions += 1; } }
    });
    vm.runInContext(shutdown + ";globalThis.shutdown=shutdown;", context);
    await context.shutdown({ close() { assert.fail("POSIX listener path must be retained"); } });
    assert.equal(flushed, true);
    assert.equal(deletions, 0);
  });
}

for (const outcome of ["saved", "locked-then-saved", "locked", "superseded", "unsupported", "throw", "no-proof", "pending"]) {
  test(`Windows broker shutdown saves scoped durable Job stop proof: ${outcome}`, async () => {
    const broker = fs.readFileSync(new URL("../plugins/grok/scripts/acp-broker.mjs", import.meta.url), "utf8");
    const shutdown = broker.slice(broker.indexOf("  async function shutdown(server)"), broker.indexOf("  const server = net.createServer"));
    let deletions = 0, saves = 0, now = 0;
    const events = [];
    const context = vm.createContext({ sockets: [], shutdownPromise: null, closing: false, cwd: "owned cwd", generation: "owned generation", endpoint: "owned endpoint",
      process: { platform: "win32", pid: 321 }, performance: { now: () => now },
      setTimeout(callback, ms) { now += ms; queueMicrotask(callback); },
      agent: { closeStopUnconfirmed: outcome === "pending", directAgentStopProof: () => outcome === "no-proof" ? false : "job-empty",
        async close() { events.push("closed"); } },
      recordBrokerAgentStopped(cwd, session) {
        assert.equal(cwd, "owned cwd"); assert.equal(session.generation, "owned generation");
        assert.equal(session.pid, 321); assert.equal(session.endpoint, "owned endpoint");
        assert.deepEqual(events, ["closed"]); saves += 1;
        if (outcome === "throw") throw Error("fsync failed");
        if (outcome === "locked-then-saved") return saves === 1 ? "locked" : "saved";
        return outcome;
      },
      listenTarget: { kind: "pipe" }, pidFile: "owned pid",
      fs: { existsSync: () => true, unlinkSync: () => { deletions += 1; } }
    });
    vm.runInContext(shutdown + ";globalThis.shutdown=shutdown;", context);
    await context.shutdown({ close(resolve) { resolve(); } });
    if (outcome === "saved" || outcome === "locked-then-saved") {
      assert.equal(deletions, 1); assert.equal(saves, outcome === "saved" ? 1 : 2);
    } else {
      assert.equal(deletions, 0);
      if (["pending", "no-proof"].includes(outcome)) assert.equal(saves, 0);
      if (outcome === "locked") { assert.ok(saves > 1 && saves <= 11); assert.ok(now <= 100); }
    }
  });
}
