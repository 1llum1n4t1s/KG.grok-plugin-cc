import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { resolveStateDir, migrateStateLock } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { ensureBrokerSession, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";

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
fs.writeFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({pid:process.pid,claudeData:process.env.CLAUDE_PLUGIN_DATA,pluginData:process.env.PLUGIN_DATA,
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
  if(m.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'fake-session',modes:null}}));
  if(m.method==='session/prompt') {
    fs.appendFileSync(process.env.FAKE_AGENT_LOG + '.events', JSON.stringify({method:m.method,params:m.params})+'\n');
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));
  }
  if(m.method==='session/cancel' && m.id!==undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
});
`, { mode: 0o755 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "FAKE_AGENT_LOG", "GROK_COMPANION_ACP_ENDPOINT", "XAI_API_KEY", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_AGENT_LOG: log, HOME: root, USERPROFILE: root, TMPDIR: temp, TEMP: temp, TMP: temp });
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  delete process.env.XAI_API_KEY;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  const epoch = process.platform === "linux" ? JSON.parse(fs.readFileSync(path.join(state, "state.lock", "protocol.json"), "utf8")).epoch : undefined;
  const broker = resolveBrokerStateDir(cwd);
  fs.mkdirSync(broker, { recursive: true });
  const journal = path.join(broker, "broker-admission.jsonl");
  const pending = JSON.stringify({ version: 2, event: "pending", generation: "isolated-pending", ownerPid: process.pid,
    platform: process.platform, lockToken: "isolated-owner", endpoint: "unix:/isolated/pending.sock", sessionDir: root,
    pidFile: path.join(root, "pending.pid"), logFile: path.join(root, "pending.log"), ...(epoch ? { epoch } : {}) }) + "\n";
  t.diagnostic(`Isolated fixture: ${root}`);
  const f = { root, cwd, data, fake, log, broker, journal, pending, retain: false, offlineConfirmed: false };
  t.after(() => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    assert.equal(path.dirname(root), parent);
    if (process.platform === "linux") {
      assert.ok(!f.retain && f.offlineConfirmed, `owned process exit unconfirmed; fixture retained: ${root}`);
      assert.equal(shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state }).stopped, true);
    }
    if (!f.retain) fs.rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Retained fixture pending process cleanup: ${root}`);
  });
  return f;
}

test("explicit managed endpoint cannot prompt before its ready admission is confirmed", { skip: !posix }, async t => {
  const f = fixture(t), fifo = path.join(f.root, "confirm.fifo"), entered = path.join(f.root, "confirm-entered");
  const preload = path.join(f.root, "confirm-gate.cjs");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  fs.writeFileSync(preload, `const fs=require('node:fs'), original=fs.writeSync;
    fs.writeSync=function(fd,buffer,...args) {
      if (Buffer.isBuffer(buffer) && buffer.toString().includes('"event":"confirmed"') && !fs.existsSync(process.env.CONFIRM_GATE_ENTERED)) {
        fs.writeFileSync(process.env.CONFIRM_GATE_ENTERED,'entered');
        const gate=fs.openSync(process.env.CONFIRM_GATE_FIFO,'r'), byte=Buffer.alloc(1);
        fs.readSync(gate,byte,0,1,null); fs.closeSync(gate);
      }
      return original.call(this,fd,buffer,...args);
    }; require('node:module').syncBuiltinESMExports();`);
  const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const source = `import {ensureBrokerSession,cleanupIdleBrokerSession} from ${JSON.stringify(lifecycle)};
    let session; try {
      session=await ensureBrokerSession(${JSON.stringify(f.cwd)}, {timeoutMs:30000});
      console.log(JSON.stringify({ready:!!session}));
      await new Promise(resolve=>process.stdin.once('data',resolve));
      let cleaned=false;
      for(let attempt=0;attempt<20&&!cleaned;attempt++) {
        cleaned=await cleanupIdleBrokerSession(${JSON.stringify(f.cwd)},session,{timeoutMs:5000});
        if(!cleaned) await new Promise(resolve=>setTimeout(resolve,50));
      }
      console.log(JSON.stringify({cleaned}));
    } catch(e) { console.error(e.stack); process.exitCode=1; }`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, CONFIRM_GATE_FIFO: fifo, CONFIRM_GATE_ENTERED: entered },
    stdio: ["pipe", "pipe", "pipe"] });
  owner.stdin.on("error", () => {});
  let stdout = "", stderr = "", released = false, ownerClosed = false;
  owner.stdout.on("data", chunk => { stdout += chunk; });
  owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.once("close", code => { ownerClosed = true; resolve(code); }));
  const waitFor = async (predicate, message, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (ownerClosed || Date.now() >= deadline) throw new Error(`${message}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const prompt = async options => {
    let client;
    try {
      client = await GrokAcpClient.connect(f.cwd, { ...options, brokerOnly: true, rpcTimeoutMs: 1000, brokerDeadlineMs: Date.now() + 1500 });
      const { sessionId } = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
      const result = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "probe" }] }, { signal: AbortSignal.timeout(1500) });
      await client.request("session/cancel", { sessionId });
      return { result };
    } catch (error) { return { error: error.message }; }
    finally { if (client) await client.close(); }
  };
  let beforeOptions, beforeEnv, after;
  try {
    await waitFor(() => fs.existsSync(entered), "Parent did not reach the confirmed-record gate");
    const records = fs.readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map(record => record.event), ["pending", "spawned", "settled"]);
    assert.equal(records[2].outcome, "ready");
    const endpoint = records[0].endpoint;
    assert.equal(endpoint, createBrokerEndpoint(records[0].sessionDir));
    t.diagnostic(`Managed endpoint: ${endpoint}`);
    const cancellation = { generation: records[0].generation, sessionId: "unstarted-session", executionId: "unstarted-execution" };
    const cancelClient = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: endpoint, brokerOnly: true,
      cancellationOnly: true, cancellationGeneration: cancellation.generation,
      cancellationSessionId: cancellation.sessionId, cancellationExecutionId: cancellation.executionId, rpcTimeoutMs: 1000 });
    try {
      const result = await cancelClient.request("broker/cancelTurn", cancellation);
      assert.equal(result.reservationAccepted, true);
      assert.equal(result.executionState, "never-accepted");
    } finally { await cancelClient.close(); }
    beforeOptions = await prompt({ brokerEndpoint: endpoint });
    beforeEnv = await prompt({ env: { ...process.env, GROK_COMPANION_ACP_ENDPOINT: endpoint } });
    const earlyEvents = fs.existsSync(`${f.log}.events`) ? fs.readFileSync(`${f.log}.events`, "utf8").trim().split("\n").filter(Boolean) : [];
    const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); }
    released = true;
    await waitFor(() => stdout.includes('"ready":true'), "Owner did not confirm readiness");
    after = await prompt({ brokerEndpoint: endpoint });
    assert.equal(after.result?.stopReason, "end_turn", JSON.stringify(after));
    assert.equal(earlyEvents.length, 0, `Unconfirmed broker delivered ${earlyEvents.length} prompt(s) to its agent`);
    assert.ok(beforeOptions.error, "brokerEndpoint must reject unconfirmed managed broker");
    assert.ok(beforeEnv.error, "environment endpoint must reject unconfirmed managed broker");
  } finally {
    if (!released && !ownerClosed && fs.existsSync(entered)) {
      const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); }
      released = true;
    }
    if (released && !ownerClosed) owner.stdin.end("cleanup\n");
    let timer;
    const code = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000); })]);
    clearTimeout(timer);
    if (code === null || code !== 0 || !stdout.includes('"cleaned":true')) {
      f.retain = true;
      if (!ownerClosed) owner.kill("SIGKILL");
      await closed;
      throw new Error(`Owned broker cleanup was not confirmed; fixture retained: ${f.root}; ${stdout} ${stderr}`);
    }
  }
});

for (const method of ["broker/shutdown", "broker/shutdownIfIdle"]) {
  test(`${method} is refused until broker readiness is confirmed`, { skip: !posix }, async t => {
    const f = fixture(t), fifo = path.join(f.root, "shutdown.fifo"), entered = path.join(f.root, "shutdown-entered");
    const preload = path.join(f.root, "shutdown-gate.cjs");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    fs.writeFileSync(preload, `const fs=require('node:fs'), original=fs.writeSync;
      fs.writeSync=function(fd,buffer,...args) {
        if (Buffer.isBuffer(buffer) && buffer.toString().includes('"event":"confirmed"') && !fs.existsSync(process.env.CONFIRM_GATE_ENTERED)) {
          fs.writeFileSync(process.env.CONFIRM_GATE_ENTERED,'entered');
          const gate=fs.openSync(process.env.CONFIRM_GATE_FIFO,'r'), byte=Buffer.alloc(1);
          fs.readSync(gate,byte,0,1,null); fs.closeSync(gate);
        }
        return original.call(this,fd,buffer,...args);
      }; require('node:module').syncBuiltinESMExports();`);
    const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
    const source = `import {ensureBrokerSession,cleanupIdleBrokerSession} from ${JSON.stringify(lifecycle)};
      try { const session=await ensureBrokerSession(${JSON.stringify(f.cwd)}, {timeoutMs:30000});
        console.log(JSON.stringify({ready:!!session}));
        await new Promise(resolve=>process.stdin.once('data',resolve));
        console.log(JSON.stringify({cleaned:await cleanupIdleBrokerSession(${JSON.stringify(f.cwd)},session,{timeoutMs:5000})}));
      } catch(e) { console.log(JSON.stringify({error:e.message})); }`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, CONFIRM_GATE_FIFO: fifo, CONFIRM_GATE_ENTERED: entered },
      stdio: ["pipe", "pipe", "pipe"] });
    owner.stdin.on("error", () => {});
    let stdout = "", stderr = "", ownerClosed = false, released = false, brokerPid, agentPid, response, aliveBeforeRelease;
    owner.stdout.on("data", chunk => { stdout += chunk; });
    owner.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => owner.once("close", code => { ownerClosed = true; resolve(code); }));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    const waitFor = async (predicate, message, timeout = 8000) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (ownerClosed || Date.now() >= deadline) throw new Error(`${message}: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => fs.existsSync(entered), "Parent did not reach shutdown gate");
      const records = fs.readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual(records.map(record => record.event), ["pending", "spawned", "settled"]);
      assert.equal(records[2].outcome, "ready");
      const session = JSON.parse(fs.readFileSync(path.join(f.broker, "broker.json"), "utf8"));
      assert.equal(session.generation, records[0].generation);
      assert.equal(session.pid, records[1].pid);
      assert.equal(session.endpoint, records[0].endpoint);
      assert.equal(session.endpoint, createBrokerEndpoint(session.sessionDir));
      t.diagnostic(`Managed endpoint: ${session.endpoint}`);
      brokerPid = session.pid;
      agentPid = JSON.parse(fs.readFileSync(f.log, "utf8")).pid;
      response = await new Promise((resolve, reject) => {
        const socket = net.createConnection(session.endpoint.slice("unix:".length));
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Shutdown acknowledgement timed out")); }, 3000);
        let buffer = "";
        socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { generation: session.generation } })}\n`));
        socket.on("data", chunk => {
          buffer += chunk;
          if (buffer.includes("\n")) { clearTimeout(timer); socket.end(); resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
        });
        socket.once("error", error => { clearTimeout(timer); reject(error); });
      });
      aliveBeforeRelease = alive(brokerPid) && alive(agentPid);
    } finally {
      if (!released && !ownerClosed && fs.existsSync(entered)) {
        const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); }
        released = true;
      }
      if (released && !ownerClosed) owner.stdin.end("cleanup\n");
      let timer;
      const code = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000); })]);
      clearTimeout(timer);
      if (code === null) { f.retain = true; if (!ownerClosed) owner.kill("SIGKILL"); await closed; throw new Error(`Owner did not exit; fixture retained: ${f.root}; ${stdout} ${stderr}`); }
      for (const pid of [brokerPid, agentPid].filter(Boolean)) {
        if (alive(pid)) { f.retain = true; throw new Error(`Owned process ${pid} is still running; fixture retained: ${f.root}`); }
      }
    }
    assert.ok(response?.error, `${method} unexpectedly accepted before confirmation: ${JSON.stringify(response)}`);
    assert.equal(aliveBeforeRelease, true, "shutdown stopped an unconfirmed broker or its agent");
    assert.ok(stdout.includes('"ready":true'), `Owner did not confirm broker readiness: ${stdout} ${stderr}`);
    assert.ok(stdout.includes('"cleaned":true'), `Confirmed broker cleanup did not succeed: ${stdout} ${stderr}`);
  });
}

for (const phase of ["before-fstat", "during-read"]) {
test(`broker state marker growth ${phase} is bounded and fails closed`, { skip: !posix }, async t => {
  const f = fixture(t), preload = path.join(f.root, "marker-growth.cjs"), observed = path.join(f.root, "marker-observed"), after = path.join(f.root, "marker-after");
  const marker = path.join(resolveStateDir(f.cwd), "state.lock", "protocol.json");
  fs.writeFileSync(preload, `const fs=require('node:fs'), open=fs.openSync, close=fs.closeSync, read=fs.readSync, readFile=fs.readFileSync, fstat=fs.fstatSync;
    const descriptors=new Map(); let injected=false;
    fs.openSync=function(name,...args) { const fd=open.call(this,name,...args); if(String(name)===process.env.MARKER_PATH) descriptors.set(fd,true); else descriptors.delete(fd); return fd; };
    fs.closeSync=function(fd) { descriptors.delete(fd); return close.call(this,fd); };
    function inject(fd,method,length) {
      if (!injected && descriptors.has(fd) && process.env.GROK_COMPANION_BROKER_GENERATION && new Error().stack.includes('captureBrokerStateBaseline')) {
        injected=true; fs.appendFileSync(process.env.MARKER_PATH,Buffer.alloc(65537,120));
        fs.writeFileSync(process.env.MARKER_OBSERVED,JSON.stringify({method,length})); return true;
      } return false;
    }
    fs.fstatSync=function(fd,...args) { if(process.env.MARKER_PHASE==='before-fstat') inject(fd,'fstatSync',null); return fstat.call(this,fd,...args); };
    fs.readSync=function(fd,buffer,...args) { if(process.env.MARKER_PHASE==='during-read') inject(fd,'readSync',buffer.length);
      if(injected && descriptors.has(fd) && new Error().stack.includes('captureBrokerStateBaseline')) fs.writeFileSync(process.env.MARKER_AFTER,'read');
      return read.call(this,fd,buffer,...args); };
    fs.readFileSync=function(fd,...args) { if(process.env.MARKER_PHASE==='during-read' && inject(fd,'readFileSync',null)) throw new Error('Unbounded marker read rejected by fixture'); return readFile.call(this,fd,...args); };
    require('node:module').syncBuiltinESMExports();`);
  const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const source = `import {ensureBrokerSession} from ${JSON.stringify(lifecycle)};
    let child; try { const session=await ensureBrokerSession(${JSON.stringify(f.cwd)}, {timeoutMs:8000,onBrokerSpawn:c=>{child=c;}});
      console.log(JSON.stringify({started:!!session,pid:child?.pid}));
    } catch(e) { console.log(JSON.stringify({error:e.message,pid:child?.pid})); }
    if(child && child.exitCode===null && child.signalCode===null) { child.kill(); await new Promise(resolve=>child.once('exit',resolve)); }`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, MARKER_PATH: marker, MARKER_OBSERVED: observed, MARKER_AFTER: after, MARKER_PHASE: phase }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise(resolve => owner.once("close", resolve));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  if (result.pid) {
    try { process.kill(result.pid, 0); f.retain = true; throw new Error(`Owned broker is still running: ${result.pid}`); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  assert.ok(fs.existsSync(observed), `Marker growth was not injected: ${stdout} ${stderr}`);
  const read = JSON.parse(fs.readFileSync(observed, "utf8"));
  if (phase === "before-fstat") {
    assert.equal(read.method, "fstatSync");
    assert.equal(fs.existsSync(after), false, "grown marker must be rejected before allocation and reading");
  } else {
    assert.equal(read.method, "readSync", "marker descriptor must not be read without a bound");
    assert.ok(read.length <= 65537, `Marker read buffer exceeds bound: ${read.length}`);
  }
  assert.notEqual(result.started, true, "broker started despite marker growth");
  assert.equal(fs.existsSync(f.log), false, "agent started after marker growth");
});
}

for (const action of ["cancel", "disconnect"]) {
  test(`${action} while confirmed journal read is delayed prevents prompt forwarding`, { skip: !posix }, async t => {
    const f = fixture(t), fifo = path.join(f.root, "read.fifo"), entered = path.join(f.root, "read-entered");
    const trigger = path.join(f.root, "read-trigger"), preload = path.join(f.root, "read-gate.cjs");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    fs.writeFileSync(preload, `const fs=require('node:fs'), open=fs.promises.open.bind(fs.promises); let entered=false;
      fs.promises.open=async function(name,...args) {
        if (!entered && process.env.GROK_COMPANION_BROKER_GENERATION && String(name).endsWith('broker-admission.jsonl') && fs.existsSync(process.env.READ_TRIGGER)) {
          entered=true; fs.writeFileSync(process.env.READ_ENTERED,'entered');
          const gate=await open(process.env.READ_FIFO,'r'); try { await gate.read(Buffer.alloc(1),0,1,null); } finally { await gate.close(); }
        }
        return open(name,...args);
      };`);
    const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
    const source = `import {ensureBrokerSession,cleanupIdleBrokerSession} from ${JSON.stringify(lifecycle)};
      try { const session=await ensureBrokerSession(${JSON.stringify(f.cwd)}, {timeoutMs:30000});
        console.log(JSON.stringify({session})); await new Promise(resolve=>process.stdin.once('data',resolve));
        let cleaned=false; for(let i=0;i<20&&!cleaned;i++) { cleaned=await cleanupIdleBrokerSession(${JSON.stringify(f.cwd)},session,{timeoutMs:5000}); if(!cleaned) await new Promise(resolve=>setTimeout(resolve,50)); }
        console.log(JSON.stringify({cleaned})); } catch(e) { console.error(e.stack); process.exitCode=1; }`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, READ_TRIGGER: trigger, READ_ENTERED: entered, READ_FIFO: fifo },
      stdio: ["pipe", "pipe", "pipe"] });
    owner.stdin.on("error", () => {});
    let stdout = "", stderr = "", ownerClosed = false, released = false, client;
    owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => owner.once("close", code => { ownerClosed = true; resolve(code); }));
    const waitFor = async (predicate, message, timeout = 8000) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (ownerClosed || Date.now() >= deadline) throw new Error(`${message}: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => stdout.includes('"session":'), "Broker did not become ready");
      const { session } = JSON.parse(stdout.trim().split("\n")[0]);
      assert.equal(session.endpoint, createBrokerEndpoint(session.sessionDir));
      t.diagnostic(`Managed endpoint: ${session.endpoint}`);
      client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: session.endpoint, brokerOnly: true, rpcTimeoutMs: 1000 });
      fs.writeFileSync(trigger, "read");
      const identity = { generation: session.generation, sessionId: "delayed-session", executionId: `delayed-${action}` };
      const pending = client.request("session/prompt", { ...identity, prompt: [{ type: "text", text: "must not forward" }] }, { signal: AbortSignal.timeout(5000) });
      void pending.catch(() => {});
      await waitFor(() => fs.existsSync(entered), "Broker did not start asynchronous journal read", 2000);
      if (action === "cancel") {
        const started = Date.now();
        const cancelClient = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: session.endpoint, brokerOnly: true, rpcTimeoutMs: 500,
          cancellationOnly: true, cancellationGeneration: identity.generation, cancellationSessionId: identity.sessionId, cancellationExecutionId: identity.executionId });
        try {
          const result = await cancelClient.request("broker/cancelTurn", identity);
          assert.equal(result.reservationAccepted, true);
          assert.equal(result.executionState, "never-accepted");
          assert.ok(Date.now() - started < 600, "cancellation was blocked by journal read");
        } finally { await cancelClient.close(); }
      } else { await client.close(); client = null; }
      const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); }
      released = true;
      await assert.rejects(pending);
      assert.equal(fs.existsSync(`${f.log}.events`), false, "delayed prompt reached fake agent");
    } finally {
      if (!released && fs.existsSync(entered)) {
        const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); }
      }
      if (client) await client.close();
      if (!ownerClosed) owner.stdin.end("cleanup\n");
      let timer; const code = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000); })]); clearTimeout(timer);
      if (code !== 0 || !stdout.includes('"cleaned":true')) { f.retain = true; if (!ownerClosed) owner.kill("SIGKILL"); await closed; throw new Error(`Owned broker cleanup unconfirmed: ${f.root}; ${stdout} ${stderr}`); }
    }
  });
}

test("signal shutdown rejects new clients while waiting for its agent", { skip: !posix }, async t => {
  const f = fixture(t), gatePath = path.join(f.root, "agent-close.sock");
  fs.appendFileSync(f.fake, String.raw`
const closeGate = require('node:net').createConnection(process.env.FAKE_CLOSE_GATE);
process.on('SIGTERM',()=>{});
process.stdin.on('end',()=>closeGate.write('closing\n'));
closeGate.on('data',()=>process.exit(0));
`);
  let peer, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const server = net.createServer(socket => { peer = socket; socket.once("data", entered); });
  await new Promise((resolve, reject) => server.once("error", reject).listen(gatePath, resolve));
  let child, exited, client, releaseAgent = false, refused = false, exitResult;
  try {
    const session = await ensureBrokerSession(f.cwd, { timeoutMs: 30000,
      env: { ...process.env, FAKE_CLOSE_GATE: gatePath }, onBrokerSpawn(value) {
        child = value;
        exited = new Promise(resolve => value.once("exit", (code, signal) => resolve({ code, signal })));
      } });
    assert.ok(session && child, "owned broker did not start");
    assert.equal(child.kill("SIGTERM"), true, "owned broker signal was not delivered");
    await Promise.race([waiting, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Agent did not enter close gate")), 4000); timer.unref(); })]);
    client = net.createConnection(session.endpoint.slice("unix:".length));
    refused = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), 300);
      client.once("close", () => { clearTimeout(timer); resolve(true); });
      client.once("error", error => {
        if (["ECONNRESET", "ECONNREFUSED", "ENOENT"].includes(error.code)) { clearTimeout(timer); resolve(true); }
        else { clearTimeout(timer); reject(error); }
      });
    });
    peer.write("exit\n"); releaseAgent = true;
    exitResult = await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 1800); timer.unref(); })]);
  } finally {
    if (client) client.destroy();
    if (peer && !releaseAgent && !peer.destroyed) peer.write("exit\n");
    if (child && !exitResult) {
      exitResult = await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 3000); timer.unref(); })]);
      if (!exitResult) f.retain = true;
    }
    if (peer && !peer.destroyed) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  assert.ok(exitResult, `Owned broker did not exit; fixture retained: ${f.root}`);
  assert.equal(refused, true, "broker accepted a client after signal shutdown started");
  assert.equal(exitResult.code, 0, JSON.stringify(exitResult));
});

for (const journalKind of ["pending", "corrupt"]) {
  test(`unrelated external endpoint permits normal prompt with ${journalKind} journal`, { skip: !posix }, async t => {
    const f = fixture(t), socketPath = path.join(f.root, "external.sock"), methods = [];
    fs.writeFileSync(f.journal, journalKind === "pending" ? f.pending : "{invalid\n");
    const server = net.createServer(socket => {
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        for (let index; (index = buffer.indexOf("\n")) >= 0;) {
          const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
          methods.push(message.method);
          const result = message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} }
            : message.method === "session/new" ? { sessionId: "external-session" }
              : message.method === "session/prompt" ? { stopReason: "end_turn" } : {};
          if (message.id !== undefined) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        }
      });
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    let client;
    try {
      client = await GrokAcpClient.connect(f.cwd, { brokerEndpoint: `unix:${socketPath}`, brokerOnly: true, rpcTimeoutMs: 1000 });
      const { sessionId } = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
      const result = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "external" }] }, { signal: AbortSignal.timeout(1500) });
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
    } finally {
      if (client) await client.close();
      await new Promise(resolve => server.close(resolve));
      // 明示的な外部 endpoint と brokerOnly だけを使い、fixture は子を起動しない。
      f.offlineConfirmed = true;
    }
  });
}
