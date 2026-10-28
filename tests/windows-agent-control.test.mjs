import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnWindowsAgent } from "../plugins/grok/scripts/lib/windows-agent.mjs";

function fakeSpawn({ acknowledge = true, malformed = false, closeNaturally = false, delayedAck = false, delayedReady = false } = {}) {
  return (_command, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(args.includes("-ConfigBase64"), false, "control credentials must not appear in the process command line");
    const proc = new EventEmitter();
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
  };
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
    spawnImpl: () => { spawns += 1; } }), /identity/);
  assert.equal(spawns, 0);
});
