import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { prepareFixtureState, startFixtureBroker } from "./broker-fixture-helper.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession, resolveBrokerStateDir, saveBrokerSession, sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";

const frame = (message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";

function prepareBrokerState(cwd, pluginData) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    // 新規の専用fixtureだけを移行し、親とbroker子の保存先を一致させる。
    migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(cwd) });
    return resolveBrokerStateDir(cwd);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function brokerOwnership(pid, generation) {
  return { ownerPlatform: process.platform,
    ...(process.platform === "win32" ? {} : { ownedGroup: { pgid: pid, generation, platform: process.platform } }) };
}

function writeConfirmedBrokerJournal(stateDir, session) {
  const generation = session.generation;
  const records = [
    { version: 2, event: "pending", generation, ownerPid: process.pid, platform: process.platform, lockToken: "fixture-owner",
      endpoint: session.endpoint, sessionDir: session.sessionDir, pidFile: session.pidFile, logFile: session.logFile },
    { version: 2, event: "spawned", generation, pid: session.pid, pgid: process.platform === "win32" ? null : session.pid },
    { version: 2, event: "settled", generation, pid: session.pid, outcome: "ready" },
    { version: 2, event: "confirmed", generation, pid: session.pid, outcome: "ready" }
  ];
  fs.writeFileSync(path.join(stateDir, "broker-admission.jsonl"), records.map(value => JSON.stringify({ ...value,
    ...(process.platform === "linux" ? { epoch: path.basename(stateDir) } : {}) }) + "\n").join(""));
}

function ownedIdleBrokerProcess() {
  // テスト親PIDをbroker所有者と偽らず、実際に独立したsession/groupを生成する。
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();"], {
    detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"]
  });
  child.fixtureClosed = new Promise((resolve) => child.once("close", resolve));
  return child;
}

async function waitForExit(promise) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); }
  finally { clearTimeout(timer); }
}

// fixture 専有プロセスと同じ epoch の sentinel の停止が確認できなければ保持する。
function fixtureCleanup(t, roots) {
  const states = [], owners = [], before = [], pids = new Set(), groups = new Set();
  t.after(async () => {
    try {
      for (const fn of before) await fn();
      for (const child of owners) {
        if (child.exitCode === null && child.signalCode === null) child.stdin?.end();
      }
      for (const child of owners) {
        const stopped = await waitForExit(child.fixtureClosed);
        assert.equal(stopped, true, `owner did not exit: ${child.pid}`);
      }
      if (process.platform === "linux") {
        const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
        assert.equal(ps.status, 0, ps.stderr);
        const live = ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 3 && !parts[2].startsWith("Z"));
        assert.ok(!live.some(([pid, pgid]) => pids.has(Number(pid)) || groups.has(Number(pgid))), "owner, agent, or process group is still running");
        for (const { stateDir, epoch } of states) {
          const marker = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
          assert.equal(marker.epoch, epoch, "fixture sentinel epoch changed");
          const result = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
          assert.equal(result.stopped, true);
          assert.equal(result.epoch, epoch);
        }
      }
      for (const dir of roots) removeTempFixture(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      throw new Error(`Fixture retained because offline cleanup could not be confirmed: ${roots.join(", ")}; ${error.message}`, { cause: error });
    }
  });
  return { roots, owners, before, pids, groups, state(brokerDir) {
    if (process.platform !== "linux") return;
    const stateDir = path.dirname(path.dirname(brokerDir));
    states.push({ stateDir, epoch: path.basename(brokerDir) });
  }, owner(child) { owners.push(child); pids.add(child.pid); if (process.platform !== "win32") groups.add(child.pid); } };
}

async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function broker(t, scenario) {
  const root = makeTempDir("grok-broker-e2e-");
  const cleanup = fixtureCleanup(t, [root]);
  prepareFixtureState(t, root, root);
  cleanup.state(resolveBrokerStateDir(root));
  const fake = installFakeGrok(scenario);
  const fallback = installFakeGrok({ replies: [{ text: "WRONG_BINARY" }] });
  cleanup.roots.push(fake.binDir, fallback.binDir);
  // broker の既存起動経路も含め、実物の Grok を PATH から選ばせない。
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: root, PATH: `${fallback.binDir}${path.delimiter}${fake.env.PATH ?? ""}` };
  const endpoint = createBrokerEndpoint(root);
  const sockets = [];
  let child, exited, session;
  cleanup.before.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (fake.readState()?.pid) cleanup.pids.add(fake.readState().pid);
    if (fallback.readState()?.pid) cleanup.pids.add(fallback.readState().pid);
    if (child && child.exitCode === null && child.signalCode === null) {
      await sendBrokerShutdown(endpoint, 2000);
      await waitForExit(exited);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  });
  ({ session } = await startFixtureBroker(root, env, endpoint, { onChild(value) {
    child = value;
    exited = new Promise(resolve => child.once("exit", resolve));
    child.fixtureClosed = new Promise(resolve => child.once("close", resolve));
    cleanup.owner(child);
  } }));
  const stderr = () => fs.existsSync(session.logFile) ? fs.readFileSync(session.logFile, "utf8") : "";
  assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true, stderr());
  assert.ok(fake.readState()?.pid, "the isolated fake Grok must have initialized");
  assert.equal(fallback.readState(), null, "GROK_BIN must take precedence over the other fake on PATH");

  async function client() {
    const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    sockets.push(socket);
    socket.setEncoding("utf8");
    const messages = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        messages.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return { socket, messages,
      response: (id) => until(() => messages.find((message) => message.id === id && !message.method), `Missing response ${id}: ${stderr()}`) };
  }
  return { fake, client, exited, root, endpoint, env, session, generation: session.generation };
}

async function cleanupBrokerFixture(t, { receipt = false } = {}) {
  const root = makeTempDir("broker-safe-cleanup-");
  const sessionDir = makeTempDir("gkc-");
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise((resolve) => exited.once("close", resolve));
  const record = { generation: "cleanup-generation", endpoint: createBrokerEndpoint(sessionDir), pid: exited.pid,
    sessionDir, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"),
    ...brokerOwnership(exited.pid, "cleanup-generation") };
  if (receipt) record.shutdownAcceptedGeneration = record.generation;
  // ここはcleanup/fault injectionの境界fixture。実Job停止は専用Windows E2Eで検証する。
  if (receipt && process.platform === "win32") record.shutdownAgentTerminatedGeneration = record.generation;
  const cleanup = fixtureCleanup(t, [root, sessionDir]);
  const stateDir = prepareBrokerState(root, root);
  cleanup.state(stateDir);
  cleanup.pids.add(exited.pid);
  if (process.platform !== "win32") cleanup.groups.add(exited.pid);
  if (process.platform === "linux") record.epoch = path.basename(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "broker.json");
  fs.writeFileSync(stateFile, JSON.stringify(record));
  writeConfirmedBrokerJournal(stateDir, record);
  fs.writeFileSync(record.pidFile, String(record.pid));
  fs.writeFileSync(record.logFile, "cleanup diagnostic\n");
  const sockets = new Set();
  let requests = 0;
  let onRequest = () => {};
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.trim());
      if (request.method === "initialize") {
        socket.write(frame({ id: request.id, result: { _meta: { grokBrokerGeneration: record.generation } } }));
        return;
      }
      requests += 1;
      onRequest();
      socket.write(frame({ id: request.id, result: { closing: true, generation: record.generation } }));
    });
  });
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(record.endpoint).path, resolve));
  cleanup.before.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  async function hook(preloadSource = "") {
    const preload = path.join(root, "faults.cjs");
    // Windowsではこの終了済みagent fixtureの終端proofを、matching ACKの配送前に保存する。
    // ACK自体を製品のJob証拠へ昇格させず、fixtureが既知の停止済み状態を別receiptで表す。
    const terminalReceiptSource = process.platform === "win32" && !receipt ? `
      (function(){const fs=require('node:fs'),net=require('node:net'),original=net.createConnection;
      net.createConnection=function(...args){const socket=original.apply(this,args);
        socket.prependListener('data',function(chunk){for(const line of String(chunk).split('\\n')){if(!line)continue;
          try{const reply=JSON.parse(line);if(reply.id!==2||reply.error||reply.result?.closing!==true||reply.result.generation!==${JSON.stringify(record.generation)})continue;
            const file=${JSON.stringify(stateFile)},current=JSON.parse(fs.readFileSync(file,'utf8'));
            if(current.generation===${JSON.stringify(record.generation)})fs.writeFileSync(file,JSON.stringify({...current,shutdownAgentTerminatedGeneration:current.generation}));
          }catch{} }
        });return socket;};})();` : "";
    const source = preloadSource + terminalReceiptSource;
    if (source) fs.writeFileSync(preload, source);
    const child = spawn(process.execPath, [fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url)), "SessionEnd"], {
      cwd: root, env: { ...process.env, CLAUDE_PLUGIN_DATA: root,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${source ? ` --require=${preload}` : ""}` },
      windowsHide: true, stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ cwd: root, session_id: "A" }));
    assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0, stderr);
  }
  return { root, record, stateFile, hook, cleanup, requests: () => requests, onRequest: (callback) => { onRequest = callback; } };
}

test("BD-2 idle shutdown preserves connected clients between requests", async (t) => {
  const b = await broker(t, {});
  const owner = await b.client();
  owner.socket.write(frame({ id: 1, method: "initialize", params: {} }));
  await owner.response(1);
  const control = await b.client();
  control.socket.write(frame({ id: 2, method: "broker/shutdownIfIdle", params: { generation: b.generation } }));
  assert.equal((await control.response(2)).error?.code, BROKER_BUSY_RPC_CODE);
  owner.socket.write(frame({ id: 3, method: "session/new", params: {} }));
  assert.ok((await owner.response(3)).result.sessionId);
});

test("BD-2 versioned broker state survives legacy SessionEnd and auth replacement", async (t) => {
  const b = await broker(t, {});
  const owner = await b.client();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = b.root;
  try {
    const legacyDir = resolveStateDir(b.root);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "broker.json");
    const legacyLock = path.join(legacyDir, "broker.lock");
    const legacy = { endpoint: "legacy-fake-only", pid: 111111, authMode: "browser" };
    const current = process.platform === "linux" ? b.session : { endpoint: b.endpoint, pid: 222222, generation: "test-generation", authMode: "browser" };
    const currentFile = path.join(resolveBrokerStateDir(b.root), "broker.json");
    if (process.platform === "linux") saveBrokerSession(b.root, current);
    const legacySource = `
      const fs = require('node:fs');
      const file = process.argv[1];
      const mode = process.argv[2];
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 旧版の無条件 kill/teardown/clear を外部作用なしで記録する。
      const teardown = mode === 'SessionEnd' || state.authMode !== 'api-key';
      if (teardown) fs.writeFileSync(file, JSON.stringify({ clearedByLegacy: mode }));
      process.stdout.write(JSON.stringify({ killedPid: teardown ? state.pid : null }));
    `;
    for (const mode of ["SessionEnd", "auth-mismatch"]) {
      if (process.platform !== "linux") saveBrokerSession(b.root, current);
      fs.writeFileSync(legacyFile, JSON.stringify(legacy));
      fs.writeFileSync(legacyLock, "old-owner-lock\n");
      const child = spawn(process.execPath, ["-e", legacySource, legacyFile, mode], {
        cwd: b.root, env: b.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0);
      assert.equal(JSON.parse(output).killedPid, legacy.pid);
      assert.equal(fs.readFileSync(legacyLock, "utf8"), "old-owner-lock\n");
      assert.deepEqual(JSON.parse(fs.readFileSync(currentFile, "utf8")), current);
      if (process.platform === "linux") {
        assert.throws(() => loadBrokerSession(b.root), /offline recovery|inventory/i);
        owner.socket.write(frame({ id: mode, method: "session/new", params: {} }));
        assert.match((await owner.response(mode)).error?.message ?? "", /epoch is no longer valid/i);
      } else {
        assert.deepEqual(loadBrokerSession(b.root), current);
        owner.socket.write(frame({ id: mode, method: "session/new", params: {} }));
        assert.ok((await owner.response(mode)).result.sessionId);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("BD-2 idle shutdown atomically accepts only the matching generation", async (t) => {
  const b = await broker(t, {});
  const control = await b.client();
  control.socket.write(frame({ id: 1, method: "broker/shutdownIfIdle", params: { generation: "old-generation" } }));
  assert.ok((await control.response(1)).error);
  control.socket.write(frame({ id: 2, method: "broker/shutdownIfIdle", params: { generation: b.generation } }));
  const accepted = await control.response(2);
  assert.deepEqual(accepted.result, { closing: true, generation: b.generation }, JSON.stringify(accepted));
  await b.exited;
  const direct = await GrokAcpClient.connect(b.root, { env: { ...b.env, [BROKER_ENDPOINT_ENV]: b.endpoint }, grokBin: b.env.GROK_BIN });
  try {
    const session = await direct.request("session/new", { cwd: b.root, mcpServers: [] });
    assert.ok(session.sessionId, "closing broker must fall back to the isolated direct Grok");
  } finally { await direct.close(); }
});

test("BD-3 existing incompatible or unreachable brokers survive direct fallback", async (t) => {
  const root = makeTempDir("broker-safe-mode-");
  const cleanup = fixtureCleanup(t, [root]);
  const noStart = path.join(root, "no-start.mjs");
  fs.writeFileSync(noStart, "process.exit(0);\n");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  try {
    for (const authMode of ["browser", "api-key"]) {
      const cwd = path.join(root, authMode);
      fs.mkdirSync(cwd);
      migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(cwd) });
      const stateDir = resolveBrokerStateDir(cwd);
      cleanup.state(stateDir);
      fs.mkdirSync(stateDir, { recursive: true });
      const child = ownedIdleBrokerProcess();
      cleanup.owner(child);
      const generation = "retained-generation";
      const original = { endpoint: createBrokerEndpoint(cwd), authMode, generation, pid: child.pid,
        sessionDir: cwd, pidFile: path.join(cwd, "broker.pid"), logFile: path.join(cwd, "broker.log"),
        ...brokerOwnership(child.pid, generation), ...(process.platform === "linux" ? { epoch: path.basename(stateDir) } : {}) };
      fs.writeFileSync(path.join(stateDir, "broker.json"), JSON.stringify(original));
      writeConfirmedBrokerJournal(stateDir, original);
      const operation = ensureBrokerSession(cwd, { env: { ...process.env, XAI_API_KEY: "fake-isolated-key", GROK_BIN: path.join(root, "nonexistent-grok") }, scriptPath: noStart, timeoutMs: 2000, killProcess: () => assert.fail("must not kill an existing broker") });
      if (authMode === "browser") assert.equal(await operation, null);
      else await assert.rejects(operation, /broker generation could not be confirmed|admission/i);
      assert.deepEqual(loadBrokerSession(cwd), original);
      assert.equal(child.exitCode, null, "existing broker owner must remain alive");
      assert.equal(child.signalCode, null, "existing broker owner must not be signalled");
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("BD-2 SessionEnd preserves an unknown broker and a replacement generation", async (t) => {
  const root = makeTempDir("broker-safe-hook-");
  const sessionDir = makeTempDir("gkc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const cleanup = fixtureCleanup(t, [root, sessionDir]);
  const stateDir = prepareBrokerState(root, root);
  cleanup.state(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "broker.json");
  const owned = ownedIdleBrokerProcess();
  cleanup.owner(owned);
  const original = { endpoint, generation: "old-generation", authMode: "browser", pid: owned.pid,
    sessionDir, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"),
    ...brokerOwnership(owned.pid, "old-generation"), ...(process.platform === "linux" ? { epoch: path.basename(stateDir) } : {}) };
  fs.writeFileSync(original.pidFile, String(original.pid));
  fs.writeFileSync(original.logFile, "retained diagnostic\n");
  writeConfirmedBrokerJournal(stateDir, original);
  const replacementOwner = ownedIdleBrokerProcess();
  cleanup.owner(replacementOwner);
  const replacementDir = path.join(root, "new");
  fs.mkdirSync(replacementDir);
  const replacement = { endpoint: createBrokerEndpoint(replacementDir), generation: "new-generation", authMode: "browser", pid: replacementOwner.pid,
    sessionDir: replacementDir, pidFile: path.join(replacementDir, "broker.pid"), logFile: path.join(replacementDir, "broker.log"),
    ...brokerOwnership(replacementOwner.pid, "new-generation"), ...(process.platform === "linux" ? { epoch: path.basename(stateDir) } : {}) };
  fs.writeFileSync(replacement.pidFile, String(replacement.pid));
  fs.writeFileSync(replacement.logFile, "replacement diagnostic\n");
  const methods = [];
  const sockets = new Set();
  let behavior = "unknown";
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.trim());
      methods.push(request.method);
      if (request.method === "initialize") {
        socket.write(frame({ id: request.id, result: { _meta: { grokBrokerGeneration: original.generation } } }));
        return;
      }
      if (behavior === "timeout") return;
      if (behavior === "replace") {
        writeConfirmedBrokerJournal(stateDir, replacement);
        fs.writeFileSync(stateFile, JSON.stringify(replacement));
      }
      socket.write(frame({ id: request.id, ...(behavior === "replace" || behavior === "idle" ? { result: { closing: true, generation: "old-generation" } } : behavior === "mismatch" ? { result: { closing: true, generation: "wrong-generation" } } : { error: { code: behavior === "busy" ? BROKER_BUSY_RPC_CODE : -32601, message: "retained broker" } }) }));
    });
  });
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  cleanup.before.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  for (behavior of ["unknown", "busy", "timeout", "mismatch", "replace", "idle"]) {
    writeConfirmedBrokerJournal(stateDir, original);
    fs.writeFileSync(stateFile, JSON.stringify(original));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url)), "SessionEnd"], {
      cwd: root, env: { ...process.env, CLAUDE_PLUGIN_DATA: root }, windowsHide: true, stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ cwd: root, session_id: "A" }));
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0, `${behavior}: ${stderr}`);
    assert.equal(methods.at(-1), "broker/shutdownIfIdle");
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), behavior === "replace" ? replacement : behavior === "idle" ? { ...original, shutdownAcceptedGeneration: original.generation } : original);
    assert.equal(owned.exitCode, null, "original owner must remain alive");
    assert.equal(replacementOwner.exitCode, null, "replacement owner must remain alive");
    assert.equal(replacementOwner.signalCode, null, "replacement owner must not be signalled");
  }
  const manualCwd = path.join(root, "manual-endpoint");
  fs.mkdirSync(manualCwd);
  cleanup.state(prepareBrokerState(manualCwd, root));
  const count = methods.length;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url)), "SessionEnd"], {
    cwd: manualCwd, env: { ...process.env, CLAUDE_PLUGIN_DATA: root, [BROKER_ENDPOINT_ENV]: endpoint }, windowsHide: true, stdio: ["pipe", "ignore", "pipe"]
  });
  let manualStderr = "";
  child.stderr.on("data", chunk => { manualStderr += chunk; });
  child.stdin.end(JSON.stringify({ cwd: manualCwd, session_id: "manual" }));
  assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0, manualStderr);
  assert.equal(methods.length, count, "an unowned manual endpoint must not receive shutdown");
});

test("BD-2 SessionEnd cannot stop B's connected broker after an empty A snapshot", async (t) => {
  const b = await broker(t, {});
  const owner = await b.client();
  owner.socket.write(frame({ id: 1, method: "initialize", params: {} }));
  await owner.response(1);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = b.root;
  const stateDir = resolveBrokerStateDir(b.root);
  if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previous;
  fs.mkdirSync(stateDir, { recursive: true });
  const original = b.session;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "broker.json"), "utf8")), original);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url)), "SessionEnd"], {
    cwd: b.root, env: { ...b.env, CLAUDE_PLUGIN_DATA: b.root }, windowsHide: true, stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify({ cwd: b.root, session_id: "A" }));
  assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "broker.json"), "utf8")), original);
  owner.socket.write(frame({ id: 2, method: "session/new", params: {} }));
  assert.ok((await owner.response(2)).result.sessionId);
});

test("BD-3 an old broker lock cannot be stolen from an unverified owner", async (t) => {
  const root = makeTempDir("broker-safe-lock-");
  let unexpectedClose;
  const cleanup = fixtureCleanup(t, [root]);
  cleanup.before.push(async () => {
    if (unexpectedClose) assert.equal(await waitForExit(unexpectedClose), true, "unexpected broker did not close");
  });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  try {
    // 非 repository の capability probe を競合期限に含めず、実 Git で workspace root を証明する。
    const init = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8", timeout: 10000 });
    assert.equal(init.status, 0, init.stderr || init.error?.message);
    const proof = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10000 });
    assert.equal(proof.status, 0, proof.stderr || proof.error?.message);
    assert.equal(fs.realpathSync.native(proof.stdout.trim()), fs.realpathSync.native(root));
    migrateStateLock(root, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(root) });
    const stateDir = resolveBrokerStateDir(root);
    cleanup.state(stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, "broker.lock");
    const token = `${process.pid}:retained-owner\n`;
    fs.writeFileSync(lockFile, token);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lockFile, past, past);
    let spawned = false;
    let failure;
    const isolatedEnv = { ...process.env, GROK_BIN: path.join(root, "nonexistent-grok") };
    delete isolatedEnv.XAI_API_KEY;
    // rival の最初の 50ms 待機だけ仮想時間を進め、最終検査の予算を確保する。
    const realNow = performance.now.bind(performance), nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    const originalSetTimeout = globalThis.setTimeout;
    let offset = 0, advanced = false;
    Object.defineProperty(performance, "now", { configurable: true, value: () => realNow() + offset });
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (!advanced && delay > 0 && delay <= 50) {
        advanced = true;
        return originalSetTimeout(() => { offset += 1250; callback(...args); }, 0);
      }
      return originalSetTimeout(callback, delay, ...args);
    };
    try {
      await ensureBrokerSession(root, { env: isolatedEnv, timeoutMs: 6000, onBrokerSpawn(child) {
        spawned = true;
        child.ref();
        unexpectedClose = new Promise(resolve => child.once("close", () => resolve(true)));
        cleanup.pids.add(child.pid);
        if (process.platform !== "win32") cleanup.groups.add(child.pid);
        child.kill("SIGTERM");
      } });
    } catch (error) {
      failure = error;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      else delete performance.now;
    }
    assert.equal(advanced, true, "rival wait was not exercised");
    assert.equal(fs.readFileSync(lockFile, "utf8"), token);
    assert.equal(spawned, false, "an unverified lock owner must not trigger a new broker");
    assert.equal(fs.existsSync(path.join(stateDir, "broker.json")), false);
    assert.match(String(failure?.message ?? ""), /Broker admission journal is missing while a startup lock exists/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("BD-2 a freshly started idle broker closes naturally through SessionEnd", async (t) => {
  const root = makeTempDir("broker-safe-start-");
  const fake = installFakeGrok({});
  const cleanup = fixtureCleanup(t, [root, fake.binDir]);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  let session, brokerChild;
  let stateDir;
  cleanup.before.push(async () => {
    if (fake.readState()?.pid) cleanup.pids.add(fake.readState().pid);
    if (brokerChild && brokerChild.exitCode === null && brokerChild.signalCode === null && session) await sendBrokerShutdown(session.endpoint, 2000);
    if (brokerChild && brokerChild.exitCode === null && brokerChild.signalCode === null) {
      await waitForExit(brokerChild.fixtureClosed);
      if (brokerChild.exitCode === null && brokerChild.signalCode === null) brokerChild.kill("SIGTERM");
    }
  });
  try {
    migrateStateLock(root, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(root) });
    stateDir = resolveBrokerStateDir(root);
    cleanup.state(stateDir);
    session = await ensureBrokerSession(root, { env: { ...fake.env, CLAUDE_PLUGIN_DATA: root }, timeoutMs: 3000, onBrokerSpawn(child) {
      brokerChild = child;
      child.ref();
      child.fixtureClosed = new Promise(resolve => child.once("close", resolve));
      cleanup.owner(child);
    } });
    if (session) cleanup.roots.push(session.sessionDir);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  assert.ok(session?.generation);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url)), "SessionEnd"], {
    cwd: root, env: { ...fake.env, CLAUDE_PLUGIN_DATA: root }, windowsHide: true, stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify({ cwd: root, session_id: "A" }));
  assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0);
  await until(() => !fs.existsSync(path.join(stateDir, "broker.json")), "idle broker state must be cleared after its exit is confirmed");
  assert.equal(fs.existsSync(path.join(stateDir, "broker.json")), false);
  assert.equal(await waitForBrokerEndpoint(session.endpoint, 100), false);
  assert.equal(fs.existsSync(session.pidFile), process.platform !== "win32");
  assert.equal(fs.existsSync(session.logFile), process.platform !== "win32");
  assert.equal(fs.existsSync(session.sessionDir), process.platform !== "win32");
});

test("BD-2 SessionEnd manifest wrapper preserves a live broker within its host budget", async (t) => {
  const root = makeTempDir("broker-safe-live-cleanup-");
  const sessionDir = makeTempDir("gkc-");
  const cleanup = fixtureCleanup(t, [root, sessionDir]);
  const stateDir = prepareBrokerState(root, root);
  cleanup.state(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const owned = ownedIdleBrokerProcess();
  cleanup.owner(owned);
  const record = { generation: "live-generation", endpoint: createBrokerEndpoint(sessionDir), pid: owned.pid,
    sessionDir, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"),
    ...brokerOwnership(owned.pid, "live-generation"), ...(process.platform === "linux" ? { epoch: path.basename(stateDir) } : {}) };
  fs.writeFileSync(record.pidFile, String(record.pid));
  fs.writeFileSync(record.logFile, "retained diagnostic\n");
  fs.writeFileSync(path.join(stateDir, "broker.json"), JSON.stringify(record));
  writeConfirmedBrokerJournal(stateDir, record);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.trim());
      if (request.method === "initialize") {
        socket.write(frame({ id: request.id, result: { _meta: { grokBrokerGeneration: record.generation } } }));
        return;
      }
      socket.write(frame({ id: request.id, result: { closing: true, generation: record.generation } }));
    });
  });
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(record.endpoint).path, resolve));
  cleanup.before.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const hook = JSON.parse(fs.readFileSync(new URL("../plugins/grok/hooks/hooks.json", import.meta.url), "utf8")).hooks.SessionEnd[0].hooks[0];
  const wrapper = hook.command.match(/^node -e "([\s\S]+)"$/);
  assert.ok(wrapper, "exercise the configured Node wrapper, including its child process startup");
  const started = performance.now();
  const child = spawn(process.execPath, ["-e", wrapper[1]], {
    cwd: root, env: { ...process.env, CLAUDE_PLUGIN_DATA: root, CLAUDE_PLUGIN_ROOT: fileURLToPath(new URL("../plugins/grok/", import.meta.url)) },
    windowsHide: true, stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify({ cwd: root, session_id: "A" }));
  assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0);
  assert.ok(performance.now() - started < hook.timeout * 1000, "both Node startups and cleanup must fit the configured host budget");
  const retained = JSON.parse(fs.readFileSync(path.join(stateDir, "broker.json"), "utf8"));
  assert.equal(retained.generation, record.generation);
  assert.equal(retained.shutdownAcceptedGeneration, record.generation);
  assert.equal(fs.readFileSync(record.logFile, "utf8"), "retained diagnostic\n");
  assert.equal(fs.existsSync(record.pidFile), true);
});

test("BD-2 cleanup retains unknown death, reparse and unlink failures and retries its receipt", async (t) => {
  const scenarios = (process.platform === "win32" ? ["death", "reparse", "unlink", "pid-unlink"] : ["death", "reparse"])
    .map((fault) => ({ fault, canonicalAlias: false }));
  if (process.platform === "win32") scenarios.push(...["reparse", "unlink", "pid-unlink"].map((fault) => ({ fault, canonicalAlias: true })));
  for (const { fault, canonicalAlias } of scenarios) {
    const fixture = await cleanupBrokerFixture(t, { receipt: true });
    const log = JSON.stringify(fixture.record.logFile);
    const probe = JSON.stringify(path.join(fixture.root, "fault-fired"));
    const source = fault === "death"
      ? `const original=process.kill; process.kill=(pid,signal)=>{ if(pid===${fixture.record.pid}) {require('node:fs').writeFileSync(${probe},'death');throw Object.assign(new Error('unavailable'),{code:'EPERM'});} return original(pid,signal); };`
      : fault === "reparse"
        ? `const fs=require('node:fs');const target=fs.realpathSync.native(${log}),original=fs.lstatSync;fs.lstatSync=function(file,...args){const stat=original.call(this,file,...args);if(String(file)===target){fs.writeFileSync(${probe},'reparse');stat.isSymbolicLink=()=>true;}return stat;};`
        : `const fs=require('node:fs');const target=fs.realpathSync.native(${fault === "pid-unlink" ? JSON.stringify(fixture.record.pidFile) : log}),original=fs.unlinkSync;fs.unlinkSync=function(file,...args){if(String(file)===target){fs.writeFileSync(${probe},'unlink');throw Object.assign(new Error('locked'),{code:'EBUSY'});}return original.call(this,file,...args);};`;
    // 実symlinkを作らず、同じWindowsファイルの別名をcanonical結果にする。
    const aliasSource = canonicalAlias ? `(function(){const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const dir=${JSON.stringify(fixture.record.sessionDir)},root=os.tmpdir(),original=fs.realpathSync.native;fs.realpathSync.native=function(file,...args){const result=original.call(this,file,...args);return String(file)===root||String(file)===dir||String(file).startsWith(dir+path.sep)?path.toNamespacedPath(result):result;};})();` : "";
    await fixture.hook(aliasSource + source);
    assert.equal(fs.existsSync(JSON.parse(probe)), true, "the injected fault must actually run");
    assert.equal(fs.existsSync(fixture.stateFile), true, fault);
    assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n", fault);
    assert.equal(fs.existsSync(fixture.record.pidFile), fault !== "unlink", fault);
    assert.equal(fixture.requests(), 0, "a persisted receipt must not need another ACK");
    await fixture.hook();
    assert.equal(fs.existsSync(fixture.stateFile), false, fault);
    assert.equal(fs.existsSync(fixture.record.sessionDir), process.platform !== "win32", fault);
    if (process.platform !== "win32") {
      assert.equal(fs.existsSync(fixture.record.pidFile), true, fault);
      assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n", fault);
    }
    assert.equal(fixture.requests(), 0, "a saved ACK must allow retry after the broker disappeared");
  }
});

test("BD-2 cleanup permits a canonical TEMP root with an OS alias ancestor", async (t) => {
  const fixture = await cleanupBrokerFixture(t);
  await fixture.hook(`
    const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const alias=path.dirname(os.tmpdir()),original=fs.lstatSync;
    fs.lstatSync=function(file,...args){const stat=original.call(this,file,...args);if(String(file)===alias)stat.isSymbolicLink=()=>true;return stat;};
  `);
  assert.equal(fs.existsSync(fixture.stateFile), false);
  assert.equal(fs.existsSync(fixture.record.sessionDir), process.platform !== "win32");
  if (process.platform !== "win32") {
    assert.equal(fs.existsSync(fixture.record.pidFile), true);
    assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n");
  }
});

test("BD-2 acknowledged cleanup rejects root retargeting and directory replacement after its initial snapshot", async (t) => {
  for (const fault of ["root", "directory", "directory-link"]) {
    const fixture = await cleanupBrokerFixture(t, { receipt: true });
    const flag = path.join(fixture.root, "identity-rechecked");
    const source = `
      const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
      const flag=${JSON.stringify(flag)},dir=${JSON.stringify(fixture.record.sessionDir)};
      const original=fs.lstatSync,realpath=fs.realpathSync.native;
      let directoryReads=0;
      fs.lstatSync=function(file,...args){const stat=original.call(this,file,...args);if(String(file)===dir){
        directoryReads+=1;
        ${fault === "directory" ? "stat.ino=typeof stat.ino==='bigint'?14355223812868620n:Number(14355223812868620n);" : ""}
        if(directoryReads>1){
        ${fault === "directory-link" ? "fs.writeFileSync(flag,'link');stat.isSymbolicLink=()=>true;" : fault === "directory" ? "fs.writeFileSync(flag,'inode');stat.ino+=typeof stat.ino==='bigint'?1n:1;" : ""}
      }}return stat;};
      fs.realpathSync.native=function(file,...args){const result=realpath.call(this,file,...args);if(${fault === "root"}&&String(file)===path.resolve(os.tmpdir())&&directoryReads>0){fs.writeFileSync(flag,'root');return path.join(result,'retargeted');}return result;};
    `;
    await fixture.hook(source);
    assert.equal(fs.existsSync(flag), true, "the post-snapshot identity fault must actually run");
    assert.equal(fs.existsSync(fixture.stateFile), true, fault);
    assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n", fault);
    await fixture.hook();
    assert.equal(fs.existsSync(fixture.stateFile), false, fault);
    assert.equal(fixture.requests(), 0, "identity checks must not depend on ACK timing");
  }
});

test("BD-2 ACK budget accepts a virtual 450ms reply within the total cleanup budget", async (t) => {
  for (const delay of [450, 1000]) {
  const fixture = await cleanupBrokerFixture(t);
  const result = path.join(fixture.root, "ack-budget.json");
  await fixture.hook(`
    const fs=require('node:fs'),net=require('node:net'),{EventEmitter}=require('node:events');
    const nativeSetTimeout=global.setTimeout,nativeClearTimeout=global.clearTimeout;
    let ackTimer;
    global.setTimeout=function(callback,delay,...args){
      if(!ackTimer&&delay>=100&&delay<=750){ackTimer={callback,delay};return ackTimer;}
      return nativeSetTimeout(callback,delay,...args);
    };
    global.clearTimeout=function(timer){if(timer===ackTimer)return;return nativeClearTimeout(timer);};
    net.createConnection=function(){
      const socket=new EventEmitter();socket.setEncoding=()=>socket;socket.destroy=()=>{socket.emit('close');};
      socket.write=function(line){const request=JSON.parse(line);queueMicrotask(()=>{
        if(request.method==='initialize'){
          socket.emit('data',JSON.stringify({jsonrpc:'2.0',id:request.id,result:{_meta:{grokBrokerGeneration:${JSON.stringify(fixture.record.generation)}}}})+'\\n');
          return;
        }
        const received=ackTimer.delay>=${delay};
        fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({budget:ackTimer.delay,received}));
        if(!received)ackTimer.callback();
        else socket.emit('data',JSON.stringify({jsonrpc:'2.0',id:request.id,result:{closing:true,generation:request.params.generation}})+'\\n');
      });};
      queueMicrotask(()=>socket.emit('connect'));return socket;
    };
  `);
  const received = JSON.parse(fs.readFileSync(result, "utf8")).received;
  assert.equal(received, delay === 450, "the bounded ACK budget must distinguish received and unknown replies");
  assert.equal(fs.existsSync(fixture.stateFile), !received);
  if (received && process.platform !== "win32") {
    assert.equal(fs.existsSync(fixture.record.pidFile), true);
    assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n");
  }
  if (!received) {
    assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).shutdownAcceptedGeneration, undefined);
    assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n");
    assert.equal(fs.existsSync(fixture.record.pidFile), true);
  }
  }
});

test("BD-2 old cleanup cannot clear a concurrently published new broker", async (t) => {
  const fixture = await cleanupBrokerFixture(t);
  const nextDir = makeTempDir("gkc-");
  fixture.cleanup.roots.push(nextDir);
  const nextOwner = ownedIdleBrokerProcess();
  fixture.cleanup.owner(nextOwner);
  const next = { ...fixture.record, generation: "next-generation", pid: nextOwner.pid, sessionDir: nextDir, endpoint: createBrokerEndpoint(nextDir),
    pidFile: path.join(nextDir, "broker.pid"), logFile: path.join(nextDir, "broker.log"), ...brokerOwnership(nextOwner.pid, "next-generation") };
  fs.writeFileSync(next.logFile, "new broker log\n");
  fixture.onRequest(() => fs.writeFileSync(fixture.stateFile, JSON.stringify(next)));
  await fixture.hook();
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")), next);
  assert.equal(fs.readFileSync(next.logFile, "utf8"), "new broker log\n");
  assert.equal(fs.existsSync(fixture.record.sessionDir), true, "a generation change must retain the old ownership diagnostics");
  assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n");
});

test("BD-2 Windows open log is retained until its external reader closes", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await cleanupBrokerFixture(t);
  const reader = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$heldFile = [System.IO.File]::Open($env:GROK_TEST_LOG, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $heldFile.Dispose() }"], {
    env: { ...process.env, GROK_TEST_LOG: fixture.record.logFile }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  const closed = new Promise((resolve) => reader.once("close", resolve));
  fixture.cleanup.before.push(async () => { if (reader.exitCode === null && reader.signalCode === null) reader.stdin.end("release\n"); await closed; });
  let output = "";
  reader.stdout.on("data", (chunk) => { output += chunk; });
  await until(() => output.includes("READY"), "the Windows reader must hold its test log");
  await fixture.hook();
  assert.equal(fs.existsSync(fixture.stateFile), true);
  assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).shutdownAcceptedGeneration, fixture.record.generation);
  assert.equal(fs.readFileSync(fixture.record.logFile, "utf8"), "cleanup diagnostic\n");
  reader.stdin.end("release\n");
  await closed;
  await fixture.hook();
  assert.equal(fs.existsSync(fixture.record.sessionDir), false);
  assert.equal(fs.existsSync(fixture.stateFile), false);
});

test("broker forwards coalesced prompt cancellation without releasing the active owner", async (t) => {
  const b = await broker(t, { holdPrompt: true });
  const owner = await b.client();
  const other = await b.client();
  owner.socket.write(
    frame({ id: 1, method: "session/prompt", params: { sessionId: "held", prompt: [{ type: "text", text: "hold" }] } }) +
    frame({ method: "session/cancel", params: { sessionId: "held" } }) +
    frame({ id: 2, method: "session/cancel", params: { sessionId: "held" } })
  );
  await until(() => b.fake.readState()?.cancels.length === 2, "coalesced cancellations were blocked behind prompt");
  assert.deepEqual((await owner.response(2)).result, {});
  owner.socket.write(frame({ id: 6, method: "session/new", params: {} }));
  assert.ok((await owner.response(6)).result.sessionId);
  assert.equal(owner.messages.some((message) => message.id === 1 && !message.method), false);
  other.socket.write(frame({ id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
  assert.equal((await other.response(3)).error.code, BROKER_BUSY_RPC_CODE);
  other.socket.write(frame({ id: 4, method: "session/cancel", params: { sessionId: "held" } }));
  assert.deepEqual((await other.response(4)).result, {});
  other.socket.write(frame({ id: 5, method: "session/new", params: {} }));
  assert.equal((await other.response(5)).error.code, BROKER_BUSY_RPC_CODE);
});

test("broker preserves fragmented frames and routes permission replies to the active owner", async (t) => {
  const b = await broker(t, { replies: [{
    text: "PERMISSION_OK",
    requestPermissionFor: { title: "Read source", kind: "read", rawInput: { path: "source.mjs" } }
  }] });
  const owner = await b.client();
  const other = await b.client();
  owner.socket.write(
    frame({ id: 10, method: "session/prompt", params: { sessionId: "permission", prompt: [{ type: "text", text: "read" }] } }) +
    frame({ id: 11, method: "initialize", params: {} })
  );
  const permission = await until(() => owner.messages.find((message) => message.method === "session/request_permission"), "owner did not receive permission request");
  assert.equal(other.messages.some((message) => message.method === "session/request_permission"), false);
  other.socket.write(frame({ id: 20, method: "session/new", params: {} }));
  assert.equal((await other.response(20)).error.code, BROKER_BUSY_RPC_CODE);
  // 別接続の偽応答は、本来の要求を消したり Grok へ転送したりしない。
  other.socket.write(frame({ id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } }));
  assert.equal((await other.response(permission.id)).error.code, -32600);
  const fragment = frame({ id: 12, method: "session/cancel", params: { sessionId: "permission" } });
  const split = fragment.length - 8;
  owner.socket.write(frame({ id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } }) + fragment.slice(0, split));
  assert.ok((await owner.response(11)).result.agentCapabilities);
  assert.equal((await owner.response(10)).result.stopReason, "end_turn");
  owner.socket.write(fragment.slice(split));
  assert.deepEqual((await owner.response(12)).result, {});
  assert.equal(owner.messages.some((message) => message.error?.code === -32700), false);
  other.socket.write(frame({ id: 21, method: "session/new", params: {} }));
  assert.ok((await other.response(21)).result.sessionId);
});
