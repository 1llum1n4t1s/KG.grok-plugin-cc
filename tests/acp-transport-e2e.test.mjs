import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getEventListeners } from "node:events";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { removeTempFixture } from "./helpers.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = bytes => "日🙂x".repeat(Math.ceil(bytes / 8));
const digest = value => createHash("sha256").update(value).digest("hex");
const fakeSource = String.raw`
import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("fake grok agent stdio");
  process.exit(0);
}
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
  if (m.method === "initialize") {
    return void send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (m.method === "session/new") {
    return void send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "session-" + (++session) } });
  }
  if (m.method === "session/set_mode" && m.params.modeId === "hold-control") {
    log({ heldControl: m.id });
    const gate = setInterval(() => {
      if (!fs.existsSync(process.env.TRANSPORT_LOG + ".release-control")) return;
      clearInterval(gate);
      send({ jsonrpc: "2.0", id: m.id, result: {} }).then(() => log({ controlFinished: m.id }));
    }, 10);
    return;
  }
  if (m.method === "session/cancel") {
    log({ cancelled: m.params.sessionId });
    for (const [id, sessionId] of pending) if (sessionId === m.params.sessionId) finish(id, "cancelled");
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    return;
  }
  if (m.method !== "session/prompt") return void send({ jsonrpc: "2.0", id: m.id, result: {} });
  const p = JSON.parse(m.params.prompt[0].text);
  pending.set(m.id, m.params.sessionId);
  log({ prompt: m.id, sessionId: m.params.sessionId, mode: p.mode, agentPid: process.pid });
  if (p.mode === "stderr") {
    process.stderr.write(p.text, () => finish(m.id));
    return;
  }
  if (p.mode === "eof") {
    process.stdout.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }), () => process.exit(0));
    return;
  }
  if (p.mode === "exit-drain") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.text } } } }, 4093);
    output.then(() => finish(m.id)).then(() => {
      process.stderr.write("final diagnostic 日🙂", () => process.stdout.end(() => process.exit(7)));
    });
    return;
  }
  if (p.mode === "malformed") {
    process.stdout.write("{invalid}\n" + JSON.stringify({ jsonrpc: "2.0", id: 9201, method: "fs/write_text_file", params: { sessionId: m.params.sessionId, path: p.path, content: "after-fatal" } }) + "\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (p.mode === "late") {
    setTimeout(() => finish(m.id), p.finishAfter ?? 500);
    return;
  }
  if (p.mode === "hold") return;
  const text = "日🙂x".repeat(Math.ceil(p.bytes / 8));
  const update = p.mode === "tool"
    ? { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read output", status: "completed", content: [{ type: "content", content: { type: "text", text } }] }
    : { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update } }, p.fragment, p.gap);
  output.then(() => finish(m.id));
});
`;

// Linux fixture ごとに起動した process を生成元で記録する。ほかの process の環境は走査しない。

const fixtures = [];
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-transport-e2e-"));
  const script = path.join(cwd, "agent.mjs");
  fs.writeFileSync(script, fakeSource);
  const wrapper = path.join(cwd, process.platform === "win32" ? "grok.cmd" : "grok");
  fs.writeFileSync(wrapper, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const logPath = path.join(cwd, "agent.jsonl");
  const f = { cwd, env: { ...process.env, GROK_BIN: wrapper, TRANSPORT_LOG: logPath, TMPDIR: cwd, TMP: cwd, TEMP: cwd }, logs: () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] };
  fixtures.push(f); return f;
}
async function until(predicate, detail, ms = 3000) {
  const start = performance.now(); while (performance.now() - start < ms) { if (await predicate()) return; await pause(10); } throw new Error(`Timed out: ${detail}`);
}
const prompt = (client, sessionId, value) => client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: JSON.stringify(value) }] });
async function withClient(run) {
  const f = fixture();
  const client = await GrokAcpClient.connectForeground(f.cwd, { grokBin: f.env.GROK_BIN, env: f.env });
  try { return await run(client, f); } finally { await client.close(); if (client.closeStopUnconfirmed) throw new Error(`Agent stop unconfirmed; preserve ${f.cwd}`); f.stopped = true; }
}
test.after(() => { for (const f of fixtures) if (f.stopped) removeTempFixture(f.cwd, { recursive: true, force: true }); });
    test(`ACP direct: stderr retention is bounded across turns without losing forwarded Unicode`, { timeout: 20000 }, async () => {
      await withClient( async (client) => {
        const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
        let forwarded = "";
        client.options.onStderr = (chunk) => { forwarded += chunk; };
        let all = "";
        for (let turn = 0; turn < 3; turn += 1) {
          const text = "日🙂".repeat(40000) + `tail-${turn}🙂`;
          all += text;
          await prompt(client, sessionId, { mode: "stderr", text });
          await until(() => client.stderr.endsWith(`tail-${turn}🙂`), "stderr delivered");
          assert.ok(client.stderr.length <= 65536, "retained diagnostic must have a fixed bound");
          assert.ok(all.endsWith(client.stderr), "retained diagnostic must be an intact suffix");
          assert.doesNotMatch(client.stderr, /^[\uDC00-\uDFFF]|\uFFFD/);
        }
        assert.equal(forwarded, all, "forwarding must preserve every chunk");
        const retained = client.stderr;
        await client.close();
        assert.equal(client.stderr, retained, "closing must preserve the bounded diagnostic");
      });
    });

    test(`ACP direct: fragmented UTF8 assistant/tool and multiple frames remain equivalent`, { timeout: 20000 }, async () => {
      await withClient( async (client) => {
        const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
        for (const mode of ["assistant", "tool"]) {
          let received = "";
          client.setNotificationHandler((m) => { const u = m.params?.update; received += u?.content?.text ?? u?.content?.[0]?.content?.text ?? ""; });
          assert.equal((await prompt(client, sessionId, { mode, bytes: 65536, fragment: 127 })).stopReason, "end_turn");
          assert.equal(digest(received), digest(content(65536)));
          assert.equal(client.pending.size, 0);
        }
      });
    });

    test(`ACP direct: abort, response, timeout and exit release pending requests and listeners`, { timeout: 20000 }, async () => {
      await withClient( async (client, f) => {
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

        const previousRpcTimeoutMs = client.options.rpcTimeoutMs;
        client.options.rpcTimeoutMs = 3000;
        const timeout = new AbortController();
        let heldControl;
        try {
          const request = client.request("session/set_mode", { sessionId, modeId: "hold-control" }, { signal: timeout.signal });
          const timedOut = assert.rejects(request, /timed out/);
          void timedOut.catch(() => {});
          await until(() => (heldControl = f.logs().find((m) => m.heldControl !== undefined)), "control request received by agent", 2500);
          assert.equal(client.pending.size, 1, "request must still be pending after agent receipt");
          assert.equal(getEventListeners(timeout.signal, "abort").length, 1);
          assert.equal(f.logs().some((m) => m.controlFinished === heldControl.heldControl), false, "response must remain gated");
          await timedOut;
          assert.equal(f.logs().some((m) => m.controlFinished === heldControl.heldControl), false, "timeout must precede agent response");
          assert.equal(getEventListeners(timeout.signal, "abort").length, 0);
          assert.equal(client.pending.size, 0);
        } finally {
          client.options.rpcTimeoutMs = previousRpcTimeoutMs;
          fs.writeFileSync(path.join(f.cwd, "agent.jsonl.release-control"), "release");
        }
        // timeout 後の遅延応答を読み切り、次の要求が処理できることを確認する。
        await until(() => f.logs().some((m) => m.controlFinished === heldControl.heldControl), "timed out control response sent");
        await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
        assert.equal(client.pending.size, 0);
        assert.equal(getEventListeners(timeout.signal, "abort").length, 0);
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

  test("ACP direct: cancellation reaches the agent while a large frame is arriving", { timeout: 20000 }, async () => {
    await withClient(async (client, f) => {
      const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
      let received = "";
      client.setNotificationHandler((m) => { received += m.params?.update?.content?.text ?? ""; });
      const active = prompt(client, sessionId, { mode: "assistant", bytes: 8388608, fragment: 4093, gap: 1 });
      await until(() => client.framer.fragments.reduce((n, part) => n + part.length, 0) > 65536, "partial large frame received");
      client.notify("session/cancel", { sessionId });
      await until(() => f.logs().some((m) => m.cancelled === sessionId), "agent received cancellation");
      assert.ok(client.framer.fragments.length > 0, "frame must still be incomplete at cancellation");
      assert.equal((await active).stopReason, "cancelled");
      assert.equal(digest(received), digest(content(8388608)));
      assert.equal(client.pending.size, 0);
    });
  });

  test("ACP direct: EOF without a newline discards the incomplete frame", { timeout: 10000 }, async () => {
    await withClient( async (client) => {
      const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
      await assert.rejects(prompt(client, sessionId, { mode: "eof" }), /connection closed/);
      assert.equal(client.framer.closed, true);
      assert.deepEqual(client.framer.fragments, []);
    });
  });

  test("ACP direct: process close drains final stdout frames and stderr diagnostics", { timeout: 15000 }, async () => {
    await withClient( async (client) => {
      const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
      let received = "";
      client.setNotificationHandler((m) => { received += m.params?.update?.content?.text ?? ""; });
      const text = content(2097152);
      assert.equal((await prompt(client, sessionId, { mode: "exit-drain", text })).stopReason, "end_turn");
      await client.exitPromise;
      assert.equal(digest(received), digest(text));
      assert.match(client.exitError.message, /exit 7/);
      assert.match(client.exitError.message, /final diagnostic 日🙂/);
      assert.equal(client.pending.size, 0);
    });
  });

  test("ACP direct: fatal frame rejects the prompt, blocks file writes and tears down the real agent", { timeout: 10000 }, async () => {
    const f = fixture();
    const client = await GrokAcpClient.connectForeground(f.cwd, { grokBin: f.env.GROK_BIN, env: f.env, clientCapabilities: { fs: { writeTextFile: true } } });
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
      if (!client.closeStopUnconfirmed) f.stopped = true;
    }
  });
