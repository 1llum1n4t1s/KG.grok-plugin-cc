import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// state.mjs は import 時の TEMP を保持するため、製品 module 読込み前に専用環境を固定する。
let fixtureRoot, refusingGrok;
if (process.platform === "darwin") {
  const parent = fs.realpathSync.native(os.tmpdir());
  const repo = fs.realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
  const relative = path.relative(repo, parent);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`));
  fs.accessSync(parent, fs.constants.W_OK);
  fixtureRoot = fs.mkdtempSync(path.join(parent, "foreign-safe-"));
  const home = path.join(fixtureRoot, "home");
  fs.mkdirSync(home);
  const bin = path.join(fixtureRoot, "bin");
  fs.mkdirSync(bin);
  refusingGrok = path.join(bin, "grok");
  fs.writeFileSync(refusingGrok, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.env.FOREIGN_FAKE_LOG) fs.appendFileSync(process.env.FOREIGN_FAKE_LOG,'unexpected start\n');
process.stderr.write('fixture refusing unexpected Grok startup\n');
process.exitCode=71;
`, { mode: 0o755 });
  const keys = ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "PATH", "GROK_BIN", "XAI_API_KEY", "GROK_COMPANION_ACP_ENDPOINT", "NODE_OPTIONS"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TMPDIR: fixtureRoot, TMP: fixtureRoot, TEMP: fixtureRoot,
    PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter), GROK_BIN: refusingGrok, XAI_API_KEY: "" });
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  delete process.env.NODE_OPTIONS;
  after(t => {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    t.diagnostic(`Isolated test root retained: ${fixtureRoot}`);
  });
}
const { createBrokerEndpoint } = await import("../plugins/grok/scripts/lib/broker-endpoint.mjs");
const { GrokAcpClient } = await import("../plugins/grok/scripts/lib/acp.mjs");
const { cleanupIdleBrokerSession, ensureBrokerSession, loadBrokerSession, resolveBrokerStateDir, saveBrokerSession } = await import("../plugins/grok/scripts/lib/broker-lifecycle.mjs");
const { migrateStateLock, resolveStateDir } = await import("../plugins/grok/scripts/lib/state.mjs");

for (const mode of ["old-pid-absent", "pid-reuse-simulated"]) {
  test(`foreign socket cannot be adopted or unlinked (${mode})`, { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
    const root = fs.realpathSync.native(os.tmpdir());
    const repo = fs.realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
    const relative = path.relative(repo, root);
    assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`));
    fs.accessSync(root, fs.constants.W_OK);
    const workspace = fs.mkdtempSync(path.join(root, "foreign-work-"));
    const dir = fs.mkdtempSync(path.join(root, "gkc-"));
    const identities = new Map([workspace, dir].map(value => [value, fs.lstatSync(value)]));
    const data = path.join(workspace, "data"); fs.mkdirSync(data);
    const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const endpoint = createBrokerEndpoint(dir), socketPath = endpoint.slice("unix:".length);
    const children = [], sockets = new Set(); let server;
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null && child.connected) child.send("exit");
        await child.closed;
      }
      if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
      if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
      for (const target of [dir, workspace]) {
        if (!fs.existsSync(target)) continue;
        try {
          const current = fs.lstatSync(target), before = identities.get(target);
          assert.equal(path.dirname(target), root); assert.equal(fs.realpathSync.native(target), target);
          assert.ok(current.isDirectory() && !current.isSymbolicLink());
          assert.equal(current.dev, before.dev); assert.equal(current.ino, before.ino);
          fs.rmSync(target, { recursive: true });
        } catch (error) { t.diagnostic(`Fixture retained or cleanup failed: ${target}`); throw error; }
      }
    });
    const child = async (program, args = []) => {
      const value = spawn(process.execPath, ["-e", program, ...args], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      value.closed = new Promise(resolve => value.once("close", resolve)); children.push(value);
      await new Promise((resolve, reject) => { value.once("message", resolve); value.once("error", reject); value.once("close", () => reject(Error("fixture child exited before ready"))); });
      return value;
    };
    const owner = await child("process.send('ready');process.on('message',()=>process.exit(0));setTimeout(()=>process.exit(0),20000)");
    const old = await child("const s=require('net').createServer();s.listen(process.argv[1],()=>process.send('ready'));process.on('message',()=>s.close(()=>process.exit(0)));setTimeout(()=>s.close(()=>process.exit(0)),20000)", [socketPath]);
    old.send("exit"); await old.closed;
    owner.send("exit"); await owner.closed;
    let recordedPid = old.pid, reused;
    if (mode === "pid-reuse-simulated") {
      // OSによる実際の再利用は強制せず、別個体が同じ記録PIDを占める状態を模す。
      reused = await child("process.send('ready');process.on('message',()=>process.exit(0));setTimeout(()=>process.exit(0),20000)");
      recordedPid = reused.pid;
    }
    const generation = "old-generation", newGeneration = "new-generation", seen = [];
    let responseGeneration = newGeneration;
    server = net.createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        const end = buffer.indexOf("\n"); if (end < 0) return;
        const message = JSON.parse(buffer.slice(0, end));
        seen.push(message.method);
        if (message.method === "initialize") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokBrokerGeneration: responseGeneration } } })}\n`);
      });
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    const newSocketIdentity = fs.lstatSync(socketPath).ino;
    const pidFile = path.join(dir, "broker.pid"), logFile = path.join(dir, "broker.log");
    fs.writeFileSync(pidFile, `${recordedPid}\n`); fs.writeFileSync(logFile, "fixture\n");
    migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace) });
    const session = { endpoint, pidFile, logFile, sessionDir: dir, pid: recordedPid, authMode: "browser", generation,
      ownerPlatform: "darwin", shutdownAcceptedGeneration: generation,
      ownedGroup: { pgid: recordedPid, generation, platform: "darwin" } };
    saveBrokerSession(workspace, session);
    const journal = path.join(resolveBrokerStateDir(workspace), "broker-admission.jsonl");
    const events = [
      { version: 2, event: "pending", generation, ownerPid: owner.pid, platform: "darwin", lockToken: "fixture", endpoint, sessionDir: dir, pidFile, logFile },
      { version: 2, event: "spawned", generation, pid: recordedPid, pgid: recordedPid },
      { version: 2, event: "settled", generation, pid: recordedPid, outcome: "ready" },
      { version: 2, event: "confirmed", generation, pid: recordedPid, outcome: "ready" }
    ];
    fs.writeFileSync(journal, events.map(value => JSON.stringify(value) + "\n").join(""));
    const liveGeneration = await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`));
      socket.once("data", data => { const response = JSON.parse(data.toString().trim()); socket.destroy(); resolve(response.result._meta.grokBrokerGeneration); });
    });
    assert.equal(liveGeneration, newGeneration);
    let adopted;
    try { adopted = await ensureBrokerSession(workspace, { env: { ...process.env, GROK_BIN: refusingGrok, XAI_API_KEY: "" }, timeoutMs: 4000 }); }
    catch (error) { assert.match(error.message, /generation|identity|admission|unconfirmed|verified/i); }
    const withoutReceipt = { ...session }; delete withoutReceipt.shutdownAcceptedGeneration;
    saveBrokerSession(workspace, withoutReceipt);
    const prior = seen.length;
    assert.equal(await cleanupIdleBrokerSession(workspace, withoutReceipt, { timeoutMs: 1800 }), false);
    assert.deepEqual(seen.slice(prior), ["initialize"], "foreign generation must not receive a shutdown request");
    saveBrokerSession(workspace, session);
    if (reused) {
      assert.equal(await cleanupIdleBrokerSession(workspace, session, { timeoutMs: 250 }), false);
      assert.equal(fs.lstatSync(socketPath).ino, newSocketIdentity);
      reused.send("exit"); await reused.closed;
    }
    const originalJournal = fs.readFileSync(journal, "utf8");
    fs.appendFileSync(journal, JSON.stringify({ ...events[0], generation: "pending-generation" }) + "\n");
    responseGeneration = generation;
    saveBrokerSession(workspace, withoutReceipt);
    const pendingRequests = seen.length;
    assert.equal(await cleanupIdleBrokerSession(workspace, withoutReceipt, { timeoutMs: 1800 }), false);
    assert.deepEqual(seen.slice(pendingRequests), ["initialize"], "pending admission must block even a matching shutdown request");
    saveBrokerSession(workspace, session);
    assert.equal(await cleanupIdleBrokerSession(workspace, session, { timeoutMs: 1800 }), false, "pending admission must block retirement");
    assert.equal(loadBrokerSession(workspace).generation, generation);
    assert.equal(fs.lstatSync(socketPath).ino, newSocketIdentity);
    fs.writeFileSync(journal, originalJournal);
    const cleaned = await cleanupIdleBrokerSession(workspace, session, { timeoutMs: 1800 });
    const retained = fs.existsSync(socketPath) && fs.lstatSync(socketPath).ino === newSocketIdentity;
    const filesRetained = fs.existsSync(pidFile) && fs.existsSync(logFile);
    const stateAfter = loadBrokerSession(workspace);
    t.diagnostic(`live generation=${liveGeneration}; adopted=${adopted?.generation}; cleanup=${cleaned}; new socket retained=${retained}`);
    assert.notEqual(adopted?.generation, generation, "a different live generation must not be adopted");
    assert.equal(cleaned, true, "a proven stopped generation may be retired without deleting its artifacts");
    assert.equal(stateAfter, null);
    assert.equal(retained, true);
    assert.equal(filesRetained, true);
  });
}

test("Mac child exit and graceful SIGTERM differ after socket path replacement", { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const root = fs.realpathSync.native(os.tmpdir());
  const repo = fs.realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
  const relative = path.relative(repo, root);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`));
  const dir = fs.mkdtempSync(path.join(root, "socket-exit-")), created = fs.lstatSync(dir);
  const children = [], servers = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null && child.connected) child.send("exit");
      await child.closed;
    }
    try {
      const current = fs.lstatSync(dir);
      assert.equal(path.dirname(dir), root); assert.equal(fs.realpathSync.native(dir), dir);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, created.dev); assert.equal(current.ino, created.ino);
      fs.rmSync(dir, { recursive: true });
    } catch (error) { t.diagnostic(`Fixture retained or cleanup failed: ${dir}`); throw error; }
  });
  for (const mode of ["direct-exit", "sigterm-shutdown"]) {
    const socketPath = path.join(dir, mode === "direct-exit" ? "a" : "b");
    const source = "const s=require('node:net').createServer();s.listen(process.argv[1],()=>process.send('ready'));" +
      "process.on('message',()=>process.exit(0));process.on('SIGTERM',()=>s.close(()=>process.exit(0)));setTimeout(()=>process.exit(0),20000)";
    const child = spawn(process.execPath, ["-e", source, socketPath], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.closed = new Promise(resolve => child.once("close", resolve)); children.push(child);
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("close", () => reject(Error("owner exited before ready"))); });
    const oldInode = fs.lstatSync(socketPath).ino;
    fs.unlinkSync(socketPath);
    const replacement = net.createServer(); servers.push(replacement);
    await new Promise((resolve, reject) => replacement.once("error", reject).listen(socketPath, resolve));
    assert.notEqual(fs.lstatSync(socketPath).ino, oldInode);
    if (mode === "direct-exit") child.send("exit"); else child.kill("SIGTERM");
    assert.equal(await child.closed, 0);
    const retained = fs.existsSync(socketPath);
    t.diagnostic(`${mode}: replacement socket retained=${retained}`);
    assert.equal(retained, mode === "direct-exit");
    await new Promise(resolve => replacement.close(resolve));
  }
});

test("managed connection rejects a generation changed after the readiness probe", { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const root = fs.realpathSync.native(os.tmpdir()), workspace = fs.mkdtempSync(path.join(root, "broker-switch-"));
  const dir = fs.mkdtempSync(path.join(root, "gkc-")), data = path.join(workspace, "data");
  const identities = new Map([workspace, dir].map(value => [value, fs.lstatSync(value)])); fs.mkdirSync(data);
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const endpoint = createBrokerEndpoint(dir), socketPath = endpoint.slice(5), generation = "ready-generation";
  let first, replacement; const sockets = new Set(), seen = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of [replacement, first]) if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    for (const target of [dir, workspace]) {
      if (!fs.existsSync(target)) continue;
      const current = fs.lstatSync(target), before = identities.get(target);
      assert.equal(path.dirname(target), root); assert.equal(fs.realpathSync.native(target), target);
      assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.dev, before.dev); assert.equal(current.ino, before.ino);
      fs.rmSync(target, { recursive: true });
    }
  });
  const reply = (socket, message, value) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
    result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokBrokerGeneration: value } } })}\n`);
  replacement = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("data", data => { const message = JSON.parse(data.toString().trim()); seen.push(message.method); reply(socket, message, "replacement-generation"); });
  });
  first = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("data", data => {
      const message = JSON.parse(data.toString().trim());
      fs.unlinkSync(socketPath);
      replacement.listen(socketPath, () => reply(socket, message, generation));
    });
  });
  await new Promise((resolve, reject) => first.once("error", reject).listen(socketPath, resolve));
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace) });
  const pidFile = path.join(dir, "broker.pid"), logFile = path.join(dir, "broker.log");
  const session = { generation, endpoint, pid: process.pid, authMode: "browser", sessionDir: dir, pidFile, logFile };
  saveBrokerSession(workspace, session);
  const journal = path.join(resolveBrokerStateDir(workspace), "broker-admission.jsonl");
  const pending = { version: 2, event: "pending", generation, ownerPid: process.pid, platform: "darwin", lockToken: "fixture", endpoint, sessionDir: dir, pidFile, logFile };
  fs.writeFileSync(journal, [pending, { version: 2, event: "spawned", generation, pid: process.pid, pgid: process.pid },
    { version: 2, event: "settled", generation, pid: process.pid, outcome: "ready" },
    { version: 2, event: "confirmed", generation, pid: process.pid, outcome: "ready" }].map(value => JSON.stringify(value) + "\n").join(""));
  await assert.rejects(GrokAcpClient.connect(workspace, { env: { ...process.env, GROK_BIN: refusingGrok, XAI_API_KEY: "" }, grokBin: refusingGrok }), /generation.*managed session/i);
  assert.deepEqual(seen, ["initialize"]);
});

test("real broker flushes idle ACK and stops its agent without unlinking a replacement", { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const root = fs.realpathSync.native(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(root, "broker-exit-")), data = path.join(workspace, "data");
  const created = fs.lstatSync(workspace); fs.mkdirSync(data);
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const fake = path.join(workspace, "grok.mjs"), events = path.join(workspace, "agent-events");
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\n` +
    `const record=what=>fs.appendFileSync(${JSON.stringify(events)},what+'\\n');let buf='';` +
    `process.stdin.on('data',chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);` +
    `if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n')}});` +
    `let stopping=false;const stop=()=>{if(stopping)return;stopping=true;setTimeout(()=>{record('agent-stopped');process.exit(0)},150)};` +
    `process.stdin.on('end',stop);process.on('SIGTERM',stop);setTimeout(stop,20000);`, { mode: 0o755 });
  let broker, brokerClosed, session, replacement; const sockets = [], brokers = [], sessionDirs = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (replacement?.listening) await new Promise(resolve => replacement.close(resolve));
    for (const owned of brokers) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGTERM");
      await owned.closed;
    }
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    if (broker && !fs.existsSync(events)) { t.diagnostic(`Agent exit unconfirmed; retained fixture: ${workspace}`); return; }
    for (const target of [...sessionDirs, workspace]) {
      if (!target || !fs.existsSync(target)) continue;
      if (target === workspace) { const current = fs.lstatSync(target); assert.equal(current.dev, created.dev); assert.equal(current.ino, created.ino); }
      assert.equal(path.dirname(target), root); assert.equal(fs.realpathSync.native(target), target);
      fs.rmSync(target, { recursive: true });
    }
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace) });
  const startBroker = () => ensureBrokerSession(workspace, { env: { ...process.env, GROK_BIN: fake, XAI_API_KEY: "" }, timeoutMs: 10000,
    onBrokerSpawn(child) { broker = child; child.ref(); brokerClosed = new Promise(resolve => child.once("close", resolve)); brokers.push({ child, closed: brokerClosed }); } });
  session = await startBroker();
  assert.ok(session && broker);
  sessionDirs.push(session.sessionDir);
  const connect = async () => {
    const socket = net.createConnection(session.endpoint.slice(5)); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return socket;
  };
  const rpc = (socket, id, method, params = {}) => new Promise((resolve, reject) => {
    let buffer = "";
    const onData = chunk => { buffer += chunk; const end = buffer.indexOf("\n"); if (end < 0) return;
      socket.off("data", onData); try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); } };
    socket.on("data", onData); socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const control = await connect(), other = await connect();
  assert.equal((await rpc(control, 1, "initialize")).result._meta.grokBrokerGeneration, session.generation);
  await rpc(other, 2, "initialize");
  assert.ok((await rpc(control, 3, "broker/shutdownIfIdle", { generation: session.generation })).error);
  other.end(); await new Promise(resolve => other.once("close", resolve));
  await new Promise(resolve => setTimeout(resolve, 50));
  const socketPath = session.endpoint.slice(5);
  const original = fs.lstatSync(socketPath).ino;
  fs.unlinkSync(socketPath);
  replacement = net.createServer();
  await new Promise((resolve, reject) => replacement.once("error", reject).listen(socketPath, resolve));
  const replacementInode = fs.lstatSync(socketPath).ino;
  assert.notEqual(replacementInode, original);
  const reply = await rpc(control, 4, "broker/shutdownIfIdle", { generation: session.generation });
  assert.equal(reply.result?.closing, true); assert.equal(reply.result?.generation, session.generation);
  assert.equal(broker.exitCode, null);
  broker.kill("SIGTERM");
  assert.equal(await brokerClosed, 0);
  assert.match(fs.readFileSync(events, "utf8"), /agent-stopped/);
  assert.equal(fs.existsSync(socketPath) && fs.lstatSync(socketPath).ino === replacementInode, true);
  saveBrokerSession(workspace, { ...session, shutdownAcceptedGeneration: session.generation });
  assert.equal(await cleanupIdleBrokerSession(workspace, session, { timeoutMs: 3000 }), true);
  assert.equal(loadBrokerSession(workspace), null);
  assert.equal(fs.existsSync(socketPath), true);
  const next = await startBroker();
  assert.ok(next && next.generation !== session.generation && next.sessionDir !== session.sessionDir);
  sessionDirs.push(next.sessionDir);
  assert.equal(await cleanupIdleBrokerSession(workspace, next, { timeoutMs: 5000 }), true);
  assert.equal(await brokerClosed, 0);
  assert.equal(fs.readFileSync(events, "utf8").trim().split("\n").length, 2);
  assert.ok(fs.existsSync(next.endpoint.slice(5)), "normal POSIX shutdown retains its socket for offline cleanup");
});

for (const mode of ["agent-exits-before-pid", "listen-fails-after-pid"]) test(`failed POSIX startup retains its owned diagnostic artifacts (${mode})`, { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const root = fs.realpathSync.native(os.tmpdir()), workspace = fs.mkdtempSync(path.join(root, "broker-failed-"));
  const workspaceIdentity = fs.lstatSync(workspace), data = path.join(workspace, "data"); fs.mkdirSync(data);
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const fake = path.join(workspace, "grok.mjs");
  const fakeSource = mode === "agent-exits-before-pid"
    ? String.raw`process.stderr.write('fixture-early-agent-failure\n');process.exitCode=2;`
    : String.raw`let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){
        const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
        if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\n');
      }});process.stdin.on('end',()=>process.exit(0));`;
  fs.writeFileSync(fake, `#!${process.execPath}\n${fakeSource}\n`, { mode: 0o755 });
  let child, closed, sessionDir, sessionIdentity, endpointPath, cleanupConfirmed = false;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (closed) await closed;
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    assert.ok(cleanupConfirmed, `Owned broker group exit unconfirmed; retained fixture: ${workspace}; session: ${sessionDir}`);
    for (const [target, expected] of [[sessionDir, sessionIdentity], [workspace, workspaceIdentity]]) {
      if (!target || !fs.existsSync(target)) continue;
      const current = fs.lstatSync(target);
      assert.equal(path.dirname(target), root); assert.equal(fs.realpathSync.native(target), target);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, expected.dev); assert.equal(current.ino, expected.ino);
      fs.rmSync(target, { recursive: true });
    }
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace) });
  const result = await ensureBrokerSession(workspace, { env: { ...process.env, GROK_BIN: fake, XAI_API_KEY: "" }, timeoutMs: 10000,
    createBrokerEndpoint(dir) {
      sessionDir = dir; sessionIdentity = fs.lstatSync(dir);
      const endpoint = createBrokerEndpoint(dir);
      endpointPath = endpoint.slice("unix:".length);
      if (mode === "listen-fails-after-pid") fs.writeFileSync(endpointPath, "fixture-owned occupied endpoint");
      return endpoint;
    },
    onBrokerSpawn(value) { child = value; value.ref(); closed = new Promise(resolve => value.once("close", resolve)); }
  });
  if (result === null && child && closed) { await closed; cleanupConfirmed = true; }
  assert.equal(result, null);
  assert.ok(child && sessionDir && cleanupConfirmed);
  const pidFile = path.join(sessionDir, "broker.pid"), logFile = path.join(sessionDir, "broker.log");
  assert.ok(fs.existsSync(logFile), "failed startup must retain its diagnostic log");
  const log = fs.readFileSync(logFile, "utf8");
  if (mode === "agent-exits-before-pid") {
    assert.equal(fs.existsSync(pidFile), false, "the broker has not written a PID before agent initialization");
    assert.match(log, /fixture-early-agent-failure/);
  } else {
    assert.equal(fs.readFileSync(pidFile, "utf8").trim(), String(child.pid), "the written broker PID must be retained");
    assert.match(log, /could not listen.*EADDRINUSE/i);
    assert.equal(fs.readFileSync(endpointPath, "utf8"), "fixture-owned occupied endpoint");
  }
  assert.equal(loadBrokerSession(workspace), null);
});
