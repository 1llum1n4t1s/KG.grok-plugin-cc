import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { findLatestTaskSession, interruptGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { resolveStateDir, migrateStateLock } from "../plugins/grok/scripts/lib/state.mjs";
import { ensureBrokerSession, resolveBrokerStateDir, saveBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// Windows では fixture 作成前に skip。実行は隔離した POSIX 環境に限定する。
const posix = process.platform === "linux" || process.platform === "darwin";
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fixture(t) {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || os.tmpdir());
  assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
  for (let current = parent; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    if (path.dirname(current) === current) break;
  }
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "gda-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
  const log = path.join(root, "agent-started"), fake = path.join(root, "fake-grok");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({claudeData:process.env.CLAUDE_PLUGIN_DATA,pluginData:process.env.PLUGIN_DATA,
  tmpdir:process.env.TMPDIR,tmp:process.env.TMP,temp:process.env.TEMP}));
let gate, initialize;
const gatePath = process.env.GROK_COMPANION_BROKER_GENERATION ? process.env.FAKE_BROKER_INIT_GATE : process.env.FAKE_DIRECT_INIT_GATE;
if (gatePath) {
  gate = require('node:net').createConnection(gatePath);
  gate.on('data', command => {
    if (command.toString().includes('exit')) process.exit(0);
    if (initialize) { console.log(JSON.stringify(initialize)); initialize = null; }
  });
}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') {
    const response={jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}};
    if (gate) { initialize=response; gate.write('initialize\n'); }
    else console.log(JSON.stringify(response));
  }
  if(m.method==='session/list') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessions:[]}}));
});
`, { mode: 0o755 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "FAKE_AGENT_LOG", "GROK_COMPANION_ACP_ENDPOINT", "XAI_API_KEY", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_AGENT_LOG: log, HOME: root, USERPROFILE: root, TMPDIR: temp, TEMP: temp, TMP: temp });
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  delete process.env.XAI_API_KEY;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  const broker = resolveBrokerStateDir(cwd);
  fs.mkdirSync(broker, { recursive: true });
  const journal = path.join(broker, "broker-admission.jsonl");
  const pending = JSON.stringify({ version: 2, event: "pending", generation: "isolated-pending", ownerPid: process.pid,
    platform: process.platform, lockToken: "isolated-owner", endpoint: "unix:/isolated/pending.sock", sessionDir: root,
    pidFile: path.join(root, "pending.pid"), logFile: path.join(root, "pending.log") }) + "\n";
  t.diagnostic(`Isolated fixture: ${root}`);
  const f = { root, cwd, data, fake, log, broker, journal, pending, retain: false };
  t.after(() => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    assert.equal(path.dirname(root), parent);
    if (!f.retain) fs.rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Retained fixture pending process cleanup: ${root}`);
  });
  return f;
}

function directGate(f) {
  const fifo = path.join(f.root, "gate.fifo"), ready = path.join(f.root, "gate-entered"), preload = path.join(f.root, "gate.cjs");
  const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  fs.writeFileSync(preload, `const fs=require('node:fs'), cp=require('node:child_process');
    const original=cp.spawn; cp.spawn=function(command,...args) {
      if(command===process.env.FAKE_GATE_COMMAND) {
        fs.writeFileSync(process.env.FAKE_GATE_READY,'entered');
        const fd=fs.openSync(process.env.FAKE_GATE_FIFO,'r'); const b=Buffer.alloc(1);
        fs.readSync(fd,b,0,1,null); fs.closeSync(fd);
      }
      return original.call(this,command,...args);
    }; require('node:module').syncBuiltinESMExports();`);
  const wait = () => new Promise((resolve, reject) => {
    let timer;
    const watcher = fs.watch(f.root, () => { if (fs.existsSync(ready)) finish(); });
    const finish = () => { clearTimeout(timer); watcher.close(); resolve(); };
    timer = setTimeout(() => { watcher.close(); reject(new Error("Direct agent did not reach the spawn gate")); }, 8000);
    if (fs.existsSync(ready)) finish();
  });
  const release = () => { const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); } };
  return { preload, fifo, ready, wait, release };
}

// 別 process から実際の broker 起動経路へ入り、起動できた場合は同じ process が停止を試みる。
async function tryBroker(f, childData = null, endpoint = null, brokerGate = null, agentTemp = null) {
  const moduleUrl = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const source = `import {ensureBrokerSession,cleanupIdleBrokerSession} from ${JSON.stringify(moduleUrl)};
    let session;
    try { session=await ensureBrokerSession(${JSON.stringify(f.cwd)}, {timeoutMs:4500,
        ...( ${JSON.stringify(endpoint)} ? {createBrokerEndpoint:()=>${JSON.stringify(endpoint)}} : {} ),
        env:{...process.env,...(${JSON.stringify(childData)} ? {CLAUDE_PLUGIN_DATA:${JSON.stringify(childData)},PLUGIN_DATA:${JSON.stringify(childData)}} : {}),
          ...(${JSON.stringify(brokerGate)} ? {FAKE_BROKER_INIT_GATE:${JSON.stringify(brokerGate)}} : {}),
          ...(${JSON.stringify(agentTemp)} ? {TMPDIR:${JSON.stringify(agentTemp)},TMP:${JSON.stringify(agentTemp)},TEMP:${JSON.stringify(agentTemp)}} : {})}});
      const cleaned=session ? await cleanupIdleBrokerSession(${JSON.stringify(f.cwd)},session,{timeoutMs:4000}) : true;
      console.log(JSON.stringify({started:!!session,cleaned}));
    } catch(e) { console.log(JSON.stringify({started:!!session,cleaned:session ? false : undefined,error:e.message})); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.retain = true; child.kill("SIGKILL"); reject(new Error(`Broker probe timed out: ${stderr}`)); }, 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  if (payload.cleaned === false) f.retain = true;
  if (payload.error && fs.existsSync(f.journal) && fs.readFileSync(f.journal, "utf8").includes('"event":"pending"')) f.retain = true;
  return payload;
}

function assertNoBrokerAdmission(f) {
  const records = fs.existsSync(f.journal) ? fs.readFileSync(f.journal, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  assert.equal(records.some(record => record.event === "pending"), false, "broker started while direct startup was unconfirmed");
}

function startDirectOwner(f, gate) {
  const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)};
    const client=await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {disableBroker:true,grokBin:${JSON.stringify(f.fake)}});
    console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve)); await client.close();`;
  const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(gate.preload)}`, FAKE_GATE_COMMAND: f.fake,
    FAKE_GATE_FIFO: gate.fifo, FAKE_GATE_READY: gate.ready };
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  owner.stdin.on("error", () => {});
  let stderr = "";
  owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.once("close", resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Direct owner did not initialize: ${stderr}`)), 8000);
    owner.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    owner.once("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Direct owner exited ${code}: ${stderr}`)); });
  });
  void ready.catch(() => {});
  return { owner, closed, ready };
}

test("another process cannot start a broker while direct spawn is gated", { skip: !posix }, async t => {
  const f = fixture(t), gate = directGate(f), direct = startDirectOwner(f, gate);
  let released = false;
  try {
    await gate.wait();
    const probe = await tryBroker(f);
    assertNoBrokerAdmission(f);
    assert.equal(probe.started, false);
    gate.release(); released = true;
    await direct.ready;
    const afterReady = await tryBroker(f);
    assert.equal(afterReady.started, true, afterReady.error);
    assert.equal(afterReady.cleaned, true, "broker cleanup was not confirmed; fixture retained");
  } finally {
    if (released) direct.owner.stdin.end("close\n");
    else if (direct.owner.exitCode === null && direct.owner.signalCode === null) direct.owner.kill("SIGKILL");
    await direct.closed;
  }
});

test("owner crash during gated direct spawn does not permit broker startup", { skip: !posix }, async t => {
  const f = fixture(t), gate = directGate(f), direct = startDirectOwner(f, gate);
  try {
    await gate.wait();
    direct.owner.kill("SIGKILL");
    await direct.closed;
    const probe = await tryBroker(f);
    assertNoBrokerAdmission(f);
    assert.equal(probe.started, false);
  } finally {
    if (direct.owner.exitCode === null && direct.owner.signalCode === null) direct.owner.kill("SIGKILL");
    await direct.closed;
  }
});

// より厳しい orphan 保留設計の検証。agent spawn は既に成功しており、spawn 前競合とは区別する。
test("owner crash with spawned uninitialized agent preserves the stronger orphan hold", { skip: !posix }, async t => {
  const f = fixture(t), address = path.join(f.root, "init.sock");
  let peer, resolveEntered;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const server = net.createServer(socket => { peer = socket; socket.once("data", resolveEntered); });
  await new Promise((resolve, reject) => server.once("error", reject).listen(address, resolve));
  const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)}; await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {disableBroker:true,grokBin:${JSON.stringify(f.fake)}});`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
    env: { ...process.env, FAKE_DIRECT_INIT_GATE: address }, stdio: ["ignore", "ignore", "pipe"] });
  const closed = new Promise(resolve => owner.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Agent did not reach initialization gate")), 8000);
      entered.then(() => { clearTimeout(timer); resolve(); });
    });
    owner.kill("SIGKILL");
    await closed;
    const probe = await tryBroker(f);
    assertNoBrokerAdmission(f);
    assert.equal(probe.started, false);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await closed;
    if (peer && !peer.destroyed) {
      const peerClosed = new Promise(resolve => peer.once("close", resolve));
      peer.write("exit\n");
      await peerClosed;
    }
    await new Promise(resolve => server.close(resolve));
  }
});

test("broker may start its own agent while its admission is pending", { skip: !posix }, async t => {
  const f = fixture(t);
  const probe = await tryBroker(f);
  assert.equal(probe.started, true, probe.error);
  assert.equal(probe.cleaned, true, "broker cleanup was not confirmed; fixture retained");
  const records = fs.readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some(record => record.event === "pending"));
  assert.ok(records.some(record => record.event === "settled" && record.outcome === "ready"));
});

test("existing unrelated listener cannot confirm a new broker generation", { skip: !posix }, async t => {
  const f = fixture(t), socketPath = path.join(f.root, "occupied.sock"), gatePath = path.join(f.root, "broker-gate.sock");
  const listener = net.createServer(socket => socket.destroy());
  let peer, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = net.createServer(socket => { peer = socket; socket.once("data", enter); });
  await new Promise((resolve, reject) => listener.once("error", reject).listen(socketPath, resolve));
  await new Promise((resolve, reject) => gate.once("error", reject).listen(gatePath, resolve));
  try {
    const pendingProbe = tryBroker(f, null, `unix:${socketPath}`, gatePath);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Broker agent did not reach initialization gate")), 8000);
      entered.then(() => { clearTimeout(timer); resolve(); });
    });
    const probe = await pendingProbe;
    const records = fs.readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.some(record => record.event === "confirmed" && record.outcome === "ready"), false,
      "an unrelated listener was accepted as the broker's ready endpoint");
    assert.equal(probe.started, false);
  } finally {
    if (peer && !peer.destroyed) {
      const closed = new Promise(resolve => peer.once("close", resolve));
      peer.write("exit\n");
      await closed;
    }
    await new Promise(resolve => gate.close(resolve));
    await new Promise(resolve => listener.close(resolve));
  }
});

test("confirmed direct spawn failure allows subsequent broker startup", { skip: !posix }, async t => {
  const f = fixture(t);
  await assert.rejects(GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: path.join(f.root, "missing-executable") }), /ENOENT/);
  assert.equal(fs.existsSync(f.log), false);
  const probe = await tryBroker(f);
  assert.equal(probe.started, true, probe.error);
  assert.equal(probe.cleaned, true, "broker cleanup was not confirmed; fixture retained");
});

for (const fault of ["write", "fsync", "unlink"]) {
  test(`direct reservation creation ${fault} failure does not spawn an agent`, { skip: !posix }, t => {
    const f = fixture(t), preload = path.join(f.root, "reservation-fault.cjs");
    fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), opens=fs.openSync, closes=fs.closeSync, write=fs.writeFileSync, sync=fs.fsyncSync, unlink=fs.unlinkSync;
const tracked=new Set();
fs.openSync=function(file,...args){const fd=opens.call(this,file,...args);if(typeof file==='string'&&file.includes('direct-start-v1')&&file.endsWith('.jsonl'))tracked.add(fd);return fd;};
fs.closeSync=function(fd){tracked.delete(fd);return closes.call(this,fd);};
fs.writeFileSync=function(file,...args){if(process.env.FAIL_KIND==='write'&&tracked.has(file))throw Error('fixture marker write failure');return write.call(this,file,...args);};
fs.fsyncSync=function(fd){if(['fsync','unlink'].includes(process.env.FAIL_KIND)&&tracked.has(fd))throw Error('fixture marker fsync failure');return sync.call(this,fd);};
fs.unlinkSync=function(file,...args){if(process.env.FAIL_KIND==='unlink'&&typeof file==='string'&&file.includes('direct-start-v1'))throw Error('fixture marker unlink failure');return unlink.call(this,file,...args);};
require('node:module').syncBuiltinESMExports();`);
    const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
    const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)};
      try { const client=await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {disableBroker:true,grokBin:${JSON.stringify(f.fake)}});
        await client.close(); process.exitCode=7; } catch(error) { process.stdout.write(error.message); }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, encoding: "utf8", timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, FAIL_KIND: fault } });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture marker (?:write|fsync) failure/i);
    assert.equal(fs.existsSync(f.log), false);
    const dir = path.join(resolveStateDir(f.cwd), "direct-start-v1");
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.equal(entries.length, fault === "unlink" ? 1 : 0, "failed reservation must be safely recovered or retained");
  });
}

test("stopped agent can confirm a ready record after its first fsync fails", { skip: !posix }, t => {
  const f = fixture(t), preload = path.join(f.root, "release-fault.cjs");
  fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), opens=fs.openSync, closes=fs.closeSync, sync=fs.fsyncSync;
const tracked=new Set(); let markerSyncs=0;
fs.openSync=function(file,...args){const fd=opens.call(this,file,...args);if(typeof file==='string'&&file.includes('direct-start-v1')&&file.endsWith('.jsonl'))tracked.add(fd);return fd;};
fs.closeSync=function(fd){tracked.delete(fd);return closes.call(this,fd);};
fs.fsyncSync=function(fd){if(tracked.has(fd)&&++markerSyncs===2)throw Error('fixture ready fsync failure');return sync.call(this,fd);};
require('node:module').syncBuiltinESMExports();`);
  const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)};
    try { const client=await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {disableBroker:true,grokBin:${JSON.stringify(f.fake)}});
      await client.close(); process.exitCode=7; } catch(error) { process.stdout.write(error.message); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, encoding: "utf8", timeout: 15000,
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture ready fsync failure/i);
  assert.equal(fs.existsSync(f.log), true);
  const dir = path.join(resolveStateDir(f.cwd), "direct-start-v1");
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "confirmed stop must recover the owner's ready record");
});

test("managed broker handshake retries its own ready proof after fsync failure", { skip: !posix }, async t => {
  const f = fixture(t), endpoint = `unix:${path.join(f.root, "managed-ready.sock")}`, generation = "managed-ready";
  const preload = path.join(f.root, "managed-release-fault.cjs");
  fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), opens=fs.openSync, closes=fs.closeSync, sync=fs.fsyncSync;
const tracked=new Set(); let markerSyncs=0;
fs.openSync=function(file,...args){const fd=opens.call(this,file,...args);if(typeof file==='string'&&file.includes('direct-start-v1')&&file.endsWith('.jsonl'))tracked.add(fd);return fd;};
fs.closeSync=function(fd){tracked.delete(fd);return closes.call(this,fd);};
fs.fsyncSync=function(fd){if(tracked.has(fd)&&++markerSyncs===2)throw Error('fixture managed ready fsync failure');return sync.call(this,fd);};
require('node:module').syncBuiltinESMExports();`);
  const server = net.createServer(socket => socket.on("data", chunk => {
    const request = JSON.parse(chunk.toString().trim());
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokBrokerGeneration: generation } } })}\n`);
  }));
  await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint.slice(5), resolve));
  try {
    fs.writeFileSync(f.journal, [
      { ...JSON.parse(f.pending), generation, endpoint },
      { version: 2, event: "spawned", generation, pid: process.pid, pgid: process.pid },
      { version: 2, event: "settled", generation, pid: process.pid, outcome: "ready" },
      { version: 2, event: "confirmed", generation, pid: process.pid, outcome: "ready" }
    ].map(record => `${JSON.stringify(record)}\n`).join(""));
    saveBrokerSession(f.cwd, { generation, endpoint, pid: process.pid, authMode: "browser" });
    const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
    const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)};
      try { const client=await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {reuseExistingBroker:true});
        await client.close(); process.exitCode=7; } catch(error) { process.stdout.write(error.message); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { f.retain = true; child.kill("SIGKILL"); reject(new Error("Managed handshake probe timed out")); }, 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", value => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /fixture managed ready fsync failure/i);
    const dir = path.join(resolveStateDir(f.cwd), "direct-start-v1");
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
    assert.equal(fs.existsSync(f.log), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("broker spawn observer failure stops the owned child before granting agent startup", { skip: !posix }, async t => {
  const f = fixture(t);
  let child;
  try {
    await assert.rejects(ensureBrokerSession(f.cwd, { onBrokerSpawn(value) { child = value; throw new Error("fixture observer failure"); } }), /fixture observer failure/);
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned broker child did not stop");
    assert.equal(fs.existsSync(f.log), false, "broker agent started before authorization");
    const records = fs.readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map(record => record.event), ["pending", "spawned"]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) f.retain = true;
  }
});

async function expectBlocked(f, run, expectedJournal = f.pending, expectedSession = null) {
  let client, error;
  try { client = await run(); } catch (caught) { error = caught; }
  if (client && typeof client.close === "function") await client.close();
  assert.equal(fs.readFileSync(f.journal, "utf8"), expectedJournal, "admission journal changed");
  const sessionFile = path.join(f.broker, "broker.json");
  if (expectedSession) assert.deepEqual(fs.readFileSync(sessionFile), expectedSession);
  else assert.equal(fs.existsSync(sessionFile), false, "broker session unexpectedly created");
  assert.equal(fs.existsSync(f.log), false, "direct agent was spawned while broker admission was unconfirmed");
  assert.ok(error, "direct startup must reject while broker admission is unconfirmed");
}

test("pending admission blocks direct agent when broker reuse has no saved session", { skip: !posix }, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, f.pending);
  const before = fs.readFileSync(f.journal);
  await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { reuseExistingBroker: true, grokBin: f.fake }));
  assert.deepEqual(fs.readFileSync(f.journal), before);
  assert.equal(fs.existsSync(path.join(f.broker, "broker.json")), false);
});

test("workspace alias cannot bypass the original pending admission", { skip: !posix }, async t => {
  const f = fixture(t), alias = path.join(f.root, "workspace-alias");
  fs.symlinkSync(f.cwd, alias, "dir");
  fs.writeFileSync(f.journal, f.pending);
  await expectBlocked(f, () => GrokAcpClient.connect(alias, { disableBroker: true, grokBin: f.fake }));
});

for (const kind of ["one", "multiple", "symlink"]) {
  test(`canonical workspace refuses legacy alias state: ${kind}`, { skip: !posix }, async t => {
    const f = fixture(t), current = resolveStateDir(f.cwd), stateRoot = path.dirname(current);
    const suffix = path.basename(current).slice(-16);
    const legacy = path.join(stateRoot, `old-alias-${suffix}`);
    const retained = path.join(f.root, "legacy-data");
    fs.mkdirSync(retained);
    if (kind === "symlink") fs.symlinkSync(retained, legacy, "dir");
    else fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(kind === "symlink" ? retained : legacy, "legacy-record"), "preserve");
    if (kind === "multiple") fs.mkdirSync(path.join(stateRoot, `second-alias-${suffix}`));
    let client, error;
    try { client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }); }
    catch (caught) { error = caught; }
    if (client) await client.close();
    assert.equal(fs.readFileSync(path.join(kind === "symlink" ? retained : legacy, "legacy-record"), "utf8"), "preserve");
    assert.equal(fs.existsSync(f.log), false, "canonical path ignored separate legacy alias state");
    assert.ok(error, "legacy alias state requires explicit recovery before startup");
  });
}

test("canonical workspace selects the sole preexisting alias state", { skip: !posix }, t => {
  const f = fixture(t), alternate = path.join(f.root, "old-data");
  fs.mkdirSync(alternate);
  const previousClaude = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = alternate;
    process.env.PLUGIN_DATA = alternate;
    const proposed = resolveStateDir(f.cwd), suffix = path.basename(proposed).slice(-16);
    const legacy = path.join(alternate, "state", `old-alias-${suffix}`);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "legacy-record"), "preserve");
    assert.equal(resolveStateDir(f.cwd), legacy);
    assert.equal(fs.readFileSync(path.join(legacy, "legacy-record"), "utf8"), "preserve");
    assert.equal(fs.existsSync(proposed), false);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = previousClaude;
    process.env.PLUGIN_DATA = previousPlugin;
  }
});

test("different child data env cannot bypass the parent pending admission", { skip: !posix }, async t => {
  const f = fixture(t), other = path.join(f.root, "other-data");
  fs.mkdirSync(other);
  fs.writeFileSync(f.journal, f.pending);
  await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: other, PLUGIN_DATA: other } }));
});

test("broker uses the parent state identity while preserving the agent data env", { skip: !posix }, async t => {
  const f = fixture(t), other = path.join(f.root, "other-data");
  fs.mkdirSync(other);
  const probe = await tryBroker(f, other);
  assert.equal(probe.started, true, probe.error);
  assert.equal(probe.cleaned, true, "broker cleanup was not confirmed; fixture retained");
  const childEnv = JSON.parse(fs.readFileSync(f.log, "utf8"));
  assert.equal(fs.realpathSync.native(childEnv.claudeData), fs.realpathSync.native(other));
  assert.equal(fs.realpathSync.native(childEnv.pluginData), fs.realpathSync.native(other));
});

test("broker preserves the caller's agent temporary directory", { skip: !posix }, async t => {
  const f = fixture(t), agentTemp = path.join(f.root, "agent-temp");
  fs.mkdirSync(agentTemp);
  const probe = await tryBroker(f, null, null, null, agentTemp);
  assert.equal(probe.started, true, probe.error);
  assert.equal(probe.cleaned, true, "broker cleanup was not confirmed; fixture retained");
  const agent = JSON.parse(fs.readFileSync(f.log, "utf8"));
  assert.equal(agent.tmpdir, agentTemp);
  assert.equal(agent.tmp, agentTemp);
  assert.equal(agent.temp, agentTemp);
});

test("pending admission blocks capacity direct fallback", { skip: !posix }, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, f.pending);
  const before = fs.readFileSync(f.journal);
  await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }));
  assert.deepEqual(fs.readFileSync(f.journal), before);
});

test("task session discovery with no tracked candidate cannot bypass pending admission", { skip: !posix }, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, f.pending);
  const before = fs.readFileSync(f.journal);
  await expectBlocked(f, () => findLatestTaskSession(f.cwd));
  assert.deepEqual(fs.readFileSync(f.journal), before);
  assert.equal(fs.existsSync(path.join(f.broker, "broker.json")), false);
});

test("task --resume-last with no current session cannot bypass pending admission", { skip: !posix }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, f.pending);
  const env = { ...process.env };
  delete env.GROK_COMPANION_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  const result = spawnSync(process.execPath, [path.join(repository, "plugins/grok/scripts/grok-companion.mjs"),
    "task", "--cwd", f.cwd, "--resume-last", "continue"], { cwd: f.cwd, env, encoding: "utf8", timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(fs.readFileSync(f.journal, "utf8"), f.pending);
  assert.equal(fs.existsSync(path.join(f.broker, "broker.json")), false);
  assert.equal(fs.existsSync(f.log), false, "task resume spawned a direct agent while admission was pending");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broker admission journal/i);
});

test("automatic broker reuse cannot connect to an unconfirmed generation", { skip: !posix }, async t => {
  const f = fixture(t), socketPath = path.join(f.root, "managed.sock"), endpoint = `unix:${socketPath}`;
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  try {
    const pending = { ...JSON.parse(f.pending), endpoint };
    fs.writeFileSync(f.journal, `${JSON.stringify(pending)}\n`);
    saveBrokerSession(f.cwd, { generation: pending.generation, endpoint, pid: process.pid, authMode: "browser" });
    let client, error;
    try { client = await GrokAcpClient.connect(f.cwd, { reuseExistingBroker: true, grokBin: f.fake }); }
    catch (caught) { error = caught; }
    if (client) await client.close();
    assert.equal(fs.readFileSync(f.journal, "utf8"), `${JSON.stringify(pending)}\n`);
    assert.equal(connections, 0, "automatic reuse connected to an unconfirmed managed broker");
    assert.equal(fs.existsSync(f.log), false);
    assert.ok(error);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("broker-only cancellation timeout leaves no unresolved startup marker", { skip: !posix }, async t => {
  const f = fixture(t), socketPath = path.join(f.root, "cancel-managed.sock"), endpoint = `unix:${socketPath}`;
  const server = net.createServer(socket => { socket.on("data", () => {}); });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  try {
    const generation = "cancel-managed";
    const journal = [
      { ...JSON.parse(f.pending), generation, endpoint },
      { version: 2, event: "spawned", generation, pid: process.pid, pgid: process.pid },
      { version: 2, event: "settled", generation, pid: process.pid, outcome: "ready" },
      { version: 2, event: "confirmed", generation, pid: process.pid, outcome: "ready" }
    ].map(record => `${JSON.stringify(record)}\n`).join("");
    fs.writeFileSync(f.journal, journal);
    saveBrokerSession(f.cwd, { generation, endpoint, pid: process.pid, authMode: "browser" });
    await assert.rejects(GrokAcpClient.connect(f.cwd, { reuseExistingBroker: true, brokerOnly: true,
      cancellationOnly: true, cancellationGeneration: generation, cancellationSessionId: "s", cancellationExecutionId: "e",
      brokerDeadlineMs: Date.now() + 800, grokBin: f.fake }));
    const dir = path.join(resolveStateDir(f.cwd), "direct-start-v1");
    const unresolved = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => {
      const lines = fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n");
      try { return JSON.parse(lines.at(-1)).event !== "confirmed"; } catch { return true; }
    }) : [];
    assert.deepEqual(unresolved, [], "cancel timeout left an unresolved startup marker");
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(fs.readFileSync(f.journal, "utf8"), journal);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("cancellation lookup bounds a stalled Git before inspecting saved broker", { skip: !posix }, t => {
  const f = fixture(t), bin = path.join(f.root, "slow-git-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 3\n", { mode: 0o755 });
  const moduleUrl = new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).href;
  const source = `import {interruptGrokTurn} from ${JSON.stringify(moduleUrl)}; import {performance} from 'node:perf_hooks';
    const start=performance.now(); const result=await interruptGrokTurn(${JSON.stringify(f.cwd)},
      {sessionId:'s',executionId:'e',transport:'broker',brokerGeneration:'generation'});
    console.log(JSON.stringify({elapsed:performance.now()-start,result}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, encoding: "utf8", timeout: 8000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.elapsed < 2500, `cancel Git lookup exceeded its budget: ${output.elapsed}ms`);
  assert.notEqual(output.result.stopConfirmed, true);
  assert.equal(fs.existsSync(f.log), false);
});

test("resume broker-only handshake keeps admission until initialization completes", { skip: !posix }, async t => {
  const f = fixture(t), endpoint = `unix:${path.join(f.root, "resume.sock")}`, generation = "resume-managed";
  let peer, resolveRequest;
  const requestArrived = new Promise(resolve => { resolveRequest = resolve; });
  const server = net.createServer(socket => {
    peer = socket;
    socket.once("data", chunk => resolveRequest(JSON.parse(chunk.toString().trim())));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint.slice(5), resolve));
  let client;
  try {
    fs.writeFileSync(f.journal, [
      { ...JSON.parse(f.pending), generation, endpoint },
      { version: 2, event: "spawned", generation, pid: process.pid, pgid: process.pid },
      { version: 2, event: "settled", generation, pid: process.pid, outcome: "ready" },
      { version: 2, event: "confirmed", generation, pid: process.pid, outcome: "ready" }
    ].map(record => `${JSON.stringify(record)}\n`).join(""));
    saveBrokerSession(f.cwd, { generation, endpoint, pid: process.pid, authMode: "browser" });
    const pending = GrokAcpClient.connect(f.cwd, { reuseExistingBroker: true, brokerOnly: true, grokBin: f.fake });
    const request = await requestArrived;
    const markers = path.join(resolveStateDir(f.cwd), "direct-start-v1");
    assert.ok(fs.existsSync(markers) && fs.readdirSync(markers).length > 0, "resume handshake did not reserve admission");
    peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokBrokerGeneration: generation } } })}\n`);
    client = await pending;
    assert.equal(client.transport, "broker");
  } finally {
    if (client) await client.close();
    peer?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test("cancellation-only broker client rejects prompt requests", { skip: !posix }, async t => {
  const f = fixture(t), endpoint = `unix:${path.join(f.root, "cancel-only.sock")}`, generation = "cancel-only";
  const methods = [];
  const server = net.createServer(socket => socket.on("data", chunk => {
    const request = JSON.parse(chunk.toString().trim());
    methods.push(request.method);
    if (request.method === "initialize") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokBrokerGeneration: generation } } })}\n`);
  }));
  await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint.slice(5), resolve));
  try {
    const client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: endpoint, brokerOnly: true,
      cancellationOnly: true, cancellationGeneration: generation, cancellationSessionId: "s", cancellationExecutionId: "e", grokBin: f.fake });
    try {
      await assert.rejects(client.request("session/prompt", { sessionId: "s", prompt: [] }), /cancel|operation|method/i);
      await assert.rejects(client.request("broker/cancelTurn", { sessionId: "other", executionId: "e", generation }), /cancel|operation|generation/i);
      await assert.rejects(client.request("broker/cancelTurn", { sessionId: "s", executionId: "other", generation }), /cancel|operation|generation/i);
    }
    finally { await client.close(); }
    assert.deepEqual(methods, ["initialize"]);
    assert.equal(fs.existsSync(f.log), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const condition of ["pending", "corrupt", "wrong-generation"]) {
  test(`known broker cancellation while admission is ${condition}`, { skip: !posix }, async t => {
    const f = fixture(t), endpoint = `unix:${path.join(f.root, "cancel-known.sock")}`, generation = "known-broker";
    const seen = [];
    const server = net.createServer(socket => { let buffer = ""; socket.on("data", chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const request = JSON.parse(line); seen.push(request.method);
        if (request.method === "initialize") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
          result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokExecutionLedger: true,
            grokBrokerGeneration: condition === "wrong-generation" ? "other-broker" : generation } } })}\n`);
        if (request.method === "broker/cancelTurn") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
          result: { generation, executionState: "terminal", reservationAccepted: true, notificationSent: true } })}\n`);
      }
    }); });
    await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint.slice(5), resolve));
    try {
      const journal = condition === "corrupt" ? '{"incomplete":' : f.pending;
      fs.writeFileSync(f.journal, journal);
      saveBrokerSession(f.cwd, { generation, endpoint, pid: process.pid, authMode: "browser" });
      const result = await interruptGrokTurn(f.cwd, { sessionId: "session-1", executionId: "execution-1",
        transport: "broker", brokerGeneration: generation });
      if (condition === "wrong-generation") {
        assert.notEqual(result.stopConfirmed, true);
        assert.deepEqual(seen, ["initialize"]);
      } else {
        assert.equal(result.stopConfirmed, true);
        assert.deepEqual(seen, ["initialize", "broker/cancelTurn"]);
      }
      assert.equal(fs.readFileSync(f.journal, "utf8"), journal);
      assert.equal(fs.existsSync(f.log), false);
      const markerDir = path.join(resolveStateDir(f.cwd), "direct-start-v1");
      assert.equal(fs.existsSync(markerDir) ? fs.readdirSync(markerDir).length : 0, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test("explicit external broker endpoint remains usable during managed pending admission", { skip: !posix }, async t => {
  const f = fixture(t), socketPath = path.join(f.root, "external.sock"), endpoint = `unix:${socketPath}`;
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`);
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  try {
    fs.writeFileSync(f.journal, f.pending);
    const client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: endpoint, grokBin: f.fake });
    try { assert.equal(client.transport, "broker"); } finally { await client.close(); }
    assert.equal(fs.readFileSync(f.journal, "utf8"), f.pending);
    assert.equal(fs.existsSync(f.log), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("pending admission written after readiness blocks broker connection fallback", { skip: !posix }, async t => {
  const f = fixture(t);
  const socketPath = path.join(f.root, "b.sock"), endpoint = `unix:${socketPath}`;
  let connections = 0;
  const generation = "settled-existing";
  const previous = [
    { ...JSON.parse(f.pending), generation, endpoint },
    { version: 2, event: "spawned", generation, pid: process.pid, pgid: process.pid },
    { version: 2, event: "settled", generation, pid: process.pid, outcome: "ready" },
    { version: 2, event: "confirmed", generation, pid: process.pid, outcome: "ready" }
  ].map(record => JSON.stringify(record) + "\n").join("");
  const server = net.createServer(socket => {
    connections++;
    if (connections === 2) {
      fs.appendFileSync(f.journal, f.pending);
      socket.destroy();
      return;
    }
    socket.once("data", chunk => {
      const request = JSON.parse(chunk.toString().trim());
      assert.equal(request.method, "initialize");
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {}, _meta: { grokBrokerGeneration: generation } } })}\n`);
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  try {
    fs.writeFileSync(f.journal, previous);
    saveBrokerSession(f.cwd, { generation: "settled-existing", endpoint, pid: process.pid, authMode: "browser" });
    const saved = fs.readFileSync(path.join(f.broker, "broker.json"));
    await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { grokBin: f.fake }), previous + f.pending, saved);
    assert.equal(connections, 2);
    assert.equal(fs.readFileSync(f.journal, "utf8"), previous + f.pending);
    assert.deepEqual(fs.readFileSync(path.join(f.broker, "broker.json")), saved);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// 失敗条件: 巨大 journal の全量読取り、読取り中の伸長による上限超過、
// 不正状態での broker/direct spawn、journal の変更、期限内に拒否できないこと。
for (const mode of ["oversized", "growing"]) for (const route of ["direct", "broker"]) {
  test(`bounded journal read rejects ${mode} data before ${route} startup`, { skip: !posix }, t => {
    const f = fixture(t), cap = 4 * 1024 * 1024, marker = path.join(f.root, "read-observation.json"), preload = path.join(f.root, "bounded-read.cjs");
    // 空ファイルは読取り前に拒否されるため、伸長試験では初期データを置く。
    fs.writeFileSync(f.journal, mode === "growing" ? "x" : "");
    if (mode === "oversized") fs.truncateSync(f.journal, cap + 1);
    fs.writeFileSync(preload, `const fs=require('node:fs'),m=require('node:module'),p=${JSON.stringify(f.journal)},marker=${JSON.stringify(marker)};
      const open=fs.openSync,close=fs.closeSync,fstat=fs.fstatSync,read=fs.readSync,readFile=fs.readFileSync;
      const tracked=new Set();let bytes=0,unbounded=false,grown=false;
      fs.openSync=function(name,...args){const fd=open.call(this,name,...args);if(name===p)tracked.add(fd);return fd};
      fs.closeSync=function(fd,...args){tracked.delete(fd);return close.call(this,fd,...args)};
      fs.fstatSync=function(fd,...args){const stat=fstat.call(this,fd,...args);if(tracked.has(fd)&&${mode === "growing"}&&!grown){grown=true;fs.truncateSync(p,${cap + 1})}return stat};
      fs.readSync=function(fd,buffer,offset,length,position){const n=read.call(this,fd,buffer,offset,length,position);if(tracked.has(fd)){bytes+=n;if(bytes>${cap + 1})throw Error('read budget exceeded')}return n};
      fs.readFileSync=function(name,...args){if(name===p){unbounded=true;throw Error('unbounded journal read')}return readFile.call(this,name,...args)};
      process.on('exit',()=>fs.writeFileSync(marker,JSON.stringify({bytes,unbounded,grown})));m.syncBuiltinESMExports();`);
    const moduleUrl = new URL(route === "direct" ? "../plugins/grok/scripts/lib/acp.mjs" : "../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
    const source = route === "direct"
      ? `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)}; try {await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {disableBroker:true,grokBin:${JSON.stringify(f.fake)}});process.exitCode=7} catch(e){console.log(e.message)}`
      : `import {ensureBrokerSession} from ${JSON.stringify(moduleUrl)}; try {await ensureBrokerSession(${JSON.stringify(f.cwd)});process.exitCode=7} catch(e){console.log(e.message)}`;
    const result = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", source], { cwd: f.cwd, env: process.env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /size limit/i);
    const observed = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(observed.unbounded, false);
    assert.ok(observed.bytes <= cap + 1);
    if (mode === "growing") assert.equal(observed.grown, true);
    assert.equal(fs.statSync(f.journal).size, cap + 1);
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(fs.existsSync(path.join(f.broker, "broker.json")), false);
  });
}

test("corrupt admission blocks direct startup", { skip: !posix }, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, '{"incomplete":');
  const before = fs.readFileSync(f.journal);
  await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }), before.toString());
  assert.deepEqual(fs.readFileSync(f.journal), before);
});

test("direct rejection before spawn closes without an outstanding exit wait", { skip: !posix }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, '{"incomplete":');
  const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)};
    try { await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {disableBroker:true,grokBin:${JSON.stringify(f.fake)}}); process.exitCode=7; }
    catch(error) { process.stdout.write(error.message); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source],
    { cwd: f.cwd, env: process.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `direct rejection did not settle: ${result.stderr}`);
  assert.match(result.stdout, /admission|journal/i);
  assert.equal(fs.existsSync(f.log), false);
});

test("invalid broker endpoint closes without an outstanding socket wait", { skip: !posix }, t => {
  const f = fixture(t);
  const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const source = `import {GrokAcpClient} from ${JSON.stringify(moduleUrl)};
    try { await GrokAcpClient.connect(${JSON.stringify(f.cwd)}, {brokerOnly:true,brokerEndpoint:'invalid-endpoint'}); process.exitCode=7; }
    catch(error) { process.stdout.write(error.message); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source],
    { cwd: f.cwd, env: process.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `broker rejection did not settle: ${result.stderr}`);
  assert.match(result.stdout, /endpoint/i);
  assert.equal(fs.existsSync(f.log), false);
});

test("legacy v1 pending admission remains blocked", { skip: !posix }, async t => {
  const f = fixture(t);
  const legacy = f.pending.replace('"version":2', '"version":1');
  fs.writeFileSync(f.journal, legacy);
  await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }), legacy);
});

test("v2 settled without confirmation remains blocked", { skip: !posix }, async t => {
  const f = fixture(t), generation = "isolated-pending";
  const journal = f.pending + [
    { version: 2, event: "spawned", generation, pid: null, pgid: null },
    { version: 2, event: "settled", generation, pid: null, outcome: "stopped" }
  ].map(record => JSON.stringify(record) + "\n").join("");
  fs.writeFileSync(f.journal, journal);
  await expectBlocked(f, () => GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }), journal);
});

test("confirmed v2 admission is accepted before direct startup", { skip: !posix }, async t => {
  const f = fixture(t);
  const generation = "isolated-pending";
  const transitions = [
    { version: 2, event: "spawned", generation, pid: null, pgid: null },
    { version: 2, event: "settled", generation, pid: null, outcome: "stopped" },
    { version: 2, event: "confirmed", generation, pid: null, outcome: "stopped" }
  ].map(record => JSON.stringify(record) + "\n").join("");
  const confirmed = f.pending + transitions;
  fs.writeFileSync(f.journal, confirmed);
  const client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake });
  try {
    assert.equal(fs.readFileSync(f.journal, "utf8"), confirmed);
    assert.equal(fs.existsSync(f.log), true);
  } finally { await client.close(); }
});

for (const foreign of [false, true]) {
  test(`confirmed direct marker compares physical state identity: ${foreign ? "different inode" : "data alias"}`, { skip: !posix }, async t => {
    const f = fixture(t), stateDir = resolveStateDir(f.cwd), stat = fs.statSync(stateDir, { bigint: true });
    const protocol = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
    const ownerIdentity = { stateDir, hostId: protocol.hostId, volumeGuid: protocol.volumeGuid ?? null,
      directoryIdentity: { dev: String(stat.dev), ino: foreign ? String(stat.ino + 1n) : String(stat.ino) } };
    const dir = path.join(stateDir, "direct-start-v1"), generation = randomUUID();
    fs.mkdirSync(dir);
    const marker = path.join(dir, `${generation}.jsonl`);
    const records = [
      { version: 1, event: "pending", generation, ownerPid: process.pid, ownerIdentity },
      { version: 1, event: "released", generation, proof: "ready" },
      { version: 1, event: "confirmed", generation, proof: "ready" }
    ];
    fs.writeFileSync(marker, records.map(record => `${JSON.stringify(record)}\n`).join(""));
    const alias = path.join(f.root, "data-alias"), previous = process.env.CLAUDE_PLUGIN_DATA;
    fs.symlinkSync(f.data, alias, "dir");
    process.env.CLAUDE_PLUGIN_DATA = alias;
    try {
      let client, error;
      try { client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }); }
      catch (caught) { error = caught; }
      if (client) await client.close();
      assert.equal(fs.existsSync(f.log), !foreign);
      if (foreign) assert.ok(error, "foreign physical identity must be refused");
      else assert.equal(error, undefined, error?.message);
    } finally { process.env.CLAUDE_PLUGIN_DATA = previous; }
  });
}
