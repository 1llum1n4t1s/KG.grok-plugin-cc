import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const direct = source.slice(source.indexOf("class SpawnedAcpClient"), source.indexOf("class BrokerAcpClient"));
for (const platform of ["linux", "darwin"]) for (const phase of ["before-start", "normal-close", "double-close", "fatal-drain", "failed-spawn", "deadline", "save-failed"]) {
  test(`POSIX direct owner proof ${platform}/${phase}`, async () => {
    const timers = [], proofs = [], admissions = [];
    const reservation = {};
    let control, starts = 0;
    const child = new EventEmitter();
    let physicallyClosed = false;
    Object.assign(child, { pid: 42, exitCode: null, signalCode: null, killed: false,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { assert.fail("No direct PID fallback"); }, unref() {} });
    child.on("close", () => { physicallyClosed = true; });
    const context = vm.createContext({ process: { platform, env: {}, kill(pid, signal) {
      assert.equal(pid, -42);
      if (signal === 0) { if (physicallyClosed) throw Object.assign(Error("gone"), { code: "ESRCH" }); return true; }
      assert.equal(signal, "SIGTERM"); child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); return true;
    } },
      spawn: (_command, _args, options) => { starts += 1; if (phase === "failed-spawn") throw Error("spawn failed"); assert.equal(options.detached, true); return child; },
      reserveDirectAdmission: cwd => { assert.equal(cwd, "mock"); assert.equal(starts, 0); admissions.push("reserved"); return reservation; },
      verifyDirectStart: (cwd, token) => { assert.equal(cwd, "mock"); assert.equal(token, reservation); assert.equal(starts, 0); return true; },
      finishDirectStart: (cwd, admission, proof) => { assert.equal(cwd, "mock"); assert.equal(admission, reservation); admissions.push(proof); return true; },
      setTimeout: callback => { timers.push(callback); return { unref() {} }; },
      DIRECT_HANDSHAKE_TIMEOUT_MS: 10, CLOSE_TIMEOUT_MS: 0, withTimeout: promise => promise, createProtocolError: message => Error(message),
      waitForExitWithTimeout: promise => phase === "deadline" ? Promise.resolve() : promise ?? Promise.resolve(),
      AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.closed = false; this.stderr = ""; this.exitPromise = Promise.resolve(); this.framer = { close() {} }; }
        async performInitialize() {} handleExit() { this.exitResolved = true; } }
    });
    vm.runInContext(direct + ";globalThis.connect=connectDirectClient;", context);
    const run = context.connect("mock", { directAgentStarting(owner) {
      control = owner;
      if (phase === "before-start") void owner.close().catch(() => {});
      return { async finish(proof) { proofs.push(proof); if (phase === "save-failed") throw Error("ACK save failed"); return Boolean(proof); } };
    } });
    if (["before-start", "failed-spawn"].includes(phase)) {
      await assert.rejects(run, /closed|spawn failed/);
      assert.equal(starts, phase === "before-start" ? 0 : 1);
      assert.deepEqual(proofs, [phase === "before-start" ? "never-started" : false]);
      assert.deepEqual(admissions, phase === "before-start" ? [] : ["reserved"]);
      return;
    }
    const client = await run;
    assert.deepEqual(admissions, ["reserved", "ready"]);
    assert.ok(control, "POSIX must register its owner before starting the actual child");
    if (phase === "fatal-drain") client.handleExit(Error("fatal protocol"));
    const closing = control.close();
    const duplicate = phase === "double-close" ? control.close() : null;
    for (const callback of timers.splice(0)) callback();
    assert.equal(proofs.length, 0, "exit/signal alone must not persist a positive proof");
    if (phase !== "deadline") child.emit("close", null, "SIGTERM");
    if (phase === "save-failed") {
      await assert.rejects(closing, /ACK save failed/); assert.equal(client.closeStopUnconfirmed, true);
    } else {
      assert.equal(await closing, phase === "deadline" ? false : "posix-group-empty");
      if (duplicate) await duplicate;
    }
    assert.deepEqual(proofs, [phase === "deadline" ? false : "posix-group-empty"]);
  });
}
