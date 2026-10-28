import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { createLinuxEpochRecovery } from "../plugins/grok/scripts/lib/linux-epoch-recovery.mjs";
import { finishDirectStart } from "../plugins/grok/scripts/lib/direct-start-admission.mjs";
import { ensureBrokerSession, reserveDirectAdmission, saveBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

const linux = process.platform === "linux";
const posix = linux || process.platform === "darwin";

function fixture(t) {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "grok-epoch-e2e-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
  const fake = path.join(root, "fake-grok"), log = path.join(root, "agent-started");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_AGENT_LOG, 'started');
let gate, heldInitialize;
if (process.env.FAKE_AGENT_GATE) {
  gate = require('node:net').createConnection(process.env.FAKE_AGENT_GATE);
  gate.on('data', () => { if (heldInitialize) { console.log(JSON.stringify(heldInitialize)); heldInitialize = null; } gate.destroy(); });
}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') {
    const result={jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}};
    if (gate) { heldInitialize=result; gate.write('initialize\n'); } else console.log(JSON.stringify(result));
  }
  if(m.method==='session/prompt') {
    fs.appendFileSync(process.env.FAKE_AGENT_LOG+'.events', 'prompt\n');
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));
  }
});
`, { mode: 0o755 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "FAKE_AGENT_LOG", "FAKE_AGENT_GATE", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "GROK_COMPANION_ACP_ENDPOINT"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_AGENT_LOG: log, HOME: root, USERPROFILE: root, TMPDIR: temp, TEMP: temp, TMP: temp });
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  delete process.env.FAKE_AGENT_GATE;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  t.diagnostic(`Isolated fixture retained: ${root}`);
  let sentinelStopped = false;
  let sentinelStopPermitted = true;
  const stopSentinel = () => {
    if (!sentinelStopPermitted) throw new Error(`Owned process termination is unconfirmed; fixture retained: ${root}`);
    if (!sentinelStopped && linux) {
      shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state });
    }
    sentinelStopped = true;
  };
  t.after(() => {
    try { stopSentinel(); }
    finally { for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });
  return { cwd, state, log, fake, stopSentinel, retainSentinel: () => { sentinelStopPermitted = false; },
    allowSentinelStop: () => { sentinelStopPermitted = true; } };
}

for (const [name, put] of [
  ["legacy root corrupt broker", state => fs.writeFileSync(path.join(state, "broker.json"), "{")],
  ["other epoch pending broker", state => {
    const dir = path.join(state, "broker-v3", randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broker-admission.jsonl"), '{"event":"pending"}\n');
  }],
  ["other epoch unknown direct marker", state => {
    const dir = path.join(state, "direct-start-v2", randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "unknown"), "unknown");
  }],
  ["current epoch unknown broker entry", state => {
    const protocol = JSON.parse(fs.readFileSync(path.join(state, "state.lock", "protocol.json"), "utf8"));
    const dir = path.join(state, "broker-v3", protocol.epoch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "unknown"), "unknown");
  }],
  ["current epoch corrupt broker session", state => {
    const protocol = JSON.parse(fs.readFileSync(path.join(state, "state.lock", "protocol.json"), "utf8"));
    const dir = path.join(state, "broker-v3", protocol.epoch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broker.json"), "{");
  }]
]) {
  test(`direct user path blocks ${name}`, { skip: !linux }, async t => {
    const f = fixture(t);
    put(f.state);
    let client;
    try {
      await assert.rejects(async () => { client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }); }, /admission|recovery|legacy|epoch/i);
      assert.equal(fs.existsSync(f.log), false, "old inventory must be checked before starting an agent");
    } finally { if (client) await client.close(); }
  });
}

test("a direct reservation cannot be released with a different epoch", { skip: !linux }, t => {
  const f = fixture(t);
  const token = reserveDirectAdmission(f.cwd);
  assert.throws(() => finishDirectStart(f.cwd, { ...token, epoch: randomUUID() }, "never-started"), /epoch|identity/i);
  assert.equal(finishDirectStart(f.cwd, token, "never-started"), true);
});

test("an explicit known legacy managed endpoint is rejected before connecting", { skip: !linux }, async t => {
  const f = fixture(t), socketPath = path.join(path.dirname(f.cwd), "legacy.sock");
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const endpoint = `unix:${socketPath}`;
  const oldDir = path.join(f.state, "broker-v2");
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, "broker.json"), JSON.stringify({ endpoint, generation: "old", pid: process.pid }));
  try {
    await assert.rejects(GrokAcpClient.connect(f.cwd, { brokerEndpoint: endpoint, brokerOnly: true }), /legacy|recovery|epoch/i);
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("an established managed connection stops forwarding after sentinel loss", { skip: !linux, timeout: 30000 }, async t => {
  const f = fixture(t);
  let child, client;
  try {
    const session = await ensureBrokerSession(f.cwd, { timeoutMs: 15000, onBrokerSpawn: value => { child = value; child.ref(); } });
    assert.ok(session);
    client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: session.endpoint, brokerOnly: true });
    const result = await client.request("session/prompt", { sessionId: "test", prompt: [] });
    assert.equal(result.stopReason, "end_turn");
    f.stopSentinel();
    await assert.rejects(client.request("session/prompt", { sessionId: "test", prompt: [] }), /epoch|state|broker/i);
    assert.equal(fs.readFileSync(f.log + ".events", "utf8"), "prompt\n");
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
});

test("broker startup remains unconfirmed when the sentinel disappears while initialization is pending", { skip: !linux, timeout: 30000 }, async t => {
  const f = fixture(t), gatePath = path.join(path.dirname(f.cwd), "gate.sock");
  const epoch = JSON.parse(fs.readFileSync(path.join(f.state, "state.lock", "protocol.json"), "utf8")).epoch;
  let releaseGate;
  const entered = new Promise(resolve => { releaseGate = resolve; });
  const server = net.createServer(socket => { socket.once("data", () => releaseGate(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(gatePath, resolve); });
  process.env.FAKE_AGENT_GATE = gatePath;
  let child, socket;
  try {
    const starting = ensureBrokerSession(f.cwd, { timeoutMs: 12000, onBrokerSpawn: value => { child = value; child.ref(); } });
    starting.catch(() => {});
    socket = await Promise.race([entered, starting.then(() => { throw new Error("broker became ready before the initialization gate"); }, error => { throw error; })]);
    f.stopSentinel();
    socket.end("release\n");
    await assert.rejects(starting, /epoch|sentinel|state|unconfirmed|stopped/i);
    const journal = fs.readFileSync(path.join(f.state, "broker-v3", epoch, "broker-admission.jsonl"), "utf8");
    assert.match(journal, /"event":"pending"/);
    assert.doesNotMatch(journal, /"event":"confirmed"/);
  } finally {
    socket?.destroy();
    await new Promise(resolve => server.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
});

for (const component of ["namespace", "epoch"]) {
  test(`broker save refuses a symlinked ${component} directory`, { skip: !linux }, t => {
    const f = fixture(t), epoch = JSON.parse(fs.readFileSync(path.join(f.state, "state.lock", "protocol.json"), "utf8")).epoch;
    const target = path.join(path.dirname(f.cwd), "foreign"), root = path.join(f.state, "broker-v3");
    fs.mkdirSync(target);
    if (component === "namespace") fs.symlinkSync(target, root, "dir");
    else { fs.mkdirSync(root); fs.symlinkSync(target, path.join(root, epoch), "dir"); }
    assert.throws(() => saveBrokerSession(f.cwd, { epoch, generation: "test", endpoint: "unix:/invalid", pid: process.pid }), /directory|symlink|invalid/i);
    assert.deepEqual(fs.readdirSync(target), []);
  });
}

function oldPending(f) {
  const dir = path.join(f.state, "direct-start-v1"), file = path.join(dir, `${randomUUID()}.jsonl`);
  fs.mkdirSync(dir);
  const bytes = Buffer.from('{"version":1,"event":"pending","owner":"unconfirmed"}\n');
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

function confirmOldInventory(f) {
  withStateSnapshot(f.cwd, (_state, context) => createLinuxEpochRecovery(context, {
    offlineConfirmed: true, localOnly: true, allOldProcessesStopped: true, expectedStateDir: f.state
  }), { strictWorkspace: true, timeoutMs: 15000 });
}

test("explicit recovery permits direct startup while preserving old pending and rejects changed inventory", { skip: !linux, timeout: 45000 }, async t => {
  const f = fixture(t), old = oldPending(f);
  await assert.rejects(GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }), /recovery|legacy/i);
  assert.equal(fs.existsSync(f.log), false);
  confirmOldInventory(f);
  const client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake });
  try {
    assert.equal((await client.request("session/prompt", { sessionId: "new", prompt: [] })).stopReason, "end_turn");
  } finally { await client.close(); }
  assert.deepEqual(fs.readFileSync(old.file), old.bytes);
  fs.appendFileSync(old.file, '{"event":"late"}\n');
  await assert.rejects(GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake }), /recovery|inventory/i);
});

test("explicit recovery permits managed broker startup and rechecks old inventory on an established connection", { skip: !linux, timeout: 60000 }, async t => {
  const f = fixture(t), old = oldPending(f);
  await assert.rejects(ensureBrokerSession(f.cwd, { timeoutMs: 15000 }), /recovery|legacy/i);
  assert.equal(fs.existsSync(f.log), false);
  confirmOldInventory(f);
  let child, client;
  try {
    const session = await ensureBrokerSession(f.cwd, { timeoutMs: 30000, onBrokerSpawn: value => { child = value; child.ref(); } });
    assert.ok(session);
    client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: session.endpoint, brokerOnly: true });
    assert.equal((await client.request("session/prompt", { sessionId: "new", prompt: [] })).stopReason, "end_turn");
    assert.deepEqual(fs.readFileSync(old.file), old.bytes);
    fs.appendFileSync(old.file, '{"event":"late"}\n');
    await assert.rejects(client.request("session/prompt", { sessionId: "new", prompt: [] }), /recovery|inventory|epoch|state|broker/i);
    assert.equal(fs.readFileSync(f.log + ".events", "utf8"), "prompt\n");
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
});

test("replacing the current direct epoch directory cannot hide an admitted pending owner from broker startup", { skip: !linux, timeout: 45000 }, async t => {
  const f = fixture(t);
  const epoch = JSON.parse(fs.readFileSync(path.join(f.state, "state.lock", "protocol.json"), "utf8")).epoch;
  const token = reserveDirectAdmission(f.cwd);
  const current = path.join(f.state, "direct-start-v2", epoch);
  const saved = path.join(path.dirname(f.cwd), "preserved-direct-epoch");
  const markerName = `${token.generation}.jsonl`;
  const original = fs.readFileSync(path.join(current, markerName));
  assert.match(original.toString("utf8"), /"event":"pending"/);
  fs.renameSync(current, saved);
  fs.mkdirSync(current);
  let child, failure;
  try {
    try {
      await ensureBrokerSession(f.cwd, { timeoutMs: 15000, onBrokerSpawn: value => { child = value; child.ref(); } });
    } catch (error) { failure = error; }
    assert.deepEqual(fs.readFileSync(path.join(saved, markerName)), original, "the original pending marker must remain unchanged");
    assert.ok(failure, "broker startup must reject an exchanged current direct epoch directory");
    assert.match(failure.message, /epoch|directory|identity|recovery|admission/i);
    assert.equal(child, undefined, "broker spawn must not occur after the directory exchange");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
});

test("replacing the current broker epoch directory cannot hide a pending broker from direct startup", { skip: !linux, timeout: 45000 }, async t => {
  const f = fixture(t), gatePath = path.join(path.dirname(f.cwd), "broker-directory-gate.sock");
  const directLog = path.join(path.dirname(f.cwd), "unexpected-direct-started");
  const directOptions = { disableBroker: true, grokBin: f.fake, env: { ...process.env, FAKE_AGENT_LOG: directLog } };
  const epoch = JSON.parse(fs.readFileSync(path.join(f.state, "state.lock", "protocol.json"), "utf8")).epoch;
  let enterGate;
  const entered = new Promise(resolve => { enterGate = resolve; });
  const server = net.createServer(socket => { socket.once("data", () => enterGate(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(gatePath, resolve); });
  let child, socket, client, starting;
  try {
    starting = ensureBrokerSession(f.cwd, { timeoutMs: 20000, env: { ...process.env, FAKE_AGENT_GATE: gatePath },
      onBrokerSpawn: value => { child = value; child.ref(); } });
    starting.catch(() => {});
    socket = await Promise.race([entered, starting.then(() => { throw new Error("broker became ready before the initialization gate"); }, error => { throw error; })]);
    const current = path.join(f.state, "broker-v3", epoch);
    const saved = path.join(path.dirname(f.cwd), "preserved-broker-epoch");
    const journalName = "broker-admission.jsonl";
    const original = fs.readFileSync(path.join(current, journalName));
    assert.match(original.toString("utf8"), /"event":"pending"/);
    await assert.rejects(GrokAcpClient.connect(f.cwd, directOptions), /pending|admission/i);
    assert.equal(fs.existsSync(directLog), false, "pending broker must block direct agent spawn before the exchange");
    fs.renameSync(current, saved);
    fs.mkdirSync(current);
    let failure;
    try { client = await GrokAcpClient.connect(f.cwd, directOptions); }
    catch (error) { failure = error; }
    assert.deepEqual(fs.readFileSync(path.join(saved, journalName)), original, "the original pending journal must remain unchanged");
    assert.ok(failure, "direct startup must reject an exchanged current broker epoch directory");
    assert.match(failure.message, /epoch|directory|identity|recovery|admission/i);
    assert.equal(fs.existsSync(directLog), false, "direct agent spawn must not occur after the directory exchange");
  } finally {
    if (client) await client.close();
    socket?.destroy();
    await new Promise(resolve => server.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    if (starting) await starting.catch(() => {});
  }
});

const directSwapPreload = String.raw`
const fs=require('node:fs');
const originalOpen=fs.openSync, originalClose=fs.closeSync;
Error.stackTraceLimit=50;
let entered=false;
const lockHandles=new Set();
function wait(gate, message) {
  fs.writeSync(1, message+'\n');
  const fd=originalOpen.call(fs,gate,'r');
  try { fs.readSync(fd,Buffer.alloc(1),0,1,null); } finally { fs.closeSync(fd); }
}
fs.closeSync=function(fd) {
  const stack=new Error().stack;
  const gate=!entered && process.env.TEST_GATE_ROLE==='direct' && lockHandles.has(fd) &&
    stack.includes('withPosixStateLock') && stack.includes('reserveDirectStart');
  lockHandles.delete(fd);
  const value=originalClose.call(this,fd);
  if(gate) { entered=true; wait(process.env.TEST_GATE,'DIRECT_RESERVATION_PAUSED'); }
  return value;
};
fs.openSync=function(file,flags,...args) {
  if (!entered && process.env.TEST_GATE_ROLE==='broker' && String(file).endsWith('/broker.log') &&
      new Error().stack.includes('spawnBrokerProcessWithin')) {
    entered=true; wait(process.env.TEST_GATE,'BROKER_PENDING_PAUSED');
    throw Object.assign(new Error('isolated fixture rejected broker spawn'),{code:'EIO'});
  }
  const fd=originalOpen.call(this,file,flags,...args);
  if(process.env.TEST_GATE_ROLE==='direct' && String(file)===process.env.TEST_NATIVE_LOCK) lockHandles.add(fd);
  return fd;
};
require('node:module').syncBuiltinESMExports();
`;

function gatedWorker(f, preload, role, gate, source) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: f.cwd, env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_GATE_ROLE: role,
      TEST_GATE: gate, TEST_NATIVE_LOCK: path.join(f.state, "state.lock", "native.lock"), TEST_FAKE: f.fake }, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { child, closed, output: () => stdout, error: () => stderr };
}

async function waitForOutput(worker, text, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!worker.output().includes(text)) {
    if (worker.child.exitCode !== null || worker.child.signalCode || Date.now() >= deadline) {
      throw new Error(`Worker did not reach ${text}: ${worker.output()} ${worker.error()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function releaseGate(gate) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const fd = fs.openSync(gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); }
      return;
    } catch (error) {
      if (error?.code !== "ENXIO" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

for (const variant of ["missing", "confirmed replacement", "identical replacement"]) {
  test(`direct startup rejects ${variant} of its reserved marker before spawn`, { skip: !posix, timeout: 45000 }, async t => {
    const f = fixture(t), base = path.dirname(f.cwd), preload = path.join(base, "reservation-gates.cjs");
    const directGate = path.join(base, "direct-gate.fifo"), brokerGate = path.join(base, "broker-gate.fifo");
    fs.writeFileSync(preload, directSwapPreload);
    const made = spawnSync("mkfifo", [directGate, brokerGate], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const acp = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
    const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
    const directSource = `import {GrokAcpClient} from ${JSON.stringify(acp)};
      let closeOwned,client,outcome='accepted',detail='';
      try { client=await GrokAcpClient.connect(process.cwd(),{disableBroker:true,grokBin:process.env.TEST_FAKE,
        directAgentStarting:({close})=>{closeOwned=close;return null;}}); }
      catch(e) { outcome='rejected'; detail=e.message; }
      finally { if(client) await client.close(); const proof=closeOwned?await closeOwned():false;
        console.log('DIRECT_RESULT '+JSON.stringify({outcome,detail,proof})); }`;
    const brokerSource = `import {ensureBrokerSession} from ${JSON.stringify(lifecycle)};
      try { await ensureBrokerSession(process.cwd(),{timeoutMs:7500,onBrokerSpawn:()=>console.log('BROKER_SPAWNED')}); console.log('BROKER_ACCEPTED'); }
      catch(e) { console.log('BROKER_REJECTED '+e.message); }`;
    f.retainSentinel();
    const direct = gatedWorker(f, preload, "direct", directGate, directSource);
    let broker, directReady = false, brokerReady = false, directReleased = false, brokerReleased = false;
    let directCode, brokerCode, stopProof = false;
    try {
      await waitForOutput(direct, "DIRECT_RESERVATION_PAUSED");
      directReady = true;
      const markerDir = linux ? path.join(f.state, "direct-start-v2", JSON.parse(fs.readFileSync(path.join(f.state, "state.lock", "protocol.json"), "utf8")).epoch)
        : path.join(f.state, "direct-start-v1");
      const names = fs.readdirSync(markerDir).filter(name => name.endsWith(".jsonl"));
      assert.equal(names.length, 1);
      const marker = path.join(markerDir, names[0]), preserved = path.join(base, "preserved-direct-marker");
      const original = fs.readFileSync(marker), pending = JSON.parse(original.toString("utf8"));
      fs.renameSync(marker, preserved);
      if (variant === "identical replacement") fs.writeFileSync(marker, original);
      if (variant === "confirmed replacement") {
        const released = { version: 1, event: "released", generation: pending.generation, proof: "never-started" };
        const confirmed = { ...released, event: "confirmed" };
        fs.writeFileSync(marker, Buffer.concat([original, Buffer.from(`${JSON.stringify(released)}\n${JSON.stringify(confirmed)}\n`)]));
      }
      broker = gatedWorker(f, preload, "broker", brokerGate, brokerSource);
      if (variant === "identical replacement") {
        brokerCode = await broker.closed;
        assert.match(broker.output(), /BROKER_REJECTED/);
        assert.doesNotMatch(broker.output(), /BROKER_PENDING_PAUSED|BROKER_SPAWNED/);
      } else {
        await waitForOutput(broker, "BROKER_PENDING_PAUSED");
        brokerReady = true;
        await releaseGate(brokerGate); brokerReleased = true;
        brokerCode = await broker.closed;
        assert.match(broker.output(), /BROKER_REJECTED/);
        assert.doesNotMatch(broker.output(), /BROKER_SPAWNED/);
      }
      assert.equal(brokerCode, 0, broker.error());
      assert.deepEqual(fs.readFileSync(preserved), original);
      await releaseGate(directGate); directReleased = true;
      directCode = await direct.closed;
      const match = direct.output().match(/DIRECT_RESULT (\{[^\n]+\})/);
      assert.ok(match, `direct worker returned no proof: ${direct.output()} ${direct.error()}`);
      const result = JSON.parse(match[1]);
      stopProof = ["never-started", "posix-group-empty"].includes(result.proof);
      assert.equal(directCode, 0, direct.error());
      assert.equal(result.outcome, "rejected", result.detail);
      assert.match(result.detail, /identity|owner|reservation|marker|generation/i);
      assert.doesNotMatch(result.detail, /timed out|deadline/i);
      assert.equal(fs.existsSync(f.log), false, "the direct agent must not spawn after the reservation changed");
    } finally {
      if (brokerReady && !brokerReleased) await releaseGate(brokerGate).catch(() => {});
      if (directReady && !directReleased) await releaseGate(directGate).catch(() => {});
      if (broker && brokerCode === undefined) {
        broker.child.kill("SIGKILL");
        brokerCode = await broker.closed;
      }
      if (directCode === undefined) {
        direct.child.kill("SIGKILL");
        directCode = await direct.closed;
      }
      const match = direct.output().match(/DIRECT_RESULT (\{[^\n]+\})/);
      if (match) stopProof = ["never-started", "posix-group-empty"].includes(JSON.parse(match[1]).proof);
      if (stopProof && (!broker || !broker.output().includes("BROKER_SPAWNED"))) f.allowSentinelStop();
    }
  });
}
