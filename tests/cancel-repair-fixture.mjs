import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { removeTempFixture } from "./helpers.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";
import { ensureBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ファイルの合図だけで順番を固定し、実アカウントと時間依存の競合を使わない。
const fake = String.raw`
import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  if (process.env.CANCEL_FAIL_PROBE && process.argv.includes("--version")) {
    fs.appendFileSync(process.env.CANCEL_TEST_LOG, JSON.stringify({ probeFailed: true }) + "\n");
    process.exit(1);
  }
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
  if (m.method === "initialize") {
    const reply = () => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {
      loadSession: !process.env.CANCEL_NO_LOAD_SESSION, ...(process.env.CANCEL_LIST_SESSIONS ? { sessionCapabilities: { list: {} } } : {})
    } } });
    if (process.env.CANCEL_DELAY_INITIALIZE) {
      log({ delayedInitialize: true });
      return setTimeout(reply, Number(process.env.CANCEL_DELAY_INITIALIZE));
    }
    return reply();
  }
  if (m.method === "session/new") {
    log({ newSession: true });
    return send({ id: m.id, result: {
      sessionId: process.env.CANCEL_SESSION_PREFIX ? process.env.CANCEL_SESSION_PREFIX + (++sessionNumber) :
        process.env.CANCEL_NUMBERED_SESSIONS ? "session-" + (++sessionNumber) : "session-1"
    } });
  }
  if (m.method === "session/load") {
    log({ loadedSession: m.params.sessionId, loadParams: m.params });
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
export async function fixture(t, extraEnv = {}, onRoot = () => {}, { broker = null, inspectProcesses = spawnSync, onStartupChild = () => {} } = {}) {
  if (fixtureActive) throw new Error("Cancel fixtures cannot share the process environment concurrently");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-repair-e2e-"));
  onRoot(cwd);
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
  let address = process.platform === "win32" ? `pipe:\\\\.\\pipe\\cancel-repair-${randomUUID()}` : `unix:${path.join(cwd, "broker.sock")}`;
  let started, startupChild, startupExited, startupMarker, startupStateDir;
  const logs = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  // 起動が失敗しても専用 sentinel の後始末を登録する。停止証拠が足りなければ保持する。
  t.after(async () => {
    if (started) return;
    try {
      if (process.platform !== "linux" || !startupChild || !startupExited || !startupMarker?.epoch || !startupStateDir ||
          !Number.isSafeInteger(startupChild.pid) || startupChild.pid <= 0)
        throw new Error("startup ownership or sentinel identity was not observed");
      let timer;
      const result = await Promise.race([startupExited, new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), 3000); })]);
      clearTimeout(timer);
      if (result !== "exit" || (startupChild.exitCode === null && startupChild.signalCode === null))
        throw new Error("owned broker exit was not observed");
      const agentPids = new Set(logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0));
      if (!agentPids.size) throw new Error("agent identity was not recorded");
      const ps = inspectProcesses("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 3000 });
      assert.ifError(ps.error);
      assert.equal(ps.status, 0, ps.stderr);
      assert.ok(!ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).some(([pid, pgid, stat]) =>
        stat && !stat.startsWith("Z") && (Number(pid) === startupChild.pid || agentPids.has(Number(pid)) || Number(pgid) === startupChild.pid)),
      "fixture broker, agent or process group is still running");
      const marker = JSON.parse(fs.readFileSync(path.join(startupStateDir, "state.lock", "protocol.json"), "utf8"));
      assert.equal(marker.epoch, startupMarker.epoch);
      assert.deepEqual(marker.sentinel, startupMarker.sentinel);
      const stopped = shutdownPosixStateLockSentinel(startupStateDir, { offlineConfirmed: true, expectedStateDir: startupStateDir });
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.epoch, startupMarker.epoch);
      removeTempFixture(cwd, { recursive: true, force: true });
    } catch (error) {
      t.diagnostic(`Fixture retained because startup cleanup was not confirmed: ${cwd}; ${error.message}`);
    }
  });
  try {
    const modules = {
      state: { resolveStateDir, migrateStateLock: (...args) => {
        startupStateDir = resolveStateDir(cwd);
        startupMarker = migrateStateLock(...args);
        return startupMarker;
      } },
      onChild(child) {
        startupChild = child;
        startupExited = new Promise(resolve => {
          child.once("exit", () => resolve("exit"));
          child.once("error", () => resolve("error"));
          child.once("close", () => resolve("close"));
        });
        onStartupChild(child);
      },
      ...(broker ? { broker } : extraEnv.CANCEL_MANAGED_ENDPOINT ? { broker: { ensureBrokerSession: (workspace, options) =>
        ensureBrokerSession(workspace, { ...options, createBrokerEndpoint: undefined }) } } : {})
    };
    started = await startFixtureBroker(cwd, env, address, modules);
    if (extraEnv.CANCEL_MANAGED_ENDPOINT) address = started.session.endpoint;
  }
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
    let deadlineTimer, cleaned = false;
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
      if (process.platform === "linux" || process.platform === "darwin") {
        const agentPids = new Set(logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0));
        assert.ok(agentPids.size > 0, "fixture agent identity was not recorded");
        await until(() => {
          const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
          assert.equal(ps.status, 0, ps.stderr);
          return !ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).some(([pid, pgid, stat]) =>
            stat && !stat.startsWith("Z") && (Number(pid) === proc.pid || agentPids.has(Number(pid)) || Number(pgid) === proc.pid));
        }, "fixture broker, agent and process group exit", 3000);
        if (process.platform === "linux") {
          const stateDir = resolveStateDir(cwd);
          assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
        }
      }
      removeTempFixture(cwd, { recursive: true, force: true });
      cleaned = true;
    } finally {
      clearTimeout(deadlineTimer);
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          // 自分がspawnしたbrokerだけを停止する。fakeはstdinのEOFで終了する。
          await stopFixtureChild(proc);
        }
        if (!cleaned) t.diagnostic(`Fixture retained because owned cleanup was not confirmed: ${cwd}`);
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
  return { cwd, env: { ...env, GROK_COMPANION_ACP_ENDPOINT: address },
    brokerIdentity: { transport: "broker", brokerGeneration: generation }, brokerSession: session, brokerChild: proc, brokerExited: exited, connect, logs,
    async stopBroker() {
      const client = await connect();
      try { await client.request("broker/shutdown", {}, { signal: AbortSignal.timeout(5000) }); }
      finally { await client.close(); }
      let timer;
      try {
        await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture broker exit was not observed")), 5000); })]);
      } finally { clearTimeout(timer); }
      assert.equal(proc.exitCode, 0, stderr());
    },
    cleanup: (fn) => finalizers.push(fn) };
}
