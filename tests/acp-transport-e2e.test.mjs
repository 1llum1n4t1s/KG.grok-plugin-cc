import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { getEventListeners } from "node:events";

const root = process.env.GROK_TRANSPORT_ROOT ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { GrokAcpClient } = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/acp.mjs")));
const brokerScript = path.join(root, "plugins/grok/scripts/acp-broker.mjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const content = (bytes) => "日🙂x".repeat(Math.ceil(bytes / 8)).slice(0, Math.ceil(bytes / 8) * 4);
const digest = (value) => createHash("sha256").update(value).digest("hex");

// 実際のstdio、子プロセス、名前付きパイプを通るACPサーバー。
const fakeSource = String.raw`
import fs from "node:fs";
import readline from "node:readline";
const log = (value) => fs.appendFileSync(process.env.TRANSPORT_LOG, JSON.stringify(value) + "\n");
let session = 0;
log({ pid: process.pid });
const pending = new Map();
let output = Promise.resolve();
function send(message, fragment = 0, gap = 0) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  output = output.then(async () => {
    for (let offset = 0; offset < bytes.length; offset += fragment || bytes.length) {
      if (!process.stdout.write(bytes.subarray(offset, offset + (fragment || bytes.length)))) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
      if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
      else if (fragment) await new Promise((resolve) => setImmediate(resolve));
    }
  });
  return output;
}
function finish(id, stopReason = "end_turn") {
  if (!pending.has(id)) return;
  pending.delete(id);
  log({ finished: id });
  return send({ jsonrpc: "2.0", id, result: { stopReason } });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { log({ response: m }); return; }
  if (m.method === "initialize") return void send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === "session/new") return void send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "session-" + (++session) } });
  if (m.method === "session/load" && m.params.sessionId === "hold-control") return;
  if (m.method === "session/cancel") {
    log({ cancelled: m.params.sessionId });
    for (const [id, sessionId] of pending) if (sessionId === m.params.sessionId) finish(id, "cancelled");
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    return;
  }
  if (m.method !== "session/prompt") return void send({ jsonrpc: "2.0", id: m.id, result: {} });
  const p = JSON.parse(m.params.prompt[0].text);
  pending.set(m.id, m.params.sessionId);
  log({ prompt: m.id, sessionId: m.params.sessionId, mode: p.mode });
  if (p.mode === "malformed") {
    process.stdout.write("{invalid}\n" + JSON.stringify({ jsonrpc: "2.0", id: 9201, method: "fs/write_text_file", params: { sessionId: m.params.sessionId, path: p.path, content: "after-fatal" } }) + "\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (p.mode === "late") {
    setTimeout(() => {
      for (const request of p.requests) send({ jsonrpc: "2.0", ...request, params: { sessionId: m.params.sessionId, ...request.params } });
    }, p.delay ?? 180);
    setTimeout(() => finish(m.id), p.finishAfter ?? 500);
    return;
  }
  if (p.mode === "hold") return;
  if (p.mode === "input") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.text } } } });
    finish(m.id);
    return;
  }
  const text = "日🙂x".repeat(Math.ceil(p.bytes / 8));
  const update = p.mode === "tool"
    ? { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read output", status: "completed", content: [{ type: "content", content: { type: "text", text } }] }
    : { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update } }, p.fragment, p.gap);
  output.then(() => finish(m.id));
});
`;

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-transport-e2e-"));
  const script = path.join(cwd, "agent.mjs");
  fs.writeFileSync(script, fakeSource);
  const wrapper = path.join(cwd, process.platform === "win32" ? "grok.cmd" : "grok");
  fs.writeFileSync(wrapper, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const logPath = path.join(cwd, "agent.jsonl");
  const env = { ...process.env, GROK_BIN: wrapper, TRANSPORT_LOG: logPath };
  return { cwd, env, logs: () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] };
}

async function until(predicate, detail, ms = 3000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await predicate()) return;
    await pause(10);
  }
  throw new Error(`Timed out: ${detail}`);
}

function endpoint() {
  return process.platform === "win32" ? `pipe:\\\\.\\pipe\\grok-transport-${randomUUID()}` : `unix:${path.join(os.tmpdir(), "grok-transport-" + randomUUID() + ".sock")}`;
}

function socketPath(value) {
  return value.slice(5);
}

async function brokerFixture() {
  const f = fixture();
  const address = endpoint();
  let stderr = "";
  const proc = spawn(process.execPath, [brokerScript, "serve", "--cwd", f.cwd, "--endpoint", address], { cwd: f.cwd, env: f.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  await until(async () => {
    if (proc.exitCode !== null) throw new Error(`Broker failed: ${stderr}`);
    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath(address));
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
  }, "broker listening", 10000);
  return {
    ...f,
    connect: (options = {}) => GrokAcpClient.connect(f.cwd, { ...options, brokerEndpoint: address, env: f.env }),
    close: async () => {
      if (proc.exitCode === null) {
        const client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, env: f.env });
        try { await client.request("broker/shutdown", {}); } finally { await client.close(); }
      }
      await exited;
      assert.equal(proc.exitCode, 0, stderr);
      assert.doesNotMatch(stderr, /Unhandled|uncaught|ERR_STREAM_WRITE_AFTER_END/);
    }
  };
}

const prompt = (client, sessionId, value) => client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: JSON.stringify(value) }] });

async function withClient(transport, run) {
  const f = transport === "broker" ? await brokerFixture() : fixture();
  const client = transport === "broker" ? await f.connect() : await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.env.GROK_BIN, env: f.env });
  try { return await run(client, f); } finally { await client.close(); if (transport === "broker") await f.close(); }
}

async function measureCase({ transport, mode, bytes, fragment }) {
  let result;
  await withClient(transport, async (client) => {
    const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
    let received = "";
    let peakHeap = process.memoryUsage().heapUsed;
    let maxLoopDelayMs = 0;
    let previous = performance.now();
    client.setNotificationHandler((m) => {
      const u = m.params?.update;
      received += u?.content?.text ?? u?.content?.[0]?.content?.text ?? "";
    });
    const samples = setInterval(() => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      const now = performance.now();
      maxLoopDelayMs = Math.max(maxLoopDelayMs, now - previous - 2);
      previous = now;
    }, 2);
    const start = performance.now();
    const response = await prompt(client, sessionId, { mode, bytes, fragment, ...(mode === "input" ? { text: content(bytes) } : {}) });
    const elapsedMs = performance.now() - start;
    await tick();
    clearInterval(samples);
    assert.equal(response.stopReason, "end_turn");
    assert.equal(received, content(bytes));
    const held = prompt(client, sessionId, { mode: "hold" });
    await tick();
    const cancelStart = performance.now();
    client.notify("session/cancel", { sessionId });
    assert.equal((await held).stopReason, "cancelled");
    result = { transport, mode, fragment, requestedBytes: bytes, outputBytes: Buffer.byteLength(received), sha256: digest(received), elapsedMs, peakRss: process.resourceUsage().maxRSS * 1024, peakHeap, maxLoopDelayMs, cancelMs: performance.now() - cancelStart };
  });
  console.log(JSON.stringify(result));
}

async function measure() {
  if (process.env.GROK_TRANSPORT_CASE) return measureCase(JSON.parse(process.env.GROK_TRANSPORT_CASE));
  const sizes = (process.env.GROK_TRANSPORT_SIZES ?? "65536,2097152,8388608").split(",").map(Number);
  const repeats = Number(process.env.GROK_TRANSPORT_REPEATS ?? 3);
  for (const transport of ["direct", "broker"]) {
    for (const mode of ["assistant", "tool", "input"]) {
      for (const bytes of sizes) {
        for (const fragment of [4093, 65536]) for (let repeat = 0; repeat < repeats; repeat += 1) {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GROK_TRANSPORT_CASE: JSON.stringify({ transport, mode, bytes, fragment }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          const exit = await new Promise((resolve) => child.on("exit", resolve));
          assert.equal(exit, 0, stderr);
          console.log(JSON.stringify({ ...JSON.parse(stdout), repeat }));
        }
      }
    }
  }
}

async function cancelDuringFrame(transport) {
  return withClient(transport, async (client) => {
    const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
    const stream = client.socket ?? client.proc.stdout;
    let received = 0;
    let cancelStart;
    let cancel;
    const onData = (chunk) => {
      received += Buffer.byteLength(chunk);
      if (!cancel && received > 1024 * 1024) {
        cancelStart = performance.now();
        cancel = client.request("session/cancel", { sessionId });
        void cancel.catch(() => {});
      }
    };
    stream.on("data", onData);
    try {
      await prompt(client, sessionId, { mode: "assistant", bytes: 8388608, fragment: 4093 });
      assert.ok(cancel, "cancel must start while receiving the large frame");
      await cancel;
      return { transport, bytes: received, cancelDuringFrameMs: performance.now() - cancelStart, pending: client.pending.size };
    } finally {
      stream.off("data", onData);
    }
  });
}

if (process.env.GROK_TRANSPORT_CANCEL === "1") {
  for (const transport of ["direct", "broker"]) for (let repeat = 0; repeat < 3; repeat += 1) {
    console.log(JSON.stringify({ ...await cancelDuringFrame(transport), repeat }));
  }
} else if (process.env.GROK_TRANSPORT_MEASURE === "1") {
  await measure();
} else {
  for (const transport of ["direct", "broker"]) {
    test(`ACP ${transport}: fragmented UTF8 assistant/tool and multiple frames remain equivalent`, { timeout: 20000 }, async () => {
      await withClient(transport, async (client) => {
        const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
        for (const mode of ["assistant", "tool"]) {
          let received = "";
          client.setNotificationHandler((m) => { const u = m.params?.update; received += u?.content?.text ?? u?.content?.[0]?.content?.text ?? ""; });
          assert.equal((await prompt(client, sessionId, { mode, bytes: 65536, fragment: 127 })).stopReason, "end_turn");
          assert.equal(received, content(65536));
          assert.equal(client.pending.size, 0);
        }
      });
    });

    test(`ACP ${transport}: abort, response, timeout and exit release pending requests and listeners`, { timeout: 20000 }, async () => {
      await withClient(transport, async (client, f) => {
        const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
        const already = new AbortController();
        already.abort(new Error("already aborted"));
        assert.throws(() => client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: JSON.stringify({ mode: "never-sent" }) }] }, { signal: already.signal }), /already aborted/);
        assert.equal(getEventListeners(already.signal, "abort").length, 0);
        const complete = new AbortController();
        await client.request("session/new", { cwd: client.cwd, mcpServers: [] }, { signal: complete.signal });
        assert.equal(getEventListeners(complete.signal, "abort").length, 0);
        complete.abort();

        const controller = new AbortController();
        const pending = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: JSON.stringify({ mode: "late", requests: [], delay: 10, finishAfter: 80 }) }] }, { signal: controller.signal });
        const rejected = assert.rejects(pending, /owner ended/);
        await until(() => f.logs().some((m) => m.mode === "late"), "abortable prompt received");
        controller.abort(new Error("owner ended"));
        await rejected;
        assert.equal(client.pending.size, 0);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        await until(() => f.logs().some((m) => m.finished), "late response sent");
        await pause(20);
        assert.equal(client.pending.size, 0);
        assert.equal(f.logs().some((m) => m.mode === "never-sent"), false);

        client.options.rpcTimeoutMs = 30;
        const timeout = new AbortController();
        await assert.rejects(client.request("session/load", { sessionId: "hold-control", cwd: client.cwd, mcpServers: [] }, { signal: timeout.signal }), /timed out/);
        assert.equal(getEventListeners(timeout.signal, "abort").length, 0);
        assert.equal(client.pending.size, 0);
        const exiting = new AbortController();
        const held = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: JSON.stringify({ mode: "hold" }) }] }, { signal: exiting.signal });
        const closed = assert.rejects(held, /closed/);
        await Promise.all([client.close(), client.close()]);
        await closed;
        assert.equal(client.closed, true);
        assert.equal(client.pending.size, 0);
        assert.equal(getEventListeners(exiting.signal, "abort").length, 0);
      });
    });
  }

  test("ACP direct: fatal frame rejects the prompt, blocks file writes and tears down the real agent", { timeout: 10000 }, async () => {
    const f = fixture();
    const client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.env.GROK_BIN, env: f.env, clientCapabilities: { fs: { writeTextFile: true } } });
    const target = path.join(f.cwd, "after-fatal.txt");
    try {
      const { sessionId } = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
      await assert.rejects(prompt(client, sessionId, { mode: "malformed", path: target }), /Failed to parse/);
      await client.close();
      assert.equal(fs.existsSync(target), false);
      assert.equal(client.pending.size, 0);
      const pid = f.logs().find((m) => m.pid)?.pid;
      assert.ok(pid);
      await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, "malformed agent process exited");
    } finally {
      await client.close();
    }
  });

  test("ACP broker: disconnect seals the client and drops late reverse requests in a buffered frame", { timeout: 10000 }, async () => {
    const f = fixture();
    const address = endpoint();
    let peer;
    const server = net.createServer((socket) => {
      peer = socket;
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        const m = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }) + "\n");
      });
    });
    await new Promise((resolve) => server.listen(socketPath(address), resolve));
    const target = path.join(f.cwd, "late.txt");
    let permissions = 0;
    const client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, env: f.env, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, permissionHandler: () => { permissions += 1; return {}; } });
    try {
      peer.write("{invalid}\n" + JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "fs/write_text_file", params: { path: target, content: "unexpected" } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 9002, method: "session/request_permission", params: { options: [] } }) + "\n");
      await client.exitPromise;
      await pause(30);
      assert.equal(fs.existsSync(target), false, "frames after fatal parsing failure must not write files");
      assert.equal(permissions, 0);
      assert.equal(client.closed, true);
      assert.equal(client.pending.size, 0);
      assert.throws(() => client.request("session/prompt", { sessionId: "gone", prompt: [] }), /closed/);
    } finally {
      peer.destroy();
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("ACP broker: old session reverse requests cannot execute in the reconnected owner", { timeout: 15000 }, async () => {
    const f = await brokerFixture();
    const target = path.join(f.cwd, "late-owner-write.txt");
    const readTarget = path.join(f.cwd, "private.txt");
    fs.writeFileSync(readTarget, "new-owner-private");
    let permissions = 0;
    let first;
    let next;
    try {
      first = await f.connect();
      const oldSession = await first.request("session/new", { cwd: f.cwd, mcpServers: [] });
      const abandoned = prompt(first, oldSession.sessionId, { mode: "late", delay: 250, finishAfter: 600, requests: [
        { id: 9101, method: "fs/write_text_file", params: { path: target, content: "old-owner" } },
        { id: 9102, method: "fs/read_text_file", params: { path: readTarget } },
        { id: 9103, method: "session/request_permission", params: { options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } }
      ] }).catch(() => {});
      await until(() => f.logs().some((m) => m.mode === "late"), "old prompt received");
      await Promise.all([first.close(), first.close()]);
      await abandoned;
      assert.equal(first.pending.size, 0);
      next = await f.connect({ clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, permissionHandler: () => { permissions += 1; return { outcome: { outcome: "selected", optionId: "allow" } }; } });
      const newSession = await next.request("session/new", { cwd: f.cwd, mcpServers: [] });
      assert.notEqual(newSession.sessionId, oldSession.sessionId);
      const active = prompt(next, newSession.sessionId, { mode: "hold" });
      void active.catch(() => {});
      await until(() => f.logs().filter((m) => m.response?.id >= 9101).length === 3, "late reverse requests resolved");
      assert.equal(fs.existsSync(target), false, "old owner must not write through a new client");
      assert.equal(permissions, 0, "old owner must not invoke the new permission handler");
      assert.ok(f.logs().filter((m) => m.response?.id >= 9101).every((m) => m.response.error), "old reads and all other reverse requests must be rejected");
      assert.ok(f.logs().some((m) => m.cancelled === oldSession.sessionId), "disconnect cancels only the lost session");
      assert.equal(f.logs().some((m) => m.cancelled === newSession.sessionId), false);
      await assert.rejects(next.request("session/load", { sessionId: oldSession.sessionId, cwd: f.cwd, mcpServers: [] }), (error) => error.rpcCode === -32001);
      next.notify("session/cancel", { sessionId: newSession.sessionId });
      assert.equal((await active).stopReason, "cancelled");
      assert.equal(next.pending.size, 0);
      assert.equal((await next.request("session/new", { cwd: f.cwd, mcpServers: [] })).sessionId.startsWith("session-"), true);
      await next.close();
      next = await f.connect();
      await next.request("session/load", { sessionId: newSession.sessionId, cwd: f.cwd, mcpServers: [] });
      assert.equal((await prompt(next, newSession.sessionId, { mode: "assistant", bytes: 8 })).stopReason, "end_turn", "a normally completed session remains reusable");
    } finally {
      await first?.close();
      await next?.close();
      await f.close();
    }
  });

  test("ACP broker: disconnect rejects forwarded requests exactly once and ignores late client responses", { timeout: 10000 }, async () => {
    const f = await brokerFixture();
    let owner;
    let next;
    try {
      const intercepted = [];
      owner = await f.connect({ agentRequestHandler: (message) => intercepted.push(message) });
      const { sessionId } = await owner.request("session/new", { cwd: f.cwd, mcpServers: [] });
      const pending = prompt(owner, sessionId, { mode: "late", delay: 10, finishAfter: 500, requests: [{ id: 9301, method: "session/request_permission", params: { options: [] } }] });
      const rejection = assert.rejects(pending, /closed/);
      await until(() => intercepted.length === 1, "reverse request forwarded");
      await owner.close();
      await rejection;
      await until(() => f.logs().some((m) => m.response?.id === 9301), "forwarded request rejected on disconnect");
      next = await f.connect();
      next.respondToAgent(9301, { result: { outcome: { outcome: "selected", optionId: "late" } } });
      await pause(30);
      const responses = f.logs().filter((m) => m.response?.id === 9301);
      assert.equal(responses.length, 1);
      assert.ok(responses[0].response.error);
      assert.equal((await next.request("session/new", { cwd: f.cwd, mcpServers: [] })).sessionId.startsWith("session-"), true);
    } finally {
      await owner?.close();
      await next?.close();
      await f.close();
    }
  });

  test("ACP broker: partial frames are discarded on disconnect and cannot affect a new connection", { timeout: 10000 }, async () => {
    const f = fixture();
    const address = endpoint();
    const peers = new Set();
    let peer;
    const server = net.createServer((socket) => {
      peers.add(socket);
      peer = socket;
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => {
        const m = JSON.parse(chunk.trim());
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }) + "\n");
      });
      socket.on("close", () => peers.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(socketPath(address), resolve));
    let client;
    try {
      client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, env: f.env, clientCapabilities: { fs: { writeTextFile: true } } });
      const target = path.join(f.cwd, "partial.txt");
      const frame = JSON.stringify({ jsonrpc: "2.0", id: 9401, method: "fs/write_text_file", params: { path: target, content: "partial" } });
      peer.write(frame);
      await pause(20);
      assert.equal(fs.existsSync(target), false, "no delivery before newline");
      peer.end();
      await client.exitPromise;
      assert.equal(client.closed, true);
      assert.equal(client.pending.size, 0);
      assert.equal(fs.existsSync(target), false);
      await client.close();
      client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, env: f.env });
      assert.equal(client.transport, "broker");
      assert.equal(client.pending.size, 0);
    } finally {
      await client?.close();
      for (const socket of peers) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
