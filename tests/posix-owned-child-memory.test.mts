import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";

const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const direct = source.slice(source.indexOf("class SpawnedAcpClient"), source.indexOf("export class GrokAcpClient"));
function fixture({ spawnFailure = false, remainingGroup = false, groupDenied = false, inherited = false } = {}) {
  const stopRequests: string[] = [];
  let unexpectedSignals = 0;
  const timers = [];
  let finishWait;
  let waits = 0;
  let groupPresent = true;
  let queries = 0;
  const lifeline = new Duplex({ read() {}, write(chunk, _encoding, callback) { stopRequests.push(chunk.toString()); callback(); } });
  const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; killed: boolean; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; stdio: Duplex[]; kill(signal: string): boolean; unref(): void };
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, killed: false,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, lifeline],
    kill() { unexpectedSignals += 1; return true; }, unref() {} });
  child.on("close", () => { if (!remainingGroup) groupPresent = false; });
  const context = vm.createContext({ POSIX_AGENT_SUPERVISOR: "/supervisor.mjs", process: { platform: "linux", execPath: "/node", versions: process.versions, env: {}, kill(pid, signal) {
    if (pid !== -123 || signal !== 0) { unexpectedSignals += 1; return true; }
    queries += 1;
    if (groupDenied) throw Object.assign(Error("denied"), { code: "EPERM" });
    if (!groupPresent) throw Object.assign(Error("gone"), { code: "ESRCH" });
    return true;
  } },
    childProcess: { spawn: (command, args, options) => { if (spawnFailure) throw Error("spawn failed"); assert.equal(command, "/node"); assert.deepEqual(Array.from(args), [...(process.versions.bun ? ["--no-env-file"] : []), "/supervisor.mjs", "grok", "agent", "stdio"]); assert.equal(options.detached, !inherited); assert.equal(options.stdio[3], "pipe"); return child; } }, setTimeout: callback => { timers.push(callback); return { unref() {} }; },
    withTimeout: promise => promise, DIRECT_HANDSHAKE_TIMEOUT_MS: 100, CLOSE_TIMEOUT_MS: 0,
    waitForExitWithTimeout: () => { waits += 1; return new Promise(resolve => { finishWait = resolve; }); },
    AcpClientBase: class {
      cwd: string; options: { posixGroupMode?: string }; framer: { close(): void }; stderr: string; exitResolved?: boolean;
      constructor(cwd, options) { this.cwd = cwd; this.options = options; this.framer = { close() {} }; this.stderr = ""; }
      async performInitialize() {} handleChunk() {} handleExit() { this.exitResolved = true; }
    } });
  vm.runInContext(direct + ";globalThis.Direct=SpawnedAcpClient;", context);
  const client = new context.Direct("mock", inherited ? { posixGroupMode: "inherit" } : {});
  return { client, child, calls: () => { assert.equal(unexpectedSignals, 0); assert.ok(stopRequests.every(request => request === "stop\n")); return stopRequests.length; }, queries: () => queries, waits: () => waits, runTimers: () => { for (const timer of timers.splice(0)) timer(); }, finishWait: () => { assert.equal(unexpectedSignals, 0); assert.ok(stopRequests.every(request => request === "stop\n")); finishWait(); } };
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
  assert.equal(f.child.stdio[3].destroyed, true, "the lifeline must not keep the caller alive after an unconfirmed stop");
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
});

for (const limitation of ["remainingGroup", "groupDenied"]) {
  test(`POSIX group closure stays pending when ${limitation}`, async () => {
    const f = fixture({ [limitation]: true }); await f.client.initialize();
    const closing = f.client.close(); await Promise.resolve(); f.runTimers();
    f.child.emit("exit", 0, null); f.child.emit("close", 0, null); f.finishWait(); await closing;
    assert.equal(f.calls(), 1); assert.ok(f.queries() > 0);
    assert.equal(f.client.closeStopUnconfirmed, true);
    });
}
