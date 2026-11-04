import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { getProcessSnapshot, type runCommand } from "../plugins/grok/scripts/lib/process.mjs";
import { spawnWindowsAgent } from "../plugins/grok/scripts/lib/windows-agent.mjs";
import { windowsHelperPath } from "../plugins/grok/scripts/lib/windows-helper.mjs";

test("Windows process identity accepts only a precise FILETIME response", () => {
  const filetime = "134000000000000001";
  for (const stdout of [filetime, filetime + "\n", filetime + "\r\n", "", "0", "-1", "1.5", "win32-filetime:" + filetime,
    JSON.stringify({ startKey: "win32-filetime:" + filetime }), " " + filetime, filetime + "\nextra", filetime + "\n\n", "123\n456", "1".repeat(20)]) {
    const runCommandImpl: typeof runCommand = (command, args = []) => ({ command, args, status: 0, signal: null, stdout, stderr: "", error: null });
    assert.deepEqual(getProcessSnapshot(123, { runCommandImpl }),
      [filetime, filetime + "\n", filetime + "\r\n"].includes(stdout) ? { startKey: "win32-filetime:" + filetime } : null,
      JSON.stringify(stdout));
  }
});

test("Windows process identity fails closed and preserves safe failure diagnostics", () => {
  for (const failure of ["timeout", "exit", "signal", "throw"] as const) {
    const records: any[] = [];
    let calls = 0;
    const runCommandImpl: typeof runCommand = (command, args = []) => {
      calls += 1;
      if (failure === "throw") throw Object.assign(new Error("private command line"), { code: "ENOENT" });
      return { command, args, status: failure === "exit" ? 1 : 0,
        signal: failure === "signal" ? "SIGTERM" : null,
        stdout: "134000000000000001", stderr: "private command line",
        error: failure === "timeout" ? Object.assign(new Error("private command line"), { code: "ETIMEDOUT" }) : null };
    };
    assert.equal(getProcessSnapshot(123, { runCommandImpl, onProcessLookupDiagnostic: (record) => records.push(record) }), null);
    assert.equal(calls, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "process-lookup");
    assert.equal(records[0].outcome, failure === "throw" ? "error" : failure);
    assert.equal(records[0].lastPhase, failure === "throw" ? "helper-not-returned" : "helper-returned");
    assert.equal(JSON.stringify(records).includes("private command line"), false);
  }
});

test("Windows process identity bounds startup without extending an earlier caller deadline", () => {
  for (const budget of [10000, 400]) {
    let timeout = 0;
    const before = performance.now();
    const runCommandImpl: typeof runCommand = (command, args = [], options = {}) => {
      timeout = options.timeout as number;
      assert.equal(command, windowsHelperPath());
      assert.deepEqual(args, ["identity", "123"]);
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.shell, false);
      return { command, args, status: 0, signal: null, stdout: "134000000000000001", stderr: "", error: null };
    };
    assert.ok(getProcessSnapshot(123, { runCommandImpl,
      ...(budget === 400 ? { processLookupDeadline: before + budget } : {}) }));
    const elapsed = performance.now() - before;
    assert.ok(timeout > 0 && timeout <= budget);
    assert.ok(timeout >= budget - elapsed, "only elapsed lookup time may reduce the timeout");
  }
  let calls = 0;
  const runCommandImpl = (() => { calls += 1; throw new Error("expired lookup must not spawn"); }) as typeof runCommand;
  assert.equal(getProcessSnapshot(123, { runCommandImpl, processLookupDeadline: performance.now() - 1 }), null);
  assert.equal(calls, 0);
});

function fakeSpawn({ acknowledge = true, malformed = false, closeNaturally = false, delayedAck = false, delayedReady = false } = {}) {
  // この fixture は制御プロトコルで利用する ChildProcess の部分だけを実装する。
  return ((command, args, options) => {
    assert.equal(command, windowsHelperPath());
    assert.deepEqual(args, ["supervisor"]);
    assert.equal(options.shell, false);
    assert.equal(args.includes("-ConfigBase64"), false, "control credentials must not appear in the process command line");
    const proc = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; unref: () => void; exitCode?: number };
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.unref = () => {};
    let bootstrap = Buffer.alloc(0);
    proc.stdin.on("data", (chunk) => {
      bootstrap = Buffer.concat([bootstrap, chunk]);
      if (bootstrap.length < 4 || bootstrap.length < 4 + bootstrap.readUInt32LE(0)) return;
      const length = bootstrap.readUInt32LE(0);
      assert.equal(bootstrap.length, length + 4, "ACP must wait until the bootstrap ready ACK");
      const config = JSON.parse(bootstrap.subarray(4).toString("utf8"));
      assert.match(config.ParentStartKey, /^win32-filetime:/);
      assert.match(config.CommandLine, /agent stdio/);
      assert.equal(args.join(" ").includes(config.Nonce), false);
      assert.equal(Object.values(options.env).includes(config.Nonce), false);
      const socket = net.createConnection(`\\\\.\\pipe\\${config.PipeName}`);
    socket.on("connect", () => {
      const ready = () => socket.write(JSON.stringify({ nonce: config.Nonce, state: "ready" }) + "\n");
      if (delayedReady) setTimeout(ready, 120); else ready();
      if (closeNaturally) {
        socket.end(JSON.stringify({ nonce: config.Nonce, state: "stopped", exitCode: 0 }) + "\n");
      }
    });
    socket.on("data", () => {
      const respond = () => {
        if (socket.destroyed) return;
        if (malformed) socket.write("invalid\n");
        else if (acknowledge) socket.write(JSON.stringify({ nonce: config.Nonce, state: "stopped", exitCode: 1 }) + "\n");
        socket.end();
      };
      if (delayedAck) setTimeout(respond, 120);
      else respond();
    });
    socket.on("close", () => { proc.exitCode = 0; proc.emit("close", 0, null); });
    });
    return proc;
  }) as unknown as typeof import('node:child_process').spawn;
}

for (const outcome of ["confirmed", "delayed-ack", "cancel-before-ready", "ack-lost", "malformed", "natural-exit"]) {
  test(`Windows owned agent control preserves stop proof: ${outcome}`, { skip: process.platform !== "win32" }, async () => {
    const owned = await spawnWindowsAgent("C:\\mock", '"C:\\space 日\\grok.cmd"', ["agent", "stdio"], {
      getProcessSnapshotImpl: () => ({ startKey: "win32-filetime:134000000000000001" }),
      spawnImpl: fakeSpawn({ acknowledge: outcome !== "ack-lost", malformed: outcome === "malformed", closeNaturally: outcome === "natural-exit", delayedAck: outcome === "delayed-ack", delayedReady: outcome === "cancel-before-ready" }),
      closeTimeoutMs: 400
    });
    const closing = outcome === "cancel-before-ready" ? owned.close() : null;
    await owned.ready;
    assert.equal(await (closing ?? owned.close()), ["confirmed", "delayed-ack", "cancel-before-ready", "natural-exit"].includes(outcome));
    assert.equal(owned.stopConfirmed, ["confirmed", "delayed-ack", "cancel-before-ready", "natural-exit"].includes(outcome));
  });
}

test("Windows owned agent refuses to spawn without a precise pinned-owner identity", async () => {
  let spawns = 0;
  await assert.rejects(spawnWindowsAgent("mock", "grok", [], { getProcessSnapshotImpl: () => null,
    spawnImpl: (() => { spawns += 1; }) as unknown as typeof import('node:child_process').spawn }), /identity/);
  assert.equal(spawns, 0);
});
