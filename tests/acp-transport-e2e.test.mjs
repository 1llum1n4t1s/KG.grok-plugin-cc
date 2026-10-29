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
import { createRequire } from "node:module";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { removeTempFixture } from "./helpers.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";

const root = process.env.GROK_TRANSPORT_ROOT ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { GrokAcpClient } = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/acp.mjs")));
const stateApi = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/state.mjs")));
const brokerApi = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/broker-lifecycle.mjs")));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const content = (bytes) => "日🙂x".repeat(Math.ceil(bytes / 8)).slice(0, Math.ceil(bytes / 8) * 4);
const digest = (value) => createHash("sha256").update(value).digest("hex");

// 実際のstdio、子プロセス、名前付きパイプを通るACPサーバー。
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
if (process.env.TRANSPORT_BROKER_FAILURE === "1") {
  process.on("exit", () => log({ agentExited: process.pid }));
  process.on("SIGTERM", () => process.exit(0));
  if (process.env.TRANSPORT_EXIT_ON_STDIN_END === "1") process.stdin.once("end", () => process.exit(0));
  setTimeout(() => process.exit(0), Number(process.env.TRANSPORT_AGENT_LIFETIME_MS ?? 10000));
}
const pending = new Map();
const reverseGates = new Map();
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
    if (process.env.TRANSPORT_START_STDERR === "1") {
      process.stderr.write("startup diagnostic\n");
      return;
    }
    return void send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (m.method === "session/new") {
    if (process.env.TRANSPORT_NEW_BUSY === "1") return void send({ jsonrpc: "2.0", id: m.id, error: { code: -32001, message: "agent busy" } });
    return void send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "session-" + (++session) } });
  }
  if (m.method === "session/set_mode" && m.params.modeId?.startsWith("release-reverse:")) {
    const key = m.params.modeId.slice("release-reverse:".length);
    const release = reverseGates.get(key);
    if (!release) return void send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Unknown reverse gate" } });
    log({ releasedReverse: key, sessionId: m.params.sessionId });
    release();
    return void send({ jsonrpc: "2.0", id: m.id, result: {} });
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
  const p = process.env.TRANSPORT_REVIEW_FIXTURE === "1" && !m.params.prompt[0].text.startsWith("{")
    ? (m.params.prompt[0].text.includes("Your previous message could not be parsed as JSON.")
      ? { mode: "review-repair", text: "{}" } : { mode: "review-first", text: "not valid JSON" })
    : JSON.parse(m.params.prompt[0].text);
  pending.set(m.id, m.params.sessionId);
  log({ prompt: m.id, sessionId: m.params.sessionId, mode: p.mode, agentPid: process.pid });
  if (p.mode === "review-first" || p.mode === "review-repair") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.text } } } });
    output.then(() => finish(m.id));
    return;
  }
  if (p.mode === "rpc-error") {
    pending.delete(m.id);
    return void send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "agent prompt error" } });
  }
  if (p.mode === "finish-cancelled") {
    finish(m.id, "cancelled");
    return;
  }
  if (p.mode === "unknown-stop" || p.mode === "typed-stop") {
    finish(m.id, p.mode === "unknown-stop" ? "unsupported-reason" : 123);
    return;
  }
  if (p.mode === "missing-stop" || p.mode === "missing-result") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial response" } } } });
    output.then(() => {
      pending.delete(m.id);
      return send({ jsonrpc: "2.0", id: m.id, ...(p.mode === "missing-stop" ? { result: {} } : {}) });
    });
    return;
  }
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
  if (p.mode === "notification-failure") {
    process.stderr.write("notification diagnostic\n", () => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "failure", title: "Fail progress" } } });
    });
    setTimeout(() => process.exit(0), 5000);
    return;
  }
  if (p.mode === "close-stdin") {
    process.on("exit", () => log({ failureAgentExited: true }));
    if (process.env.TRANSPORT_BROKER_FAILURE !== "1") process.on("SIGTERM", () => process.exit(0));
    fs.closeSync(0);
    log({ failureAgentStdinClosed: true });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "closed-stdin", title: "stdin closed" } } });
    setTimeout(() => process.exit(0), 5000);
    return;
  }
  if (p.mode === "reverse-epipe") {
    fs.closeSync(0);
    log({ reverseEpipeReady: true });
    send({ jsonrpc: "2.0", id: 9401, method: "session/request_permission", params: { sessionId: m.params.sessionId,
      toolCall: { toolCallId: "reverse-epipe", title: "Request permission" }, options: [{ optionId: "allow", kind: "allow_once" }] } });
    setTimeout(() => process.exit(0), 5000);
    return;
  }
  if (p.mode === "hold-stream-failure") {
    setTimeout(() => process.exit(0), 5000);
    return;
  }
  if (p.mode === "late") {
    const sendReverse = () => {
      if (p.releaseKey) log({ reverseSentForSession: m.params.sessionId, releaseKey: p.releaseKey });
      for (const request of p.requests) send({ jsonrpc: "2.0", ...request, params: { sessionId: m.params.sessionId, ...request.params } });
    };
    if (p.releaseKey) {
      let delayFinished = false;
      let released = false;
      const sendWhenReady = () => {
        if (!delayFinished || !released) return;
        reverseGates.delete(p.releaseKey);
        sendReverse();
      };
      reverseGates.set(p.releaseKey, () => { released = true; sendWhenReady(); });
      setTimeout(() => { delayFinished = true; sendWhenReady(); }, p.delay ?? 180);
    } else {
      setTimeout(sendReverse, p.delay ?? 180);
    }
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

// Linux fixture ごとに起動した process を生成元で記録する。ほかの process の環境は走査しない。
const ownedFixtures = [];
const ownerTrackerSource = String.raw`
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
function identity(pid) {
  try {
    const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}
function log(file, value) { fs.appendFileSync(file, JSON.stringify(value) + "\n"); }
if (process.env.GROK_TRANSPORT_OWNERSHIP) {
  log(process.env.GROK_TRANSPORT_OWNERSHIP, { type: "ready", pid: process.pid, identity: identity(process.pid) });
}
if (!globalThis.__grokTransportOwnershipPatched) {
  globalThis.__grokTransportOwnershipPatched = true;
  const original = childProcess.spawn;
  childProcess.spawn = function(file, args, options) {
    const child = original.apply(this, arguments);
    const opts = Array.isArray(args) ? options : args;
    const env = opts?.env ?? process.env;
    const logFile = env.GROK_TRANSPORT_OWNERSHIP;
    if (logFile) {
      const id = child.pid ? identity(child.pid) : null;
      log(logFile, { type: "spawn", ownerPid: process.pid, pid: child.pid ?? null, identity: id, detached: opts?.detached === true,
        expectReady: file === process.execPath || file === env.GROK_BIN });
      child.once("close", (code, signal) => log(logFile, { type: "close", pid: child.pid ?? null, start: id?.start ?? null, code, signal }));
    }
    return child;
  };
  syncBuiltinESMExports();
}
`;
const fixtureIdentity = file => {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Fixture directory is not verified: ${file}`);
  return { dev: stat.dev, ino: stat.ino };
};
async function cleanupOwnedFixtures() {
  const errors = [];
  for (const f of ownedFixtures) {
    try {
      if (!f.complete || !f.stateDir || !f.marker?.epoch || !f.identity || !f.protocolIdentity) throw new Error("migration was not confirmed");
      const records = fs.readFileSync(f.ownershipLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const spawned = records.filter(entry => entry.type === "spawn");
      for (const entry of spawned) {
        if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !entry.identity?.start || !Number.isInteger(entry.identity.group)) {
          throw new Error("fixture child startup identity is unavailable");
        }
        if (entry.detached && entry.identity.group !== entry.pid) throw new Error("fixture child group identity is unavailable");
        if (entry.expectReady && !records.some(item => item.type === "ready" && item.pid === entry.pid && item.identity?.start === entry.identity.start)) {
          throw new Error(`fixture child startup was not confirmed: ${entry.pid}`);
        }
        await until(() => {
          let live = false;
          try {
            const raw = fs.readFileSync(`/proc/${entry.pid}/stat`, "utf8");
            const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
            live = fields[19] === entry.identity.start && !["Z", "X", "x"].includes(fields[0]);
          } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
          if (live) return false;
          if (entry.detached) {
            try { process.kill(-entry.pid, 0); return false; }
            catch (error) { if (error.code !== "ESRCH") throw error; }
          }
          return true;
        }, `fixture child and owned group stopped: ${entry.pid}`, 15000);
        if (entry.ownerPid === process.pid) {
          await until(() => fs.readFileSync(f.ownershipLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
            .some(item => item.type === "close" && item.pid === entry.pid && item.start === entry.identity.start),
          `fixture child close observed: ${entry.pid}`, 15000);
        }
      }
      assert.deepEqual(fixtureIdentity(f.cwd), f.rootIdentity);
      assert.deepEqual(fixtureIdentity(f.stateDir), f.identity);
      const lockDir = path.join(f.stateDir, "state.lock");
      assert.deepEqual(fixtureIdentity(lockDir), f.lockIdentity);
      const markerFile = path.join(lockDir, "protocol.json"), stat = fs.lstatSync(markerFile, { bigint: true });
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.deepEqual({ dev: stat.dev, ino: stat.ino }, f.protocolIdentity);
      const current = JSON.parse(fs.readFileSync(markerFile, "utf8"));
      assert.equal(current.epoch, f.marker.epoch);
      assert.deepEqual(current.sentinel, f.marker.sentinel);
      const stopped = shutdownPosixStateLockSentinel(f.stateDir, { offlineConfirmed: true, expectedStateDir: f.stateDir });
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.stateDir, f.stateDir);
      assert.equal(stopped.epoch, f.marker.epoch);
      assert.deepEqual(fixtureIdentity(f.cwd), f.rootIdentity);
      removeTempFixture(f.cwd, { recursive: true, force: true });
    } catch (error) {
      errors.push(new Error(`Fixture retained because owned process or sentinel termination was not confirmed: ${f.cwd}`, { cause: error }));
    }
  }
  if (errors.length) throw new AggregateError(errors, "Transport fixture cleanup was not confirmed");
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-transport-e2e-"));
  const tracked = process.platform === "linux" ? { cwd, rootIdentity: fixtureIdentity(cwd), complete: false } : null;
  if (tracked) ownedFixtures.push(tracked);
  const script = path.join(cwd, "agent.mjs");
  fs.writeFileSync(script, fakeSource);
  const wrapper = path.join(cwd, process.platform === "win32" ? "grok.cmd" : "grok");
  fs.writeFileSync(wrapper, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const logPath = path.join(cwd, "agent.jsonl");
  process.env.CLAUDE_PLUGIN_DATA = path.join(cwd, "data");
  process.env.PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;
  const stateDir = stateApi.resolveStateDir(cwd);
  const marker = stateApi.migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const env = { ...process.env, GROK_BIN: wrapper, TRANSPORT_LOG: logPath, TMPDIR: cwd, TMP: cwd, TEMP: cwd };
  if (tracked) {
    assert.equal(marker.stateDir, stateDir);
    assert.ok(marker.epoch && marker.sentinel);
    tracked.stateDir = stateDir; tracked.marker = marker;
    tracked.identity = fixtureIdentity(stateDir);
    const lockDir = path.join(stateDir, "state.lock");
    tracked.lockIdentity = fixtureIdentity(lockDir);
    const stat = fs.lstatSync(path.join(lockDir, "protocol.json"), { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    tracked.protocolIdentity = { dev: stat.dev, ino: stat.ino };
    tracked.ownershipLog = path.join(cwd, "ownership.jsonl");
    fs.writeFileSync(tracked.ownershipLog, "");
    const preload = path.join(cwd, "ownership.cjs");
    fs.writeFileSync(preload, ownerTrackerSource);
    env.GROK_TRANSPORT_OWNERSHIP = tracked.ownershipLog;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require="${preload}"`.trim();
    createRequire(import.meta.url)(preload);
    tracked.complete = true;
  }
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

async function brokerFixture(onChild, configure) {
  const f = fixture();
  configure?.(f);
  const address = endpoint();
  let proc, closed, exited, session;
  const wait = async (promise, ms) => {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const stopOwned = async () => {
    if (!proc) return;
    // PIDを再照会して停止権限にせず、未終了の直子handleだけを停止する。
    if (proc.exitCode === null && proc.signalCode === null && !proc.kill("SIGTERM")) throw new Error("Owned broker signal was not delivered");
    if (!(await wait(closed, 5000))) throw new Error("Owned broker close was not confirmed");
    if (process.platform === "linux" || process.platform === "darwin") {
      if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) throw new Error("Owned broker group is unavailable");
      const deadline = Date.now() + 5000;
      for (;;) {
        try { process.kill(-proc.pid, 0); }
        catch (error) { if (error?.code === "ESRCH") break; throw error; }
        if (Date.now() >= deadline) throw new Error("Owned broker group exit was not confirmed");
        await pause(50);
      }
    }
  };
  const retainFailure = async error => {
    try { await stopOwned(); }
    catch (stopError) { throw new AggregateError([error, stopError], `Fixture retained because broker termination was not confirmed: ${f.cwd}`); }
    throw error;
  };
  try {
    ({ child: proc, exited, session } = await startFixtureBroker(f.cwd, f.env, address, { state: stateApi, broker: brokerApi, onChild(child) {
      // 起動受付が失敗しても、spawn時点から直子のcloseを追跡する。
      proc = child;
      closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      onChild?.(child);
    } }));
  } catch (error) { return await retainFailure(error); }
  const stderr = () => fs.existsSync(session.logFile) ? fs.readFileSync(session.logFile, "utf8") : "";
  return {
    ...f,
    address,
    generation: session.generation,
    connect: (options = {}) => GrokAcpClient.connect(f.cwd, { ...options, brokerEndpoint: address, env: f.env }),
    close: async () => {
      try {
        if (proc.exitCode === null) {
          const client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, env: f.env });
          try {
            // client.closeの完了後もpeer側では切断処理とcancelのterminalが進行し得る。
            // 共有brokerの占有保護を緩めず、fixture所有の要求がdrainするまで待つ。
            await until(async () => {
              try {
                await client.request("broker/shutdown", {});
                return true;
              } catch (error) {
                if (error.rpcCode !== -32001) throw error;
                return false;
              }
            }, "broker disconnected requests drained before shutdown");
          } finally { await client.close(); }
        }
        if (!(await wait(exited, 5000))) throw new Error("Broker exit was not confirmed");
        assert.equal(proc.exitCode, 0, stderr());
        assert.doesNotMatch(stderr(), /Unhandled|uncaught|ERR_STREAM_WRITE_AFTER_END/);
      } catch (error) { await retainFailure(error); }
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
    const sample = () => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      const now = performance.now();
      maxLoopDelayMs = Math.max(maxLoopDelayMs, now - previous - 2);
      previous = now;
    };
    const samples = setInterval(sample, 2);
    const start = performance.now();
    const response = await prompt(client, sessionId, { mode, bytes, fragment, ...(mode === "input" ? { text: content(bytes) } : {}) });
    const elapsedMs = performance.now() - start;
    // 最終フレームで止まったタイマーが再実行される前でも、その遅延とheapを採取する。
    sample();
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

const transportChildMode = ["GROK_BROKER_FALLBACK_CHILD", "GROK_FALLBACK_START_FAILURE", "GROK_FALLBACK_CAUSE_CHILD",
  "GROK_BROKER_NOTIFICATION_CHILD", "GROK_BROKER_FAILURE_CHILD", "GROK_TRANSPORT_BACKPRESSURE",
  "GROK_TRANSPORT_FAILURE_CASE", "GROK_TRANSPORT_CANCEL", "GROK_TRANSPORT_MEASURE"].some(key => Boolean(process.env[key]));
if (process.platform === "linux") {
  if (transportChildMode) {
    process.once("beforeExit", () => {
      void cleanupOwnedFixtures().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        for (const cause of error.errors ?? []) process.stderr.write(`${cause.stack ?? cause}\n`);
        process.exitCode = 1;
      });
    });
  } else test.after(cleanupOwnedFixtures);
}

if (process.env.GROK_BROKER_FALLBACK_CHILD) {
  const { cwd, scenario } = JSON.parse(process.env.GROK_BROKER_FALLBACK_CHILD);
  const { runGrokTurn, runGrokReview } = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/grok.mjs")));
  if (["dispose-capacity", "dispose-success", "progress-completed", "reentrant-capacity", "reentrant-throw"].includes(scenario)) {
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (chunk, ...args) {
      try {
        const message = typeof chunk === "string" ? JSON.parse(chunk) : null;
        if (message?.method === "session/prompt" && message.params?.executionId) process.stderr.write("capacity fixture: broker prompt written\n");
      } catch { /* 他のストリームは観測対象外。 */ }
      return originalWrite.call(this, chunk, ...args);
    };
  }
  const callbackError = Object.assign(new Error("fake callback failure"), scenario === "callback-busy"
    ? { rpcCode: -32001 }
    : { rpcCode: -32003, data: { data: { source: "grok-broker", promptForwarded: false } } });
  const executionId = randomUUID();
  let capacityGated = false, promptCount = 0, capturedSend;
  const enqueuePrompt = (send, execution) => {
    promptCount += 1;
    if (scenario === "dispose-success" || scenario === "progress-completed") capturedSend = send;
    if (scenario === "cancel-before") return new Promise((resolve, reject) => {
      process.once("message", (message) => {
        if (message !== "release") return reject(new Error("Unexpected cancellation gate response"));
        try { Promise.resolve(send()).then(resolve, reject); } catch (error) { reject(error); }
      });
      process.send({ event: "cancel-before", sessionId: execution.sessionId, generation: execution.brokerGeneration, executionId });
    });
    if (["fake-success", "falsy-zero", "falsy-false", "falsy-null"].includes(scenario)) return new Promise((resolve, reject) => {
      try { void Promise.resolve(send()).catch(() => {}); } catch (error) { reject(error); return; }
      process.once("message", (message) => {
        if (message !== "release") return reject(new Error("Unexpected held prompt gate response"));
        if (scenario === "fake-success") resolve({ stopReason: "end_turn" });
        else reject(scenario === "falsy-zero" ? 0 : scenario === "falsy-false" ? false : null);
      });
      process.send("held-prompt-sent");
    });
    if ((["broker-capacity", "reentrant-capacity", "reentrant-throw", "dispose-capacity", "dispose-throw"].includes(scenario) && !capacityGated) || (scenario === "review-busy" && promptCount === 2)) return new Promise((resolve, reject) => {
      capacityGated = true;
      capturedSend = send;
      process.stderr.write("capacity fixture: broker prompt gate entered\n");
      process.once("message", (message) => {
        if (message !== "release") return reject(new Error("Unexpected capacity gate response"));
        process.stderr.write("capacity fixture: broker prompt gate released\n");
        try {
          let pending = Promise.resolve(send());
          if (scenario === "reentrant-capacity" || scenario === "reentrant-throw") pending = pending.catch((error) => {
            let reads = 0;
            Object.defineProperty(error, "turnStopUnconfirmed", { get() {
              reads += 1;
              if (reads === 2) {
                process.stderr.write("capacity fixture: getter reentered broker enqueue\n");
                try { void Promise.resolve(send()).catch(() => {}); } catch { /* cleanup preserves the original rejection */ }
                if (scenario === "reentrant-throw") throw new Error("stop evidence getter failed after enqueue");
              }
              return false;
            } });
            throw error;
          });
          pending.then(resolve, reject);
        } catch (error) { reject(error); }
      });
      process.send("capacity-ready");
    });
    if (scenario === "broker-capacity") process.stderr.write("capacity fixture: fallback prompt sent without another gate\n");
    const pending = send();
    if (scenario === "mutated-success") return pending.then((response) => {
      assert.equal(response.stopReason, "cancelled", "agent actually returned a cancelled terminal response");
      response.stopReason = "end_turn";
      return response;
    });
    if (scenario === "erased-terminal-data") return pending.catch((error) => {
      assert.equal(error.rpcResponseReceived, true, "received a real broker RPC error");
      assert.equal(error.rpcCode, -32000);
      assert.equal(error.data?.data?.turnStopConfirmed, false, "broker reported no terminal evidence");
      process.stderr.write("broker fixture: received genuine unconfirmed terminal metadata\n");
      delete error.data;
      throw error;
    });
    if (scenario !== "mutated-capacity" && scenario !== "mutated-unconfirmed") return pending;
    return pending.catch((error) => {
      error.rpcCode = -32003;
      error.data = { data: { source: "grok-broker", promptForwarded: false } };
      throw error;
    });
  };
  if (scenario === "dispose-capacity" || scenario === "dispose-success" || scenario === "dispose-throw") enqueuePrompt.connectionEstablished = (connection) => {
    if (connection.transport !== "broker") return;
    return () => {
      process.stderr.write("capacity fixture: broker disposer invoked\n");
      try { void Promise.resolve(capturedSend()).catch(() => {}); } catch { /* 送信口の閉鎖を確認する。 */ }
      if (scenario === "dispose-throw") throw new Error("broker disposer failed");
    };
  };
  try {
    const run = scenario === "review-busy" ? runGrokReview : runGrokTurn;
    const result = await run(cwd, {
      env: process.env,
      executionId,
      ...(scenario === "review-busy" ? { outputSchema: { type: "object" } } : {}),
      prompt: JSON.stringify(scenario === "mutated-capacity" ? { mode: "rpc-error" }
        : scenario === "mutated-unconfirmed" ? { mode: "notification-failure" }
        : scenario === "erased-terminal-data" ? { mode: "reverse-epipe" }
        : ["fake-success", "falsy-zero", "falsy-false", "falsy-null"].includes(scenario) ? { mode: "hold" }
        : scenario === "mutated-success" ? { mode: "finish-cancelled" }
        : ["missing-stop", "missing-result"].includes(scenario) ? { mode: scenario }
        : { mode: "input", text: "fresh turn" }),
      enqueuePrompt,
      onProgress: (event) => {
        if ((scenario === "callback-busy" || scenario === "callback-capacity") && event.message === "Starting Grok task session.") throw callbackError;
        if (scenario === "mutated-unconfirmed" && event.message?.startsWith("Tool:")) throw new Error("progress write failed");
        if (scenario === "progress-completed" && event.phase === "completed") {
          process.stderr.write("broker fixture: completed callback attempted enqueue\n");
          try { void Promise.resolve(capturedSend()).catch(() => {}); } catch { /* completed turn must not enqueue again */ }
        }
      }
    });
    console.log(JSON.stringify({ status: result.status, error: result.error?.message ?? null, errorCode: result.error?.rpcCode ?? null, turnStopUnconfirmed: result.turnStopUnconfirmed }));
  } catch (error) {
    console.log(JSON.stringify({ error: error?.message ?? String(error), callbackPreserved: error === callbackError,
      cause: error?.cause?.message ?? null,
      errors: error instanceof AggregateError ? error.errors.map((item) => item?.message ?? String(item)) : [],
      turnStopUnconfirmed: error?.turnStopUnconfirmed }));
  }
  if (process.connected) process.disconnect();
} else if (process.env.GROK_FALLBACK_START_FAILURE) {
  const f = fixture();
  const scenario = process.env.GROK_FALLBACK_START_FAILURE;
  const existing = new Error("existing broker detail");
  const previousCause = new Error("existing direct cause");
  const original = scenario === "null" ? null : scenario === "frozen"
    ? Object.freeze(new Error("frozen direct start error"))
    : Object.assign(new Error("direct start error", { cause: previousCause }), { brokerError: existing });
  let rejection;
  try {
    await GrokAcpClient.connect(f.cwd, {
      brokerEndpoint: endpoint(), grokBin: f.env.GROK_BIN, env: f.env,
      directAgentStarting: () => { throw original; }
    });
  } catch (error) { rejection = error; }
  assert.ok(rejection instanceof Error, "fallback must reject with a usable error");
  const found = new Set(), pending = [rejection];
  while (pending.length) {
    const error = pending.pop();
    if (found.has(error)) continue;
    found.add(error);
    if (error && typeof error === "object") pending.push(error.cause, error.brokerError);
  }
  assert.ok(found.has(original), "the original direct-start failure remains reachable");
  if (scenario === "existing") {
    assert.ok(found.has(existing), "pre-existing brokerError remains reachable");
    assert.ok(found.has(previousCause), "pre-existing cause remains reachable");
  }
  assert.ok([...found].some((error) => error && typeof error === "object" && ["ENOENT", "ECONNREFUSED"].includes(error.code)), "the broker connection failure remains reachable");
} else if (process.env.GROK_FALLBACK_CAUSE_CHILD === "1") {
  const f = fixture();
  f.env.TRANSPORT_BROKER_FAILURE = "1";
  f.env.TRANSPORT_START_STDERR = "1";
  const callbackError = Object.assign(new Error("startup diagnostic write failed"), { code: "EIO" });
  let stop, stopProof, rejection;
  try {
    try {
      await GrokAcpClient.connect(f.cwd, {
        brokerEndpoint: endpoint(), grokBin: f.env.GROK_BIN, env: f.env,
        onStderr: () => { throw callbackError; },
        directAgentStarting: (owner) => {
          stop = owner.close;
          return { finish: async (proof) => { stopProof = proof; return true; } };
        }
      });
    } catch (error) { rejection = error; }
  } finally { if (stop) await stop(); }
  assert.ok(rejection, "fallback initialization must reject");
  assert.equal(rejection.code, "EIO");
  assert.ok(stopProof, "owned direct agent stop is confirmed");
  await until(() => f.logs().some((entry) => entry.agentExited), "fake agent exited");
  const found = new Set(), pending = [rejection];
  while (pending.length) {
    const error = pending.pop();
    if (!error || typeof error !== "object" || found.has(error)) continue;
    found.add(error);
    pending.push(error.cause, error.brokerError);
  }
  assert.ok(found.has(callbackError), "original startup callback exception remains reachable");
  assert.ok([...found].some((error) => error !== callbackError && ["ENOENT", "ECONNREFUSED"].includes(error.code)), "original broker connection failure remains reachable");
} else if (process.env.GROK_BROKER_NOTIFICATION_CHILD) {
  const { cwd, address } = JSON.parse(process.env.GROK_BROKER_NOTIFICATION_CHILD);
  const client = await GrokAcpClient.connect(cwd, { brokerEndpoint: address, brokerOnly: true, env: process.env });
  try {
    const { sessionId } = await client.request("session/new", { cwd, mcpServers: [] });
    client.setNotificationHandler(() => { throw Object.assign(new Error("progress write failed"), { code: "EIO" }); });
    const pending = client.request("session/prompt", { sessionId, executionId: randomUUID(), prompt: [{ type: "text", text: JSON.stringify({ mode: "notification-failure" }) }] });
    await assert.rejects(pending, (error) => error.code === "EIO" && error.rpcResponseReceived !== true);
    await client.close();
    assert.equal(client.pending.size, 0);
  } finally { await client.close(); }
} else if (process.env.GROK_BROKER_FAILURE_CHILD) {
  const { cwd, address, logPath } = JSON.parse(process.env.GROK_BROKER_FAILURE_CHILD);
  const client = await GrokAcpClient.connect(cwd, { brokerEndpoint: address, brokerOnly: true, env: process.env });
  try {
    const { sessionId } = await client.request("session/new", { cwd, mcpServers: [] });
    let triggered = false;
    client.setNotificationHandler(() => {
      const logs = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.ok(logs.some((m) => m.failureAgentStdinClosed));
      assert.equal(logs.some((m) => m.failureAgentExited), false, "agent remains alive when a write to its closed stdin is attempted");
      const next = client.request("session/set_mode", { sessionId, modeId: "x".repeat(1024 * 1024) });
      void next.catch(() => {});
      triggered = true;
    });
    let error;
    try { await client.request("session/prompt", { sessionId, executionId: randomUUID(), prompt: [{ type: "text", text: JSON.stringify({ mode: "close-stdin" }) }] }); }
    catch (caught) { error = caught; }
    assert.equal(triggered, true, "a write was attempted while agent stdin was closed and agent was alive");
    assert.ok(error, "unfinished prompt must reject");
    assert.ok(error.rpcResponseReceived !== true || error.data?.data?.turnStopConfirmed === false, "broker failure is not an agent terminal response");
  } finally { await client.close(); }
} else if (process.env.GROK_TRANSPORT_BACKPRESSURE) {
  const f = fixture();
  const address = endpoint();
  let peer;
  const server = net.createServer((socket) => {
    peer = socket;
    socket.once("data", (data) => {
      const message = JSON.parse(String(data).trim());
      socket.pause();
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\n");
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath(address), resolve); });
  let client;
  try {
    client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
    // 実行中の通常broker clientと同じ close 経路へ切り替える。
    client.options.brokerOnly = false;
    client.setNotificationHandler(() => {
      if (process.env.GROK_TRANSPORT_BACKPRESSURE === "reentrant") void client.close();
      throw Object.assign(new Error("progress write failed"), { code: "EIO" });
    });
    const pending = client.request("session/prompt", { sessionId: "held", prompt: [{ type: "text", text: "x".repeat(32 * 1024 * 1024) }] });
    void pending.catch(() => {});
    await until(() => client.socket.writableLength > 0, "broker write remains buffered while peer is paused");
    peer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "held", update: { sessionUpdate: "tool_call", toolCallId: "failure" } } }) + "\n");
    await assert.rejects(pending, (error) => error.code === "EIO" && error.rpcResponseReceived !== true);
    await client.close();
    assert.equal(client.socket.destroyed, true, "fatal close must discard buffered writes and close the socket");
  } finally {
    peer?.destroy();
    await client?.close();
    await new Promise((resolve) => server.close(resolve));
  }
} else if (process.env.GROK_TRANSPORT_FAILURE_CASE) {
  const { transport, failure } = JSON.parse(process.env.GROK_TRANSPORT_FAILURE_CASE);
  let f, client, ownedBroker, brokerClosed, brokerWatchdog;
  let uncaught = null;
  try {
    f = transport === "broker" ? await brokerFixture((child) => {
      ownedBroker = child;
      brokerClosed = new Promise((resolve) => child.once("close", resolve));
      brokerWatchdog = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 12000);
    }) : fixture();
    client = transport === "broker" ? await f.connect() : await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.env.GROK_BIN, env: f.env });
    // RED時にも子agentと共有brokerを回収し、uncaught自体は失敗として親へ返す。
    process.on("uncaughtException", (error) => {
      uncaught ??= error;
      process.exitCode = 1;
      void client.close();
    });
    const { sessionId } = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
    let writeRequest;
    const nullPrototypeThrown = Object.create(null);
    const mutatingError = new Error("callback getter error");
    let rpcCodeReads = 0, dataReads = 0;
    Object.defineProperties(mutatingError, {
      rpcCode: { get: () => rpcCodeReads++ >= 2 ? -32003 : undefined },
      data: { get: () => dataReads++ >= 2 ? { data: { source: "grok-broker", promptForwarded: false } } : undefined }
    });
    if (failure === "stderr") client.options.onStderr = () => { throw Object.assign(new Error("diagnostic write failed"), { code: "ENOENT" }); };
    client.setNotificationHandler(() => {
      if (failure === "notification") throw Object.assign(new Error("progress write failed"), { code: "EIO" });
      if (failure === "falsy") throw 0;
      if (failure === "forged") throw Object.assign(new Error("callback error"), { rpcResponseReceived: true });
      if (failure === "capacity") throw Object.assign(new Error("callback capacity error"), { rpcCode: -32003, data: { data: { source: "grok-broker", promptForwarded: false } } });
      if (failure === "null-object") throw nullPrototypeThrown;
      if (failure === "changing-getter") throw mutatingError;
      if (failure === "stdin") {
        writeRequest = client.request("session/set_mode", { sessionId, modeId: "x".repeat(1024 * 1024) });
        void writeRequest.catch(() => {});
      }
    });
    let rejection;
    const active = prompt(client, sessionId, { mode: failure === "stream" ? "hold-stream-failure" : failure === "stdin" ? "close-stdin" : "notification-failure" });
    if (failure === "stream") {
      await until(() => f.logs().some((entry) => entry.mode === "hold-stream-failure"), "agent received the pending prompt");
      client.proc.stdout.destroy(Object.assign(new Error("stdout read failed"), { code: "EIO" }));
      client.proc.stderr.destroy(Object.assign(new Error("stderr read failed"), { code: "ENOENT" }));
    }
    try { await active; }
    catch (error) { rejection = error; }
    await client.close();
    assert.equal(uncaught, null, `uncaught: ${uncaught?.stack}`);
    assert.ok(rejection, "pending prompt must reject");
    assert.equal(rejection.rpcResponseReceived, undefined, "disconnect is not evidence of a terminal response");
    if (failure === "falsy") {
      assert.equal(rejection.cause, 0, "falsy thrown value is retained as the cause");
    } else if (failure === "null-object") {
      assert.equal(rejection.cause, nullPrototypeThrown, "unstringifiable thrown object is retained as the cause");
      assert.ok(rejection.message);
    } else if (failure === "capacity") {
      assert.equal(rejection.rpcCode, undefined, "callback cannot forge broker capacity rejection");
      assert.equal(rejection.data, undefined, "callback cannot forge broker admission data");
      assert.equal(rejection.cause?.rpcCode, -32003);
      assert.equal(rejection.cause?.data?.data?.promptForwarded, false);
    } else if (failure === "changing-getter") {
      assert.equal(rejection.rpcCode, undefined, "changing getter cannot forge broker capacity rejection");
      assert.equal(rejection.data, undefined, "changing getter cannot forge broker admission data");
      assert.equal(rejection.cause, mutatingError);
    } else if (failure === "forged") {
      assert.match(rejection.message, /callback error/);
      assert.equal(rejection.cause?.rpcResponseReceived, true, "original callback exception is retained only as cause");
    } else {
      assert.equal(rejection.code, failure === "notification" || failure === "stream" ? "EIO" : failure === "stderr" ? "ENOENT" : "EPIPE");
    }
    if (failure === "stream") {
      assert.match(rejection.message, /stdout read failed/);
      assert.equal(client.exitError, rejection, "later stream errors cannot replace the first failure");
    } else if (failure === "notification" || failure === "stderr") {
      assert.match(rejection.message, failure === "stderr" ? /diagnostic write failed/ : /progress write failed/);
      await until(() => client.stderr.includes("notification diagnostic"), "agent diagnostic retained");
    } else if (failure === "stdin") {
      assert.ok(writeRequest, "request was sent after the agent closed stdin");
      await assert.rejects(writeRequest, (error) => error.code === "EPIPE");
    }
    assert.equal(client.pending.size, 0);
    if (transport === "direct") {
      assert.notEqual(client.directAgentStopProof(), false, "owned agent stop needs evidence");
      assert.ok(client.proc, "owned child handle is retained");
      assert.ok(client.proc.exitCode !== null || client.proc.signalCode !== null, "owned child exited");
    } else {
      await until(() => f.logs().some((m) => m.cancelled === sessionId), "disconnect cancels the outstanding broker turn");
    }
  } finally {
    try {
      if (client) await client.close();
      if (transport === "broker" && f) await f.close();
    } finally {
      if (ownedBroker) {
        if (ownedBroker.exitCode === null && ownedBroker.signalCode === null) ownedBroker.kill();
        await brokerClosed;
      }
      clearTimeout(brokerWatchdog);
    }
  }
} else if (process.env.GROK_TRANSPORT_CANCEL === "1") {
  for (const transport of ["direct", "broker"]) for (let repeat = 0; repeat < 3; repeat += 1) {
    console.log(JSON.stringify({ ...await cancelDuringFrame(transport), repeat }));
  }
} else if (process.env.GROK_TRANSPORT_MEASURE === "1") {
  await measure();
} else {
  test("ACP broker keeps RPC error unconfirmed when its epoch check fails then recovers", { timeout: 60000, skip: process.platform !== "linux" }, async t => {
    let injection;
    const brokerSource = path.join(root, "plugins/grok/scripts/acp-broker.mjs");
    const lines = fs.readFileSync(brokerSource, "utf8").split("\n");
    const matches = lines.flatMap((line, index) => line.includes('error.rpcResponseReceived === true && epochValid()') ? [index + 1] : []);
    assert.equal(matches.length, 1, "the real broker error-response epoch boundary must be unambiguous");
    const f = await brokerFixture(undefined, configured => {
      injection = path.join(configured.cwd, "error-epoch-injected");
      const preload = path.join(configured.cwd, "error-epoch-injection.cjs");
      const source = [
        'const fs = require("node:fs"), mod = require("node:module");',
        'if (process.argv[1]?.endsWith("acp-broker.mjs")) {',
        '  Error.stackTraceLimit = 100; let fired = false;',
        '  for (const method of ["lstatSync", "openSync"]) {',
        '    const original = fs[method];',
        '    fs[method] = function(...args) {',
        '      if (!fired && typeof args[0] === "string" && args[0].endsWith("/state.lock")) {',
        '        const stack = new Error().stack ?? "";',
        '        if (stack.includes("verifyBrokerEpoch") && stack.includes(' + JSON.stringify('acp-broker.mjs:' + matches[0] + ':') + ')) {',
        '          fired = true; fs.writeFileSync(process.env.TRANSPORT_EPOCH_INJECTED, "one error-boundary epoch failure");',
        '          throw new Error("fixture epoch verification failure");',
        '        }',
        '      }',
        '      return original.apply(this, args);',
        '    };',
        '  }',
        '  mod.syncBuiltinESMExports();',
        '}'
      ].join("\n");
      fs.writeFileSync(preload, source);
      configured.env.TRANSPORT_EPOCH_INJECTED = injection;
      configured.env.NODE_OPTIONS = (configured.env.NODE_OPTIONS ?? "") + " --require=" + JSON.stringify(preload);
    });
    let control;
    try {
      const { runGrokTurn } = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/grok.mjs")));
      const executionId = "rpc-error-epoch-boundary";
      const result = await runGrokTurn(f.cwd, { env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: f.address,
        GROK_COMPANION_BROKER_GENERATION: f.generation }, executionId, prompt: JSON.stringify({ mode: "rpc-error" }),
        enqueuePrompt: enqueue => enqueue() });
      assert.ok(fs.existsSync(injection), "the broker error response must hit the injected epoch check");
      const prompts = f.logs().filter(row => row.mode === "rpc-error");
      assert.equal(prompts.length, 1, "the real agent receives exactly one prompt");
      assert.equal(result.sessionId, prompts[0].sessionId);
      control = await f.connect();
      const ledger = await control.request("broker/cancelTurn", { sessionId: result.sessionId, executionId, generation: f.generation });
      t.diagnostic(`ledger=${ledger.executionState}; clientStopUnconfirmed=${result.turnStopUnconfirmed}; error=${result.error?.message}`);
      assert.equal(ledger.executionState, "unknown", "a failed epoch check must leave the broker ledger unconfirmed");
      assert.equal(ledger.notificationSent, false);
      assert.equal(result.status, "failed");
      assert.equal(result.promptNotSent, false);
      assert.equal(result.turnStopUnconfirmed, true, "the client must receive the same unconfirmed terminal evidence");
    } finally {
      if (control) await control.close();
      await f.close();
    }
  });

  for (const mode of ["missing-stop", "unknown-stop", "typed-stop"]) test(`ACP broker rejects resume after ${mode} response`,
    { timeout: 60000, skip: process.platform !== "linux" }, async t => {
      const f = await brokerFixture();
      let control;
      try {
        const { runGrokTurn } = await import(pathToFileURL(path.join(root, "plugins/grok/scripts/lib/grok.mjs")));
        const executionId = "invalid-reason-" + mode;
        const result = await runGrokTurn(f.cwd, { env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: f.address,
          GROK_COMPANION_BROKER_GENERATION: f.generation }, executionId, prompt: JSON.stringify({ mode }),
          enqueuePrompt: enqueue => enqueue() });
        const prompts = f.logs().filter(row => row.mode === mode);
        assert.equal(prompts.length, 1, "the real agent receives exactly one prompt");
        assert.equal(result.sessionId, prompts[0].sessionId);
        control = await f.connect();
        const ledger = await control.request("broker/cancelTurn", { sessionId: result.sessionId, executionId, generation: f.generation });
        const inspection = await control.request("broker/inspectResumeSessions", { sessionIds: [result.sessionId], generation: f.generation });
        const load = await control.request("session/load", { sessionId: result.sessionId, cwd: f.cwd, mcpServers: [] })
          .then(() => ({ accepted: true }), error => ({ accepted: false, message: error.message }));
        t.diagnostic(`mode=${mode}; ledger=${ledger.executionState}; inspect=${inspection.sessions[0]?.terminal}; loadAccepted=${load.accepted}`);
        assert.equal(result.status, "failed");
        assert.equal(result.turnStopUnconfirmed, true);
        assert.equal(result.promptNotSent, false);
        assert.equal(ledger.executionState, "unknown");
        assert.equal(inspection.generation, f.generation);
        assert.deepEqual(inspection.sessions, [{ sessionId: result.sessionId, terminal: false }]);
        assert.equal(load.accepted, false, "a session with unconfirmed response must not load");
      } finally {
        if (control) await control.close();
        await f.close();
      }
    });

  for (const scenario of ["broker-capacity", "reentrant-capacity", "reentrant-throw", "dispose-capacity", "dispose-throw"]) test(`ACP real broker fallback: ${scenario} before the first prompt`, { timeout: process.platform === "linux" ? 900000 : 90000, skip: process.platform === "win32" }, async () => {
    const f = fixture();
    f.env.TRANSPORT_BROKER_FAILURE = "1";
    f.env.TRANSPORT_AGENT_LIFETIME_MS = process.platform === "linux" ? "930000" : "30000";
    if (process.platform === "linux") f.env.TRANSPORT_EXIT_ON_STDIN_END = "1";
    const address = endpoint();
    let broker, brokerClosed, worker, workerClosed, control;
    let brokerCloseObserved = false, workerCloseObserved = false, timedOut = false;
    const watchdog = process.platform === "linux" ? setTimeout(() => {
      timedOut = true;
      if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill();
      if (broker && broker.exitCode === null && broker.signalCode === null) broker.kill();
      if (control) void control.close().catch(() => {});
    }, 810000) : null;
    try {
      const started = await startFixtureBroker(f.cwd, f.env, address, { state: stateApi, broker: brokerApi, onChild(child) {
        broker = child;
        brokerClosed = new Promise((resolve) => child.once("close", () => { brokerCloseObserved = true; resolve(); }));
      } });
      control = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
      for (let index = 0; index < 4096; index += 1) {
        await control.request("broker/cancelTurn", { sessionId: "capacity-fill", executionId: `fill-${index}`, generation: started.session.generation });
      }
      worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: address,
        GROK_BROKER_FALLBACK_CHILD: JSON.stringify({ cwd: f.cwd, scenario }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stdout = "", stderr = "", spawnError;
      worker.stdout.on("data", (chunk) => { stdout += chunk; });
      worker.stderr.on("data", (chunk) => { stderr += chunk; });
      worker.once("error", (error) => { spawnError = error; });
      workerClosed = new Promise((resolve) => worker.once("close", (code, signal) => { workerCloseObserved = true; resolve({ code, signal }); }));
      const gate = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("capacity gate timed out")), 10000);
        worker.once("message", (message) => { clearTimeout(timer); if (message === "capacity-ready") resolve(undefined); else reject(new Error("unexpected capacity gate message")); });
        worker.once("exit", () => { clearTimeout(timer); reject(new Error(`worker exited before capacity gate: ${stderr}`)); });
      });
      const watchdog = setTimeout(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); }, 20000);
      let outcome;
      try {
        await gate;
        await control.request("broker/cancelTurn", { sessionId: "capacity-fill", executionId: "overflow", generation: started.session.generation });
        worker.send("release");
        outcome = await workerClosed;
      } finally { clearTimeout(watchdog); }
      assert.equal(timedOut, false, "capacity fixture watchdog expired");
      assert.equal(spawnError, undefined);
      assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
      const result = JSON.parse(stdout.trim());
      const logs = f.logs();
      const agents = logs.filter((entry) => entry.pid);
      const prompts = logs.filter((entry) => entry.mode === "input");
      if (scenario === "broker-capacity" || scenario === "dispose-capacity" || scenario === "reentrant-capacity") {
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(result.turnStopUnconfirmed, false, "direct turn and agent stop must be confirmed");
        assert.equal(agents.length, 2, "a real capacity rejection starts one direct agent");
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].agentPid, agents[1].pid, "no prompt was forwarded to the broker-owned agent");
        assert.ok(logs.some(entry => entry.agentExited === agents[1].pid), "the direct agent must have exited");
        if (scenario === "reentrant-capacity") {
          assert.match(stderr, /getter reentered broker enqueue/, "getter ran after the original broker response");
          assert.equal((stderr.match(/broker prompt written/g) ?? []).length, 1, "getter reentry cannot write a second broker prompt");
        }
        if (scenario === "dispose-capacity") {
          assert.match(stderr, /broker disposer invoked/);
          assert.equal((stderr.match(/broker prompt written/g) ?? []).length, 1, "disposer cannot send a second broker prompt");
        }
      } else if (scenario === "dispose-throw") {
        assert.match(stderr, /broker disposer invoked/);
        assert.match(`${result.error ?? ""} ${result.cause ?? ""} ${(result.errors ?? []).join(" ")}`, /broker disposer failed/);
        assert.match(`${result.error ?? ""} ${result.cause ?? ""} ${(result.errors ?? []).join(" ")}`, /capacity/i);
        assert.equal(agents.length, 1, "disposer failure must not start a direct agent");
        assert.equal(prompts.length, 0, "no prompt was forwarded");
      } else {
        assert.match(stderr, /getter reentered broker enqueue/, "getter ran after the original broker response");
        assert.match(`${result.error ?? ""} ${result.cause ?? ""} ${(result.errors ?? []).join(" ")}`, /getter failed/i, "getter failure remains visible");
        assert.match(`${result.error ?? ""} ${result.cause ?? ""} ${(result.errors ?? []).join(" ")}`, /capacity/i, "original capacity error remains visible");
        assert.equal((stderr.match(/broker prompt written/g) ?? []).length, 1, "getter reentry cannot write a second broker prompt");
        assert.equal(result.turnStopUnconfirmed, true, "the throwing getter must preserve the conservative result");
        assert.equal(agents.length, 1, "getter failure must not cause a direct fallback");
        assert.equal(prompts.length, 0, "no direct prompt or broker prompt was sent");
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (process.platform !== "linux") {
        if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill();
        if (workerClosed) await workerClosed;
        if (broker && broker.exitCode === null && broker.signalCode === null) {
          try {
            if (!control || control.closed) control = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
            await control.request("broker/shutdown", {});
          } catch {
            await until(() => { const logs = f.logs(); return logs.filter((entry) => entry.pid).every((entry) => logs.some((done) => done.agentExited === entry.pid)); }, "fake agents exited before broker cleanup", 35000);
            if (broker.exitCode === null && broker.signalCode === null) broker.kill();
          }
        }
        if (control) await control.close();
        if (brokerClosed) await brokerClosed;
        await until(() => { const logs = f.logs(); return logs.filter((entry) => entry.pid).every((entry) => logs.some((done) => done.agentExited === entry.pid)); }, "owned fake agents exited", 35000);
      } else {
        const cleanupErrors = [];
        if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill();
        if (workerClosed) {
          try { await until(() => workerCloseObserved, "owned worker closed", 15000); await workerClosed; }
          catch (error) { cleanupErrors.push(error); }
        }
        if (broker && broker.exitCode === null && broker.signalCode === null) {
          try {
            if (!control || control.closed) control = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
            await control.request("broker/shutdown", {});
            await until(() => brokerCloseObserved, "owned broker closed after shutdown", 15000);
          } catch {
            if (broker.exitCode === null && broker.signalCode === null) broker.kill();
          }
        }
        if (control) { try { await control.close(); } catch (error) { cleanupErrors.push(error); } }
        if (brokerClosed) {
          try { await until(() => brokerCloseObserved, "owned broker closed", 15000); await brokerClosed; }
          catch (error) { cleanupErrors.push(error); }
        }
        try {
          await until(() => {
            const logs = f.logs();
            if (!logs.filter((entry) => entry.pid).every((entry) => logs.some((done) => done.agentExited === entry.pid))) return false;
            // 起動直後の未記録 agent も fixture ownership 側の spawn / group 検証で確認する。
            return true;
          }, "owned fake agents exited", 15000);
        } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Fixture retained at ${f.cwd}: owned process termination was not confirmed`);
      }
    }
  });
  for (const scenario of ["agent-busy", "callback-busy", "callback-capacity", "mutated-capacity", "mutated-unconfirmed", "erased-terminal-data", "fake-success", "falsy-zero", "falsy-false", "falsy-null", "mutated-success", "cancel-before", "dispose-success", "progress-completed", "missing-stop", "missing-result", "broker-busy", "review-busy"]) {
    test(`ACP real broker fallback: ${scenario} preserves origin and turn ownership`, { timeout: 90000, skip: process.platform === "win32" }, async () => {
      const f = fixture();
      f.env.TRANSPORT_BROKER_FAILURE = "1";
      if (scenario === "agent-busy") f.env.TRANSPORT_NEW_BUSY = "1";
      if (scenario === "review-busy") { f.env.TRANSPORT_REVIEW_FIXTURE = "1"; f.env.TRANSPORT_AGENT_LIFETIME_MS = "30000"; }
      const address = endpoint();
      let broker, brokerClosed, worker, workerClosed, holder, held, heldSession;
      try {
        const started = await startFixtureBroker(f.cwd, f.env, address, { state: stateApi, broker: brokerApi, onChild(child) {
          broker = child;
          brokerClosed = new Promise((resolve) => child.once("close", resolve));
        } });
        if (scenario === "broker-busy") {
          holder = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
          heldSession = (await holder.request("session/new", { cwd: f.cwd, mcpServers: [] })).sessionId;
          held = prompt(holder, heldSession, { mode: "hold" });
          void held.catch(() => {});
          await until(() => f.logs().some((entry) => entry.mode === "hold"), "other owner turn reached the agent");
        }
        worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: address,
          GROK_BROKER_FALLBACK_CHILD: JSON.stringify({ cwd: f.cwd, scenario }) }, windowsHide: true,
          stdio: ["review-busy", "fake-success", "falsy-zero", "falsy-false", "falsy-null", "cancel-before"].includes(scenario) ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "", spawnError;
        worker.stdout.on("data", (chunk) => { stdout += chunk; });
        worker.stderr.on("data", (chunk) => { stderr += chunk; });
        worker.once("error", (error) => { spawnError = error; });
        workerClosed = new Promise((resolve) => worker.once("close", (code, signal) => resolve({ code, signal })));
        const watchdog = setTimeout(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); }, 15000);
        let outcome;
        try {
          if (scenario === "review-busy") {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("review repair gate timed out")), 10000);
              worker.once("message", (message) => { clearTimeout(timer); if (message === "capacity-ready") resolve(undefined); else reject(new Error("unexpected review gate message")); });
              worker.once("exit", () => { clearTimeout(timer); reject(new Error(`worker exited before review gate: ${stderr}`)); });
            });
            assert.equal(f.logs().filter((entry) => entry.mode === "review-first").length, 1, "first review prompt reached its terminal before repair");
            assert.ok(f.logs().some((entry) => entry.finished), "first review prompt returned its terminal response");
            holder = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
            heldSession = (await holder.request("session/new", { cwd: f.cwd, mcpServers: [] })).sessionId;
            held = prompt(holder, heldSession, { mode: "hold" });
            void held.catch(() => {});
            await until(() => f.logs().some((entry) => entry.mode === "hold"), "other owner occupies broker before repair");
            worker.send("release");
          } else if (scenario === "cancel-before") {
            const admission = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("cancel-before gate timed out")), 10000);
              worker.once("message", (message) => { clearTimeout(timer); if (message?.event === "cancel-before") resolve(message); else reject(new Error("unexpected cancellation gate message")); });
              worker.once("exit", () => { clearTimeout(timer); reject(new Error(`worker exited before cancellation gate: ${stderr}`)); });
            });
            assert.equal(admission.generation, started.session.generation);
            const cancellation = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
            try {
              const result = await cancellation.request("broker/cancelTurn", { sessionId: admission.sessionId, executionId: admission.executionId, generation: admission.generation });
              assert.equal(result.reservationAccepted, true);
              assert.equal(result.executionState, "never-accepted");
              assert.equal(result.notificationSent, false);
            } finally { await cancellation.close(); }
            worker.send("release");
          } else if (["fake-success", "falsy-zero", "falsy-false", "falsy-null"].includes(scenario)) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("held prompt gate timed out")), 10000);
              worker.once("message", (message) => { clearTimeout(timer); if (message === "held-prompt-sent") resolve(undefined); else reject(new Error("unexpected held prompt gate message")); });
              worker.once("exit", () => { clearTimeout(timer); reject(new Error(`worker exited before held prompt gate: ${stderr}`)); });
            });
            await until(() => f.logs().some((entry) => entry.mode === "hold"), "agent received the real prompt");
            const active = f.logs().find((entry) => entry.mode === "hold");
            assert.equal(f.logs().some((entry) => entry.finished === active.prompt), false, "real prompt has no terminal response at the gate");
            worker.send("release");
          }
          outcome = await workerClosed;
        } finally { clearTimeout(watchdog); }
        assert.equal(spawnError, undefined);
        assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
        const result = JSON.parse(stdout.trim());
        const logs = f.logs();
        const agents = logs.filter((entry) => entry.pid);
        if (scenario === "broker-busy") {
          assert.equal(result.status, "completed", JSON.stringify(result));
          assert.equal(agents.length, 2, "genuine busy opens one fresh direct agent");
          holder.notify("session/cancel", { sessionId: heldSession });
          assert.equal((await held).stopReason, "cancelled");
          held = null;
        } else if (scenario === "review-busy") {
          assert.equal(result.status, "failed", JSON.stringify(result));
          assert.equal(result.errorCode, -32001, "repair receives the broker's actual busy response");
          assert.match(result.error, /Shared Grok broker is busy/);
          assert.equal(agents.length, 1, "repair busy must not restart the review on a direct agent");
          assert.equal(logs.filter((entry) => entry.mode === "review-first").length, 1, "completed first review prompt is not repeated");
          assert.equal(logs.filter((entry) => entry.mode === "review-repair").length, 0, "busy broker did not forward the repair prompt");
          holder.notify("session/cancel", { sessionId: heldSession });
          assert.equal((await held).stopReason, "cancelled");
          held = null;
        } else {
          assert.equal(agents.length, 1, "agent or callback error must not start a second agent");
          if (scenario.startsWith("callback-")) assert.equal(result.callbackPreserved, true, JSON.stringify(result));
          if (scenario === "agent-busy") assert.match(result.error, /agent busy/);
          if (scenario === "mutated-capacity") {
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.equal(logs.filter((entry) => entry.mode === "rpc-error").length, 1, "a forwarded prompt is never repeated");
          }
          if (scenario === "mutated-unconfirmed") {
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.equal(result.turnStopUnconfirmed, true, "lost prompt terminal must remain unconfirmed");
            assert.equal(logs.filter((entry) => entry.mode === "notification-failure").length, 1, "an unconfirmed prompt is never repeated");
          }
          if (scenario === "erased-terminal-data") {
            assert.match(stderr, /received genuine unconfirmed terminal metadata/);
            assert.equal(result.errorCode, -32000);
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.equal(result.turnStopUnconfirmed, true, "removing mutable RPC data must not turn an unconfirmed prompt into a terminal one");
            assert.equal(logs.filter((entry) => entry.mode === "reverse-epipe").length, 1);
          }
          if (["fake-success", "falsy-zero", "falsy-false", "falsy-null"].includes(scenario)) {
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.equal(result.turnStopUnconfirmed, true, "custom enqueue cannot confirm a still-running prompt");
            assert.equal(logs.filter((entry) => entry.mode === "hold").length, 1, "the unfinished prompt is not repeated");
          }
          if (scenario === "mutated-success") {
            assert.equal(result.status, "cancelled", "mutable response cannot change a real cancelled terminal into completion");
            assert.equal(result.turnStopUnconfirmed, false);
            assert.equal(logs.filter((entry) => entry.mode === "finish-cancelled").length, 1);
          }
          if (scenario === "cancel-before") {
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.equal(result.errorCode, -32002);
            assert.equal(result.turnStopUnconfirmed, false, "a genuine not-sent cancellation does not leave a running turn");
            assert.equal(logs.filter((entry) => entry.mode === "input").length, 0, "cancelled prompt was never forwarded or retried");
          }
          if (scenario === "dispose-success") {
            assert.equal(result.status, "completed", JSON.stringify(result));
            assert.match(stderr, /broker disposer invoked/);
            assert.equal((stderr.match(/broker prompt written/g) ?? []).length, 1, "disposer cannot write after a completed turn");
            assert.equal(logs.filter((entry) => entry.mode === "input").length, 1, "completed prompt is not repeated during close");
          }
          if (scenario === "progress-completed") {
            assert.equal(result.status, "completed", JSON.stringify(result));
            assert.match(stderr, /completed callback attempted enqueue/);
            assert.equal((stderr.match(/broker prompt written/g) ?? []).length, 1, "completed callback cannot write a second prompt");
            assert.equal(logs.filter((entry) => entry.mode === "input").length, 1, "a completed turn cannot start a new turn");
          }
          if (["missing-stop", "missing-result"].includes(scenario)) {
            assert.notEqual(result.status, "completed", "partial text without a valid stopReason cannot complete the turn");
            assert.equal(logs.filter((entry) => entry.mode === scenario).length, 1);
          }
        }
      } finally {
        if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill();
        if (workerClosed) await workerClosed;
        if (holder) {
          if (held && !holder.closed) holder.notify("session/cancel", { sessionId: heldSession });
          if (held) await held.catch(() => {});
          await holder.close();
        }
        if (broker && broker.exitCode === null && broker.signalCode === null) {
          try {
            const cleanup = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
            try { await cleanup.request("broker/shutdown", {}); } finally { await cleanup.close(); }
          } catch {
            await until(() => { const logs = f.logs(); return logs.filter((entry) => entry.pid).every((entry) => logs.some((done) => done.agentExited === entry.pid)); }, "all fake agents exited before broker cleanup", 15000);
            if (broker.exitCode === null && broker.signalCode === null) broker.kill();
          }
        }
        if (brokerClosed) await brokerClosed;
        await until(() => { const logs = f.logs(); return logs.filter((entry) => entry.pid).every((entry) => logs.some((done) => done.agentExited === entry.pid)); }, "owned fake agents exited", 15000);
      }
    });
  }
  for (const scenario of ["missing-stop", "missing-result"]) test(`ACP direct: ${scenario} cannot mark partial text completed`, { timeout: 30000, skip: process.platform === "win32" }, async () => {
    const f = fixture();
    f.env.TRANSPORT_BROKER_FAILURE = "1";
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...f.env, GROK_COMPANION_DISABLE_BROKER: "1",
      GROK_BROKER_FALLBACK_CHILD: JSON.stringify({ cwd: f.cwd, scenario }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", spawnError;
    worker.stdout.on("data", (chunk) => { stdout += chunk; });
    worker.stderr.on("data", (chunk) => { stderr += chunk; });
    worker.once("error", (error) => { spawnError = error; });
    const closed = new Promise((resolve) => worker.once("close", (code, signal) => resolve({ code, signal })));
    const watchdog = setTimeout(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); }, 15000);
    try {
      const outcome = await closed;
      assert.equal(spawnError, undefined);
      assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
      const result = JSON.parse(stdout.trim());
      assert.notEqual(result.status, "completed", "partial text without a valid stopReason cannot complete the turn");
      assert.equal(f.logs().filter((entry) => entry.mode === scenario).length, 1);
    } finally {
      clearTimeout(watchdog);
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
      await closed;
      await until(() => { const logs = f.logs(); return logs.filter((entry) => entry.pid).every((entry) => logs.some((done) => done.agentExited === entry.pid)); }, "owned fake agent exited", 15000);
    }
  });
  for (const scenario of ["null", "frozen", "existing"]) test(`ACP direct fallback: ${scenario} direct-start failure preserves original details`, { timeout: 30000 }, async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GROK_FALLBACK_START_FAILURE: scenario }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", spawnError;
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    const watchdog = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 20000);
    let outcome;
    try { outcome = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))); }
    finally { clearTimeout(watchdog); }
    assert.equal(spawnError, undefined);
    assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
  });
  test("ACP direct fallback: startup callback failure retains both original causes", { timeout: 30000, skip: process.platform === "win32" }, async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GROK_FALLBACK_CAUSE_CHILD: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", spawnError;
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    const watchdog = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 20000);
    let outcome;
    try { outcome = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))); }
    finally { clearTimeout(watchdog); }
    assert.equal(spawnError, undefined);
    assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
  });
  test("ACP broker: client callback failure cancels its turn and releases ownership", { timeout: 90000, skip: process.platform === "win32" }, async () => {
    const f = fixture();
    f.env.TRANSPORT_BROKER_FAILURE = "1";
    const address = endpoint();
    let broker, brokerClosed, clientChild;
    try {
      const started = await startFixtureBroker(f.cwd, f.env, address, { state: stateApi, broker: brokerApi, onChild(child) {
        broker = child;
        brokerClosed = new Promise((resolve) => child.once("close", resolve));
      } });
      clientChild = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...f.env, GROK_BROKER_NOTIFICATION_CHILD: JSON.stringify({ cwd: f.cwd, address }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", spawnError;
      clientChild.stdout.resume();
      clientChild.stderr.on("data", (chunk) => { stderr += chunk; });
      clientChild.once("error", (error) => { spawnError = error; });
      const watchdog = setTimeout(() => { if (clientChild.exitCode === null && clientChild.signalCode === null) clientChild.kill(); }, 15000);
      let outcome;
      try { outcome = await new Promise((resolve) => clientChild.once("close", (code, signal) => resolve({ code, signal }))); }
      finally { clearTimeout(watchdog); }
      assert.equal(spawnError, undefined);
      assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
      const active = f.logs().find((m) => m.mode === "notification-failure");
      assert.ok(active?.sessionId);
      await until(() => f.logs().some((m) => m.cancelled === active.sessionId), "broker cancels the lost client's turn");
      await until(() => f.logs().some((m) => m.finished === active.prompt), "agent returns terminal after cancellation");
      const next = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
      try {
        let session;
        await until(async () => {
          try { session = await next.request("session/new", { cwd: f.cwd, mcpServers: [] }); return true; }
          catch (error) { if (error.rpcCode !== -32001) throw error; return false; }
        }, "broker releases ownership after the terminal response");
        assert.notEqual(session.sessionId, active.sessionId);
        assert.equal((await prompt(next, session.sessionId, { mode: "input", text: "new turn" })).stopReason, "end_turn");
        await next.request("broker/shutdown", {});
      } finally { await next.close(); }
      await brokerClosed;
      await until(() => f.logs().some((m) => m.agentExited), "broker-owned fake agent exited");
      assert.doesNotMatch(fs.readFileSync(started.session.logFile, "utf8"), /uncaught|Unhandled/i);
    } finally {
      if (clientChild && clientChild.exitCode === null && clientChild.signalCode === null) {
        const closed = new Promise((resolve) => clientChild.once("close", resolve));
        clientChild.kill();
        await closed;
      }
      if (broker && broker.exitCode === null && broker.signalCode === null) {
        await until(() => { const logs = f.logs(); return logs.filter((m) => m.pid).every((m) => logs.some((entry) => entry.agentExited === m.pid)); }, "fixture agent exited before broker cleanup", 15000);
        try {
          const cleanup = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
          try { await cleanup.request("broker/shutdown", {}); } finally { await cleanup.close(); }
        } catch { if (broker.exitCode === null && broker.signalCode === null) broker.kill(); }
      }
      if (brokerClosed) await brokerClosed;
    }
  });
  test("ACP broker: agent stdin failure retires the broker without confirming the interrupted turn", { timeout: 90000, skip: process.platform === "win32" }, async () => {
    const f = fixture();
    f.env.TRANSPORT_BROKER_FAILURE = "1";
    const address = endpoint();
    let broker, brokerClosed, clientChild, restarted, restartedClosed, restartedFixture, unexpectedBroker, unexpectedClosed;
    try {
      const first = await startFixtureBroker(f.cwd, f.env, address, { state: stateApi, broker: brokerApi, onChild(child) {
        broker = child;
        brokerClosed = new Promise((resolve) => child.once("close", resolve));
      } });
      clientChild = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...f.env, GROK_BROKER_FAILURE_CHILD: JSON.stringify({ cwd: f.cwd, address, logPath: f.env.TRANSPORT_LOG }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", spawnError;
      clientChild.stdout.resume();
      clientChild.stderr.on("data", (chunk) => { stderr += chunk; });
      clientChild.once("error", (error) => { spawnError = error; });
      const watchdog = setTimeout(() => { if (clientChild.exitCode === null && clientChild.signalCode === null) clientChild.kill(); }, 15000);
      let outcome;
      try { outcome = await new Promise((resolve) => clientChild.once("close", (code, signal) => resolve({ code, signal }))); }
      finally { clearTimeout(watchdog); }
      assert.equal(spawnError, undefined);
      assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
      await until(() => f.logs().some((m) => m.failureAgentExited), "fixture agent exited", 7000);
      await until(() => broker.exitCode !== null || broker.signalCode !== null, "broker retired after agent failure", 3000);
      await brokerClosed;
      assert.match(fs.readFileSync(first.session.logFile, "utf8"), /EPIPE|broken pipe/i, "broker diagnostic identifies the agent stdin failure");
      const brokerDir = brokerApi.resolveBrokerStateDir(f.cwd);
      const journalPath = path.join(brokerDir, "broker-admission.jsonl");
      const sessionPath = path.join(brokerDir, "broker.json");
      const journal = fs.readFileSync(journalPath);
      const sessionRecord = fs.readFileSync(sessionPath);
      let unexpectedSpawn = false;
      await assert.rejects(startFixtureBroker(f.cwd, f.env, endpoint(), { state: stateApi, broker: brokerApi, onChild(child) {
        unexpectedSpawn = true;
        unexpectedBroker = child;
        unexpectedClosed = new Promise((resolve) => child.once("close", resolve));
      } }), /broker generation could not be confirmed/i);
      assert.equal(unexpectedSpawn, false, "unconfirmed prior generation blocks a new broker");
      assert.deepEqual(fs.readFileSync(journalPath), journal, "admission evidence remains unchanged");
      assert.deepEqual(fs.readFileSync(sessionPath), sessionRecord, "broker generation record remains unchanged");
      restartedFixture = fixture();
      restartedFixture.env.TRANSPORT_BROKER_FAILURE = "1";
      const freshAddress = endpoint();
      const fresh = await startFixtureBroker(restartedFixture.cwd, restartedFixture.env, freshAddress, { state: stateApi, broker: brokerApi, onChild(child) {
        restarted = child;
        restartedClosed = new Promise((resolve) => child.once("close", resolve));
      } });
      assert.notEqual(fresh.session.generation, first.session.generation);
      const next = await GrokAcpClient.connect(restartedFixture.cwd, { brokerEndpoint: freshAddress, brokerOnly: true, env: restartedFixture.env });
      try {
        const session = await next.request("session/new", { cwd: restartedFixture.cwd, mcpServers: [] });
        assert.ok(session.sessionId);
        await next.request("broker/shutdown", {});
      } finally { await next.close(); }
      await restartedClosed;
    } finally {
      // このテスト本体が broker handle を保持し、agent の終了を先に確認する。
      if (clientChild && clientChild.exitCode === null && clientChild.signalCode === null) clientChild.kill();
      if (clientChild && clientChild.exitCode === null && clientChild.signalCode === null) await new Promise((resolve) => clientChild.once("close", resolve));
      if (broker && broker.exitCode === null && broker.signalCode === null) {
        await until(() => { const logs = f.logs(); return logs.filter((m) => m.pid).every((m) => logs.some((entry) => entry.agentExited === m.pid)); }, "fixture agents exited before broker cleanup", 15000);
        try {
          const cleanup = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: address, brokerOnly: true, env: f.env });
          try { await cleanup.request("broker/shutdown", {}); } finally { await cleanup.close(); }
        } catch { if (broker.exitCode === null && broker.signalCode === null) broker.kill(); }
      }
      if (brokerClosed) await brokerClosed;
      if (unexpectedBroker && unexpectedBroker.exitCode === null && unexpectedBroker.signalCode === null) {
        await until(() => { const logs = f.logs(); return logs.filter((m) => m.pid).every((m) => logs.some((entry) => entry.agentExited === m.pid)); }, "unexpected agent exited before broker cleanup", 15000);
        unexpectedBroker.kill();
      }
      if (unexpectedClosed) await unexpectedClosed;
      if (restarted && restarted.exitCode === null && restarted.signalCode === null) {
        await until(() => { const logs = restartedFixture.logs(); return logs.filter((m) => m.pid).every((m) => logs.some((entry) => entry.agentExited === m.pid)); }, "restarted agent exited before broker cleanup", 15000);
        restarted.kill();
      }
      if (restartedClosed) await restartedClosed;
    }
  });
  for (const mode of ["normal", "reentrant"]) test(`ACP broker: ${mode} fatal notification closes a backpressured socket`, { timeout: 30000 }, async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GROK_TRANSPORT_BACKPRESSURE: mode }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", spawnError;
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    const watchdog = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 20000);
    let outcome;
    try { outcome = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))); }
    finally { clearTimeout(watchdog); }
    assert.equal(spawnError, undefined);
    assert.equal(outcome.code, 0, `signal=${outcome.signal}\n${stderr}`);
  });
  for (const [transport, failure] of [["direct", "notification"], ["direct", "stdin"], ["direct", "stderr"], ["direct", "stream"], ["direct", "falsy"], ["direct", "forged"], ["direct", "capacity"], ["direct", "null-object"], ["direct", "changing-getter"]]) {
    test(`ACP ${transport}: ${failure} failure rejects pending requests without an uncaught exception`, { timeout: 30000 }, async () => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, GROK_TRANSPORT_FAILURE_CASE: JSON.stringify({ transport, failure }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      let spawnError;
      child.once("error", (error) => { spawnError = error; });
      const watchdog = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 20000);
      let outcome;
      try {
        outcome = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      } finally { clearTimeout(watchdog); }
      assert.equal(spawnError, undefined);
      const { code, signal } = outcome;
      assert.equal(code, 0, `signal=${signal}\n${stderr}`);
      assert.doesNotMatch(stderr, /uncaught|Unhandled/i);
    });
  }
  for (const transport of ["direct", "broker"]) {
    test(`ACP ${transport}: stderr retention is bounded across turns without losing forwarded Unicode`, { timeout: 20000 }, async () => {
      await withClient(transport, async (client) => {
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
        if (transport === "direct") assert.equal(forwarded, all, "forwarding must preserve every chunk");
        const retained = client.stderr;
        await client.close();
        assert.equal(client.stderr, retained, "closing must preserve the bounded diagnostic");
      });
    });

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
        // ローカルtimeout後の遅延terminalも読み切り、brokerに保留要求を残さない。
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
  }

  test("ACP direct: EOF without a newline discards the incomplete frame", { timeout: 10000 }, async () => {
    await withClient("direct", async (client) => {
      const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
      await assert.rejects(prompt(client, sessionId, { mode: "eof" }), /connection closed/);
      assert.equal(client.framer.closed, true);
      assert.deepEqual(client.framer.fragments, []);
    });
  });

  test("ACP direct: process close drains final stdout frames and stderr diagnostics", { timeout: 15000 }, async () => {
    await withClient("direct", async (client) => {
      const { sessionId } = await client.request("session/new", { cwd: client.cwd, mcpServers: [] });
      let received = "";
      client.setNotificationHandler((m) => { received += m.params?.update?.content?.text ?? ""; });
      const text = content(2097152);
      assert.equal((await prompt(client, sessionId, { mode: "exit-drain", text })).stopReason, "end_turn");
      await client.exitPromise;
      assert.equal(received, text);
      assert.match(client.exitError.message, /exit 7/);
      assert.match(client.exitError.message, /final diagnostic 日🙂/);
      assert.equal(client.pending.size, 0);
    });
  });

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
      const releaseKey = "old-owner-reverse";
      const abandoned = prompt(first, oldSession.sessionId, { mode: "late", delay: 250, finishAfter: 600, releaseKey, requests: [
        { id: 9101, method: "fs/write_text_file", params: { path: target, content: "old-owner" } },
        { id: 9102, method: "fs/read_text_file", params: { path: readTarget } },
        { id: 9103, method: "session/request_permission", params: { options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } }
      ] }).catch(() => {});
      await until(() => f.logs().some((m) => m.mode === "late"), "old prompt received");
      await Promise.all([first.close(), first.close()]);
      await abandoned;
      assert.equal(first.pending.size, 0);
      next = await f.connect({ clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, permissionHandler: () => { permissions += 1; return { outcome: { outcome: "selected", optionId: "allow" } }; } });
      let newSession;
      // 旧promptのterminalが届くまでは占有を保つ。切断直後の解放を仮定しない。
      await until(async () => {
        try {
          newSession = await next.request("session/new", { cwd: f.cwd, mcpServers: [] });
          return true;
        } catch (error) {
          if (error.rpcCode !== -32001) throw error;
          return false;
        }
      }, "old prompt terminal released broker ownership");
      assert.notEqual(newSession.sessionId, oldSession.sessionId);
      const executionId = "reconnected-owner-hold";
      const active = next.request("session/prompt", { sessionId: newSession.sessionId, executionId,
        prompt: [{ type: "text", text: JSON.stringify({ mode: "hold" }) }] });
      void active.catch(() => {});
      await until(() => f.logs().some((m) => m.sessionId === newSession.sessionId && m.mode === "hold"), "new owner prompt received");
      await next.request("session/set_mode", { sessionId: newSession.sessionId, modeId: "release-reverse:" + releaseKey });
      await until(() => f.logs().filter((m) => m.response?.id >= 9101).length === 3, "late reverse requests resolved");
      const ordered = f.logs();
      const holdIndex = ordered.findIndex((m) => m.sessionId === newSession.sessionId && m.mode === "hold");
      const releaseIndex = ordered.findIndex((m) => m.sessionId === newSession.sessionId && m.releasedReverse === releaseKey);
      const reverseIndex = ordered.findIndex((m) => m.reverseSentForSession === oldSession.sessionId && m.releaseKey === releaseKey);
      assert.ok(holdIndex >= 0 && releaseIndex > holdIndex && reverseIndex > releaseIndex, "old reverse requests must follow the new owner's active prompt and explicit release");
      assert.equal(fs.existsSync(target), false, "old owner must not write through a new client");
      assert.equal(permissions, 0, "old owner must not invoke the new permission handler");
      assert.ok(f.logs().filter((m) => m.response?.id >= 9101).every((m) => m.response.error), "old reads and all other reverse requests must be rejected");
      assert.ok(f.logs().some((m) => m.cancelled === oldSession.sessionId), "disconnect cancels only the lost session");
      assert.equal(f.logs().some((m) => m.cancelled === newSession.sessionId), false);
      await assert.rejects(next.request("session/load", { sessionId: oldSession.sessionId, cwd: f.cwd, mcpServers: [] }), (error) => error.rpcCode === -32002);
      await next.request("broker/cancelTurn", { sessionId: newSession.sessionId, executionId, generation: f.generation });
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
