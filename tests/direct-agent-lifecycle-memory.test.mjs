import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const acp = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const source = acp.slice(acp.indexOf("class SpawnedAcpClient"), acp.indexOf("class BrokerAcpClient"));

for (const phase of ["never-started", "controller-registering", "ready", "ack-save-failed", "cancel-before-generation"]) {
  test(`direct owner lifecycle preserves cancellation at ${phase}`, async () => {
    let starts = 0;
    let handshakes = 0;
    let control;
    const proofs = [];
    let releaseSpawn;
    const spawnReady = new Promise(resolve => { releaseSpawn = resolve; });
    const proc = new EventEmitter();
    Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
    const owned = { proc, ready: Promise.resolve(), stopConfirmed: false, async close() { this.stopConfirmed = true; return true; } };
    const context = vm.createContext({ process: { platform: "win32", env: {} }, setTimeout, Promise,
      quoteIfNeeded: value => value, DIRECT_HANDSHAKE_TIMEOUT_MS: 100,
      withTimeout: value => value, waitForExitWithTimeout: async () => {},
      reserveDirectAdmission: () => ({ generation: "fixture" }), verifyDirectStart: (_cwd, token) => token?.generation === "fixture", finishDirectStart: () => true,
      spawnWindowsAgent: async (_cwd, _command, _args, options) => { options.beforeSpawn?.(); starts += 1; if (phase === "controller-registering") await spawnReady; return owned; },
      AcpClientBase: class { constructor(cwd, options) { this.cwd = cwd; this.options = options; this.closed = false; this.framer = { close() {} }; this.stderr = ""; }
        async performInitialize() { handshakes += 1; } }
    });
    vm.runInContext(source + ";globalThis.connect=connectDirectClient;", context);
    const options = { directAgentStarting(value) {
      if (phase === "cancel-before-generation") throw Error("Job cancelled before generation");
      control = value;
      if (phase === "never-started") void value.close().catch(() => {});
      return { async finish(proof) { proofs.push(proof); if (phase === "ack-save-failed") throw Error("ACK save failed"); return Boolean(proof); } };
    } };
    const run = context.connect("mock", options);
    if (["never-started", "cancel-before-generation"].includes(phase)) {
      await assert.rejects(run, /cancelled|closed|startup/);
      assert.equal(starts, 0);
      assert.equal(handshakes, 0);
      assert.deepEqual(proofs, phase === "never-started" ? ["never-started"] : []);
    } else if (phase === "controller-registering") {
      await Promise.resolve();
      assert.equal(starts, 1);
      const closing = control.close();
      releaseSpawn();
      await closing;
      await assert.rejects(run, /cancelled|closed|startup/);
      assert.equal(handshakes, 0);
      assert.deepEqual(proofs, ["job-empty"]);
    } else {
      const client = await run;
      if (phase === "ack-save-failed") {
        await assert.rejects(client.close(), /ACK save failed/);
        assert.equal(client.closeStopUnconfirmed, true);
      } else await client.close();
      assert.deepEqual(proofs, ["job-empty"]);
      assert.equal(handshakes, 1);
    }
  });
}
