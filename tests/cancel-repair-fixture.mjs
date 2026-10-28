import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { removeTempFixture } from "./helpers.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ファイルの合図だけで順番を固定し、実アカウントと時間依存の競合を使わない。
const fake = String.raw`
import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  if (process.env.CANCEL_PROBE_DELAY) {
    fs.appendFileSync(process.env.CANCEL_TEST_LOG, JSON.stringify({ probe: true }) + "\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.CANCEL_PROBE_DELAY));
  }
  console.log("fake-grok 1.0"); process.exit(0);
}
const pending = new Map();
let reviewPrompts = 0;
let sessionNumber = 0;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const log = (m) => fs.appendFileSync(process.env.CANCEL_TEST_LOG, JSON.stringify(m) + "\n");
log({ started: process.pid });
const finish = (id, stopReason = "end_turn") => {
  log({ terminal: pending.get(id)?.name, stopReason });
  pending.delete(id);
  send({ id, result: { stopReason } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {
    loadSession: true, ...(process.env.CANCEL_LIST_SESSIONS ? { sessionCapabilities: { list: {} } } : {})
  } } });
  if (m.method === "session/new") return send({ id: m.id, result: {
    sessionId: process.env.CANCEL_NUMBERED_SESSIONS ? "session-" + (++sessionNumber) : "session-1"
  } });
  if (m.method === "session/load") {
    log({ loadedSession: m.params.sessionId });
    return send({ id: m.id, result: { sessionId: m.params.sessionId } });
  }
  if (m.method === "session/list") {
    log({ listedSessions: true });
    return send({ id: m.id, result: { sessions: JSON.parse(process.env.CANCEL_LIST_SESSIONS || "[]") } });
  }
  if (m.method === "session/cancel") {
    log({ cancel: m.params.sessionId });
    if (process.env.CANCEL_LOCK_REPRO_HOLD) fs.writeFileSync(process.env.CANCEL_REVIEW_GATE + ".arm", "armed");
    if (process.env.CANCEL_PROGRESS_AFTER_CANCEL) send({ method: "session/update", params: { sessionId: m.params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "late-progress", title: "late tool progress", status: "pending" } } });
    for (const [id, p] of pending) if (p.sessionId === m.params.sessionId && !p.ignoreCancel) finish(id, "cancelled");
    return;
  }
  if (m.method !== "session/prompt") return send({ id: m.id, error: { code: -32601, message: "unsupported" } });
  let p;
  try { p = JSON.parse(m.params.prompt[0].text); }
  catch {
    reviewPrompts++;
    p = { name: reviewPrompts === 1 ? "review-initial" : "review-repair", ignoreCancel: true,
      gate: reviewPrompts === 1 ? process.env.CANCEL_REVIEW_GATE : undefined };
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: reviewPrompts === 1 ? "malformed" : '{"verdict":"approve"}' }
    } } });
  }
  log({ prompt: p.name, params: m.params, gate: p.gate });
  p.sessionId = m.params.sessionId;
  if (process.env.CANCEL_FORGED_CAPACITY) {
    log({ terminal: p.name, stopReason: "rpc_error" });
    return send({ id: m.id, error: {
      code: -32003, message: "agent failed after side effect", data: { source: "grok-broker", promptForwarded: false }
    } });
  }
  pending.set(m.id, p);
  if (p.gate) {
    log({ gateArmed: p.name });
    const timer = setInterval(() => {
      if (!fs.existsSync(p.gate) && !fs.existsSync(process.env.CANCEL_FIXTURE_RELEASE)) return;
      clearInterval(timer);
      log({ gateReleased: p.name });
      if (pending.has(m.id)) finish(m.id);
    }, 5);
    return;
  }
  finish(m.id);
}).on("close", () => process.exit(0));
`;

export async function until(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(10);
  }
  throw new Error(`Timed out: ${label}`);
}

// 呼出元がspawnした直子専用。timer phase内で同期して確認・送信する。
export async function stopFixtureChild(child) {
  await new Promise((resolve, reject) => setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, "fixture must own a spawned child");
        assert.equal(child.kill("SIGTERM"), true, "fixture child termination signal must be sent");
      }
      resolve();
    } catch (error) { reject(error); }
  }, 0));
  await until(() => child.exitCode !== null || child.signalCode !== null, "fixture child exit", 3000);
}

let fixtureActive = false;
export async function fixture(t, extraEnv = {}) {
  if (fixtureActive) throw new Error("Cancel fixtures cannot share the process environment concurrently");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-repair-e2e-"));
  const script = path.join(cwd, "agent.mjs");
  fs.writeFileSync(script, fake);
  const bin = path.join(cwd, process.platform === "win32" ? "grok.cmd" : "grok");
  fs.writeFileSync(bin, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const logFile = path.join(cwd, "agent.jsonl");
  const data = path.join(cwd, "data");
  fixtureActive = true;
  const previousData = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.PLUGIN_DATA = data;
  const env = { ...process.env, GROK_BIN: bin, CANCEL_TEST_LOG: logFile, CANCEL_REVIEW_GATE: path.join(cwd, "review-release"), ...extraEnv,
    CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, TMPDIR: cwd, TMP: cwd, TEMP: cwd, CANCEL_FIXTURE_RELEASE: path.join(cwd, "fixture-release") };
  const address = process.platform === "win32" ? `pipe:\\\\.\\pipe\\cancel-repair-${randomUUID()}` : `unix:${path.join(cwd, "broker.sock")}`;
  let started;
  try { started = await startFixtureBroker(cwd, env, address); }
  catch (error) {
    previousData.claude === undefined ? delete process.env.CLAUDE_PLUGIN_DATA : process.env.CLAUDE_PLUGIN_DATA = previousData.claude;
    previousData.plugin === undefined ? delete process.env.PLUGIN_DATA : process.env.PLUGIN_DATA = previousData.plugin;
    fixtureActive = false;
    throw error;
  }
  const { child: proc, exited, session } = started;
  const generation = session.generation;
  env.GROK_COMPANION_BROKER_GENERATION = generation;
  const stderr = () => fs.existsSync(session.logFile) ? fs.readFileSync(session.logFile, "utf8") : "";
  const clients = [];
  const finalizers = [];
  t.after(async () => {
    let deadlineTimer;
    try {
      // 途中assertが失敗しても、ignoreCancelを含む全gateを先に解放する。
      fs.writeFileSync(env.CANCEL_FIXTURE_RELEASE, "release");
      await Promise.race([(async () => {
        await until(() => logs().filter((row) => row.gateReleased).length >= logs().filter((row) => row.gateArmed).length,
          "fixture agent gates released", 3000);
        for (const finalize of finalizers) await finalize();
        for (const client of clients) await client.close();
        if (proc.exitCode === null && proc.signalCode === null) {
          const control = await GrokAcpClient.connect(cwd, { env, brokerEndpoint: address, brokerOnly: true });
          try { await control.request("broker/shutdown", {}, { signal: AbortSignal.timeout(5000) }); }
          finally { await control.close(); }
        }
        await exited;
      })(), new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error(`Fixture teardown timed out. ${stderr()}`)), 10000);
      })]);
      assert.equal(proc.exitCode, 0, stderr());
    } finally {
      clearTimeout(deadlineTimer);
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          // 自分がspawnしたbrokerだけを停止する。fakeはstdinのEOFで終了する。
          await stopFixtureChild(proc);
        }
        if (proc.exitCode !== null || proc.signalCode !== null) removeTempFixture(cwd, { recursive: true, force: true });
      } finally {
        previousData.claude === undefined ? delete process.env.CLAUDE_PLUGIN_DATA : process.env.CLAUDE_PLUGIN_DATA = previousData.claude;
        previousData.plugin === undefined ? delete process.env.PLUGIN_DATA : process.env.PLUGIN_DATA = previousData.plugin;
        fixtureActive = false;
      }
    }
  });
  const connect = async () => {
    const client = await GrokAcpClient.connect(cwd, { env, brokerEndpoint: address, brokerOnly: true });
    clients.push(client);
    assert.equal(client.transport, "broker");
    assert.equal(client.initializeResult?._meta?.grokBrokerGeneration, generation);
    assert.equal(client.initializeResult?._meta?.grokExecutionLedger, true);
    return client;
  };
  const logs = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { cwd, env: { ...env, GROK_COMPANION_ACP_ENDPOINT: address },
    brokerIdentity: { transport: "broker", brokerGeneration: generation }, connect, logs, cleanup: (fn) => finalizers.push(fn) };
}
