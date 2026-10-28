import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as state from "../plugins/grok/scripts/lib/state.mjs";

// 先頭2件はNode/netの生socket能力だけを測り、製品のlock安全性とは区別する。
// Linux abstract UDSはnetwork namespaceを跨ぐ排他を保証しないため製品には使用しない。
// 後段の低レベル製品APIはWindows専用。POSIXはposix-state-lock-e2e.test.mjsで実stateを検証する。
const supported = ["win32", "linux"].includes(process.platform);
const endpoint = label => process.platform === "win32"
  ? `\\\\.\\pipe\\grok-state-capability-${process.pid}-${label}`
  : `\0grok-state-capability-${process.pid}-${label}`;

function acquire(name) {
  const server = net.createServer(socket => socket.destroy());
  server.on("error", () => {});
  server.listen({ path: name, exclusive: true });
  return server;
}

test("raw Node socket capability acquires synchronously, rejects peers, and releases in the same tick", { skip: !supported }, () => {
  const name = endpoint("same-tick");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const owner = acquire(name);
    const contender = acquire(name);
    try {
      assert.equal(owner.listening, true, "runtime lacks synchronous native acquisition");
      assert.equal(contender.listening, false, "native endpoint admitted a concurrent owner");
    } finally {
      owner.close();
      contender.close();
    }
  }
});

test("raw Node socket capability survives contention and owner process death within one namespace", { skip: !supported, timeout: 10_000 }, async t => {
  const name = endpoint("process-death");
  const holderSource = `const net=require('node:net'); const s=net.createServer(c=>c.destroy());
    s.on('error',e=>{console.error(e.code);process.exit(1)});
    s.listen({path:${JSON.stringify(name)},exclusive:true}); console.log(s.listening);`;
  const contenderSource = `const net=require('node:net'); const s=net.createServer(c=>c.destroy());
    s.on('error',()=>{}); s.listen({path:${JSON.stringify(name)},exclusive:true}); console.log(s.listening);s.close();`;
  const holder = spawn(process.execPath, ["-e", holderSource], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(holder, "close");
  let stderr = "";
  holder.stderr.on("data", data => { stderr += data; });
  t.after(async () => { if (holder.exitCode === null) holder.kill(); await exited; });
  const ready = once(holder.stdout, "data");
  const first = await Promise.race([ready.then(([data]) => data.toString().trim()), exited.then(() => `exited: ${stderr}`)]);
  assert.equal(first, "true");
  const contend = () => {
    const result = spawnSync(process.execPath, ["-e", contenderSource], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(contend(), "false");
  holder.kill();
  await exited;
  assert.equal(contend(), "true");
});

test("native state API serializes synchronous callbacks and releases in the same tick", { skip: process.platform !== "win32" }, () => {
  assert.equal(typeof state.withNativeStateLock, "function", "Missing native state mutex implementation");
  const directory = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(state.withNativeStateLock(directory, () => {
    assert.throws(() => state.withNativeStateLock(directory, () => assert.fail("Concurrent callback entered"), { timeoutMs: 0 }), /native state lock/i);
    return "first";
  }), "first");
  assert.equal(state.withNativeStateLock(directory, () => "second", { timeoutMs: 0 }), "second");
});

test("native state API retains callback failure and releases its OS handle", { skip: process.platform !== "win32" }, () => {
  assert.equal(typeof state.withNativeStateLock, "function", "Missing native state mutex implementation");
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const failure = new Error("callback failed");
  assert.throws(() => state.withNativeStateLock(directory, () => { throw failure; }), error => error === failure);
  assert.equal(state.withNativeStateLock(directory, () => "released", { timeoutMs: 0 }), "released");
});

test("native state contention respects the elapsed timeout budget", { skip: process.platform !== "win32" }, () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  state.withNativeStateLock(directory, () => {
    const started = performance.now();
    assert.throws(() => state.withNativeStateLock(directory, () => assert.fail("Concurrent callback entered"), { timeoutMs: 1000 }), /native state lock/i);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 1250, `1000ms contention budget took ${Math.round(elapsed)}ms`);
  });
});
