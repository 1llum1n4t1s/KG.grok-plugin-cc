import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";

const options = { skip: process.platform === "win32", timeout: 20000 };
test("POSIX nonexistent cwd preserves ENOENT without an unhandled child error", options, async () => {
  const missing = path.join(os.tmpdir(), `grok-missing-cwd-${randomUUID()}`);
  assert.equal(fs.existsSync(missing), false);
  await assert.rejects(GrokAcpClient.connectForeground(missing, { grokBin: "/missing-grok", env: {} }), (error: NodeJS.ErrnoException & { turnStopUnconfirmed?: boolean }) => {
    assert.equal(error.code, "ENOENT");
    assert.notEqual(error.turnStopUnconfirmed, true);
    return true;
  });
});

for (const scenario of ["error-close", "error-no-close", "close-error", "spawn-no-pid-error-close", "pid-error-close", "pid-spawn-close", "pid-group-unknown"]) {
  test(`POSIX missing pipes retains startup and closure evidence: ${scenario}`, options, async () => {
    const originalSpawn = childProcess.spawn, originalKill = process.kill;
    const error = Object.assign(new Error("fixture spawn ENOENT"), { code: "ENOENT" });
    const hasPid = scenario.startsWith("pid-");
    const child = Object.assign(new EventEmitter(), {
      pid: hasPid ? 424242 : undefined, exitCode: null, signalCode: null, killed: false,
      stdin: hasPid ? new PassThrough() : null, stdout: hasPid ? new PassThrough() : null,
      stderr: hasPid ? new PassThrough() : null, stdio: [null, null, null, null], unref() {}
    });
    let queries = 0;
    childProcess.spawn = (() => {
      setImmediate(() => {
        const close = () => { child.exitCode = 1; child.emit("close", 1, null); };
        if (scenario === "close-error") { close(); child.emit("error", error); return; }
        if (scenario.includes("spawn")) child.emit("spawn");
        if (!scenario.includes("spawn-close") && scenario !== "pid-group-unknown") child.emit("error", error);
        if (scenario !== "error-no-close") close();
      });
      return child;
    }) as unknown as typeof childProcess.spawn;
    process.kill = ((pid, signal) => {
      assert.equal(pid, -424242);
      assert.equal(signal, 0, "missing pipes never authorize a PID-based stop");
      queries++;
      throw Object.assign(new Error("fixture group observation"), { code: scenario === "pid-group-unknown" ? "EPERM" : "ESRCH" });
    }) as typeof process.kill;
    try {
      await assert.rejects(GrokAcpClient.connectForeground("mock", { env: {} }), (failure: Error & { turnStopUnconfirmed?: boolean }) => {
        if (["error-close", "error-no-close", "pid-error-close"].includes(scenario)) assert.equal(failure, error);
        const unconfirmed = ["error-no-close", "close-error", "spawn-no-pid-error-close", "pid-group-unknown"].includes(scenario);
        assert.equal(failure.turnStopUnconfirmed === true, unconfirmed);
        return true;
      });
      assert.equal(queries > 0, hasPid);
    } finally {
      childProcess.spawn = originalSpawn;
      process.kill = originalKill;
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    }
  });
}

for (const scenario of ["error-no-close", "no-event", "normal-close"]) {
 for (const workflow of scenario === "normal-close" ? ["direct"] : scenario === "error-no-close" ? ["direct", "task", "setup"] : ["direct", "task"]) {
  test(`POSIX standalone startup waits remain live and settle cleanly: ${workflow} ${scenario}`, options, () => {
    const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
    const cliUrl = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).href;
    const script = `
      import childProcess from "node:child_process";
      import { EventEmitter } from "node:events";
      import { PassThrough } from "node:stream";
      import assert from "node:assert/strict";
      import { GrokAcpClient } from ${JSON.stringify(moduleUrl)};
      const scenario = ${JSON.stringify(scenario)};
      const workflow = ${JSON.stringify(workflow)};
      const timers = new Set();
      const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
      globalThis.setTimeout = (callback, ms, ...args) => {
        const handle = originalSet(() => { timers.delete(handle); callback(...args); }, ms);
        timers.add(handle); return handle;
      };
      globalThis.clearTimeout = handle => { timers.delete(handle); originalClear(handle); };
      const normal = scenario === "normal-close";
      const child = Object.assign(new EventEmitter(), {
        pid: normal ? 424242 : undefined, exitCode: null, signalCode: null, killed: false,
        stdin: normal ? new PassThrough() : null, stdout: normal ? new PassThrough() : null,
        stderr: normal ? new PassThrough() : null, stdio: [null, null, null, normal ? new PassThrough() : null], unref() {}
      });
      childProcess.spawn = () => {
        if (workflow !== "direct") process.stderr.write("SPAWN_MOCK " + scenario + "\\n");
        if (scenario === "error-no-close") queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture ENOENT"), { code: "ENOENT" })));
        if (normal) {
          child.stdin.on("data", chunk => {
            const request = JSON.parse(chunk.toString());
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
          });
          child.stdin.on("finish", () => queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); }));
          queueMicrotask(() => child.emit("spawn"));
        }
        return child;
      };
      process.kill = (pid, signal) => { assert.equal(pid, -424242); assert.equal(signal, 0); throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
      if (workflow !== "direct") {
        process.env.GROK_BIN = "fixture-grok";
        childProcess.spawnSync = (command, args) => {
          assert.equal(command, "fixture-grok");
          assert.ok(["--version", "agent stdio --help"].includes(args.join(" ")));
          process.stderr.write("PROBE_MOCK " + args.join(" ") + "\\n");
          return { status: 0, stdout: "grok fixture", stderr: "", error: null };
        };
        process.argv = [process.execPath, ${JSON.stringify(cliUrl)}, workflow, "--json", ...(workflow === "task" ? ["inspect"] : [])];
        await import(${JSON.stringify(cliUrl)});
      } else {
      try {
        const client = await GrokAcpClient.connectForeground("mock", { env: {} });
        assert.equal(normal, true); await client.close();
        assert.notEqual(client.closeStopUnconfirmed, true);
        assert.equal([...timers].some(timer => timer.hasRef()), false, "settled startup and close timers must be cleared");
        process.stdout.write("SPAWN_RESULT " + JSON.stringify({ scenario, stopped: true }) + "\\n");
      } catch (error) {
        assert.equal(normal, false);
        assert.equal(error.turnStopUnconfirmed, true);
        if (scenario === "error-no-close") assert.equal(error.code, "ENOENT");
        else assert.equal(error.name, "HandshakeTimeoutError");
        assert.equal([...timers].some(timer => timer.hasRef()), false);
        process.stdout.write("SPAWN_RESULT " + JSON.stringify({ scenario, unconfirmed: true, error: error.code ?? error.name }) + "\\n");
        process.exitCode = 1;
      }
      }
    `;
    const runtimeArgs = "bun" in process.versions ? ["--no-env-file"] : [];
    const result = childProcess.spawnSync(process.execPath, [...runtimeArgs, "--input-type=module", "--eval", script], {
      encoding: "utf8", timeout: 17000, env: { TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir() }
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, scenario === "normal-close" ? 0 : 1, result.stderr);
    if (workflow !== "direct") {
      assert.match(result.stderr, /SPAWN_MOCK/);
      assert.match(result.stderr, /PROBE_MOCK --version/);
      assert.match(result.stderr, /PROBE_MOCK agent stdio --help/);
      if (workflow === "setup") {
        const report = JSON.parse(result.stdout);
        assert.equal(report.authenticated, false);
        assert.equal(report.turnStopUnconfirmed, true);
        assert.match(report.detail, /fixture ENOENT/);
      } else {
        assert.match(result.stderr, /Grok agent stop could not be confirmed\./);
        assert.match(result.stderr, scenario === "error-no-close" ? /fixture ENOENT/ : /did not complete the ACP handshake/);
      }
      return;
    }
    const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith("SPAWN_RESULT "));
    assert.ok(marker, result.stdout + result.stderr);
    assert.equal(JSON.parse(marker.slice("SPAWN_RESULT ".length)).scenario, scenario);
  });
 }
}
