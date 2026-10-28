import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { resolveStateDir, migrateStateLock } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";

const posix = process.platform === "darwin" || process.platform === "linux";
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function linuxProcessIdentity(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
  const match = stat.match(/^([1-9]\d*) \(.*\) ([A-Za-z]) (.*)$/s);
  assert.ok(match && match[1] === String(pid), "invalid Linux process identity");
  const fields = match[3].trim().split(/\s+/), ppid = Number(fields[0]), startTick = fields[18];
  assert.ok(Number.isSafeInteger(ppid) && ppid >= 0 && /^[1-9]\d*$/.test(startTick), "invalid Linux process stat");
  return { pid, ppid, startTick, state: match[2] };
}

async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause(20);
  }
}

function rpc(endpoint) {
  const socket = net.createConnection(endpoint.slice(5));
  let buffer = "", next = 0;
  const requests = new Map();
  const connected = new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const pending = requests.get(message.id);
      if (pending) { requests.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Socket closed")); }
    requests.clear();
  });
  return {
    connected,
    async request(method, params, timeout = 5000) {
      await connected;
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error(`No ${method} response`)); }, timeout);
        requests.set(id, { resolve, reject, timer });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() { socket.destroy(); }
  };
}

async function fixture(t) {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || os.tmpdir());
  assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
  for (let current = parent; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    if (path.dirname(current) === current) break;
  }
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "gba-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
  const fake = path.join(root, "fake-grok"), log = path.join(root, "agent"), preload = path.join(root, "gate.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({pid:process.pid, ppid:process.ppid, tmp:process.env.TMPDIR, home:process.env.HOME}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if (m.method==='session/prompt') fs.appendFileSync(process.env.FAKE_LOG+'.events', JSON.stringify(m)+'\n');
  const result=m.method==='initialize' ? {protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}
    : m.method==='session/new' ? {sessionId:'fake-session'} : m.method==='session/list' ? {sessions:[]}
    : m.method==='session/prompt' ? {stopReason:'end_turn'} : {};
  if (m.id!==undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`, { mode: 0o755 });
  // The broker inherits this preload; only asynchronous journal opens after the trigger are delayed.
  fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), original=fs.promises.open.bind(fs.promises);
fs.promises.open=async function(name,...args) {
  if (process.env.GROK_COMPANION_BROKER_GENERATION && String(name).endsWith('broker-admission.jsonl') && fs.existsSync(process.env.GATE_TRIGGER) && fs.readFileSync(process.env.GATE_TRIGGER,'utf8')==='2') {
    const handle=await original(name,...args), close=handle.close.bind(handle);
    handle.close=async function() {
      await close();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,850);
      fs.writeFileSync(process.env.GATE_STALLED,'stalled');
    };
    return handle;
  }
  if (process.env.GROK_COMPANION_BROKER_GENERATION && String(name).endsWith('broker-admission.jsonl') && fs.existsSync(process.env.GATE_TRIGGER) && fs.readFileSync(process.env.GATE_TRIGGER,'utf8')==='1') {
    fs.appendFileSync(process.env.GATE_COUNT,'open\n');
    const gate=await original(process.env.GATE_FIFO,'r');
    try { await gate.read(Buffer.alloc(1),0,1,null); } finally { await gate.close(); }
    fs.appendFileSync(process.env.GATE_RELEASED,'released\n');
    const handle=await original(name,...args), close=handle.close.bind(handle);
    handle.close=async function() { await close(); setImmediate(()=>fs.appendFileSync(process.env.GATE_FINISHED,'finished\n')); };
    return handle;
  }
  return original(name,...args);
};`);
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "FAKE_LOG", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "GROK_COMPANION_ACP_ENDPOINT", "XAI_API_KEY"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_LOG: log, HOME: root, USERPROFILE: root, TMPDIR: temp, TEMP: temp, TMP: temp });
  delete process.env.GROK_COMPANION_ACP_ENDPOINT; delete process.env.XAI_API_KEY;
  const state = resolveStateDir(cwd);
  const fifo = path.join(root, "gate"), trigger = path.join(root, "trigger"), count = path.join(root, "count"), released = path.join(root, "released"), finished = path.join(root, "finished"), stalled = path.join(root, "stalled");
  const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const source = `import {ensureBrokerSession,cleanupIdleBrokerSession} from ${JSON.stringify(lifecycle)};
    try { const session=await ensureBrokerSession(${JSON.stringify(cwd)}, {timeoutMs:30000});
      console.log(JSON.stringify({session})); await new Promise(resolve=>process.stdin.once('data',resolve));
      let cleaned=false; for(let i=0;i<20&&!cleaned;i++) { cleaned=await cleanupIdleBrokerSession(${JSON.stringify(cwd)},session,{timeoutMs:5000}); if(!cleaned) await new Promise(resolve=>setTimeout(resolve,50)); }
      console.log(JSON.stringify({cleaned})); } catch(e) { console.error(e.stack); process.exitCode=1; }`;
  let stdout = "", stderr = "", closed = false, session, journalOriginal, retained = false;
  let owner, exit, journal, migrationAttempted = false, migrated = false, ownedProcesses;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    // A nonblocking FIFO writer releases every pending read without hanging cleanup.
    if (fs.existsSync(count)) {
      let fd;
      try { fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, Buffer.alloc(256, 49)); } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    if (journalOriginal) fs.writeFileSync(journal, journalOriginal);
    if (owner) {
      if (!closed) owner.stdin.end("cleanup\n");
      let timer;
      const code = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); })]); clearTimeout(timer);
      if (code !== 0 || !stdout.includes('"cleaned":true')) {
        retained = true;
        if (!closed) { owner.kill("SIGKILL"); await exit; }
        t.diagnostic(`Cleanup unconfirmed, retained ${root}: ${stdout} ${stderr}`);
      }
    }
    const agent = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : null;
    if (process.platform === "linux" && owner && (!agent || !session || agent.ppid !== session.pid || !ownedProcesses)) retained = true;
    if (agent) {
      assert.equal(agent.home, root); assert.equal(agent.tmp, temp);
      if (process.platform === "linux") {
        for (const identity of ownedProcesses ?? []) {
          const current = linuxProcessIdentity(identity.pid);
          if (current && current.startTick === identity.startTick && !["Z", "X", "x"].includes(current.state)) {
            retained = true; t.diagnostic(`Owned process exit unconfirmed: ${identity.pid}`);
          }
        }
      } else {
        for (const pid of [agent.pid, session?.pid, owner?.pid].filter(Boolean)) {
          const ps = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
          if (ps.status === 0 && !ps.stdout.trim().startsWith("Z")) { retained = true; t.diagnostic(`Owned process still alive: ${pid}`); }
        }
      }
    }
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    assert.equal(path.dirname(root), parent);
    if (migrationAttempted && !migrated) retained = true;
    if (!retained && migrated && process.platform === "linux") {
      try {
        assert.equal(shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state }).stopped, true);
      } catch (error) {
        retained = true;
        t.diagnostic(`Sentinel shutdown unconfirmed, retained ${root}: ${error.message}`);
      }
    }
    if (!retained) fs.rmSync(root, { recursive: true, force: true });
    assert.equal(retained, false, "owned broker/agent cleanup was not confirmed");
  });
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  migrationAttempted = true;
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  migrated = true;
  journal = path.join(resolveBrokerStateDir(cwd), "broker-admission.jsonl");
  owner = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, GATE_TRIGGER: trigger, GATE_FIFO: fifo, GATE_COUNT: count, GATE_RELEASED: released, GATE_FINISHED: finished, GATE_STALLED: stalled } });
  owner.stdin.on("error", () => {});
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  exit = new Promise(resolve => owner.once("close", code => { closed = true; resolve(code); }));
  await until(() => stdout.includes('"session":') || closed, `Broker startup timed out: ${stderr}`);
  assert.equal(closed, false, stderr);
  session = JSON.parse(stdout.trim().split("\n")[0]).session;
  assert.equal(session.endpoint, createBrokerEndpoint(session.sessionDir));
  journalOriginal = fs.readFileSync(journal);
  const agent = JSON.parse(fs.readFileSync(log));
  assert.equal(agent.ppid, session.pid, "fake agent must belong to this broker");
  if (process.platform === "linux") {
    const brokerProcess = linuxProcessIdentity(session.pid), agentProcess = linuxProcessIdentity(agent.pid);
    assert.ok(brokerProcess && agentProcess, "owned broker and agent must be alive during setup");
    assert.equal(brokerProcess.ppid, owner.pid, "broker must belong to this fixture owner");
    assert.equal(agentProcess.ppid, session.pid, "agent must belong to this fixture broker");
    ownedProcesses = [brokerProcess, agentProcess];
  } else {
    const brokerParent = spawnSync("ps", ["-p", String(session.pid), "-o", "ppid="], { encoding: "utf8" });
    assert.equal(Number(brokerParent.stdout.trim()), owner.pid, "broker must belong to this fixture owner");
  }
  t.diagnostic(`fixture ${root}; endpoint ${session.endpoint}; owner ${owner.pid}; broker ${session.pid}; agent ${agent.pid}`);
  return { root, cwd, journal, journalOriginal, log, fifo, trigger, count, released, finished, stalled, session,
    client() { const client = rpc(session.endpoint); clients.push(client); return client; },
    release() { const fd = fs.openSync(fifo, "w"); try { fs.writeSync(fd, Buffer.alloc(256, 49)); } finally { fs.closeSync(fd); } },
    events() { return fs.existsSync(`${log}.events`) ? fs.readFileSync(`${log}.events`, "utf8") : ""; } };
}

const prompt = (sessionId, executionId) => ({ sessionId, executionId, prompt: [{ type: "text", text: "must stay behind admission gate" }] });

test("event loop stall cannot admit or cache a confirmation after its deadline", { skip: !posix }, async t => {
  const f = await fixture(t), client = f.client();
  fs.writeFileSync(f.trigger, "2");
  let first;
  try { first = await client.request("session/prompt", prompt("stall", "first"), 8000); }
  finally { fs.writeFileSync(f.trigger, "0"); }
  assert.ok(fs.existsSync(f.stalled), "broker did not stall before the journal read completed");
  fs.writeFileSync(f.journal, "{broken\n");
  const second = await client.request("session/prompt", prompt("stall", "second"));
  assert.ok(first.error, "elapsed deadline must reject the first prompt");
  assert.ok(second.error, "late completion must not open the confirmation cache");
  assert.equal(f.events(), "");
});

test("late successful admission check cannot open cache after its timeout", { skip: !posix }, async t => {
  const f = await fixture(t), client = f.client();
  fs.writeFileSync(f.trigger, "1");
  const first = client.request("session/prompt", prompt("late", "first"), 8000);
  void first.catch(() => {});
  await until(() => fs.existsSync(f.count), "Async journal read did not start", 2000);
  const timedOut = await first;
  assert.ok(timedOut.error, "pending check must fail within its deadline");
  f.release();
  await until(() => fs.existsSync(f.finished), "Delayed read did not finish");
  fs.writeFileSync(f.trigger, "0");
  fs.writeFileSync(f.journal, "{broken\n");
  const second = await client.request("session/prompt", prompt("late", "second"));
  assert.ok(second.error, "late completion must not cache success");
  assert.equal(f.events(), "");
});

test("simultaneous admission checks share bounded journal I/O", { skip: !posix }, async t => {
  const f = await fixture(t), clients = Array.from({ length: 12 }, () => f.client());
  await Promise.all(clients.map(client => client.connected));
  fs.writeFileSync(f.trigger, "1");
  const pending = clients.map((client, index) => client.request("session/prompt", prompt(`parallel-${index}`, `run-${index}`), 8000));
  for (const request of pending) void request.catch(() => {});
  await until(() => fs.existsSync(f.count), "Async journal read did not start", 2000);
  await pause(200);
  const opens = fs.readFileSync(f.count, "utf8").trim().split("\n").length;
  f.release();
  await Promise.all(pending);
  assert.ok(opens <= 1, `Expected one shared journal read, saw ${opens}`);
});

for (const kind of ["partial", "corrupt", "oversized", "generation"]) {
  test(`journal ${kind} fails closed for a managed broker`, { skip: !posix }, async t => {
    const f = await fixture(t), client = f.client();
    const original = f.journalOriginal.toString();
    const bad = kind === "partial" ? original.slice(0, -1)
      : kind === "corrupt" ? original + "{invalid\n"
        : kind === "oversized" ? "x".repeat(4 * 1024 * 1024 + 1)
          : original.replaceAll(f.session.generation, "other-generation");
    fs.writeFileSync(f.journal, bad);
    const result = await client.request("session/prompt", prompt("bad", kind));
    assert.ok(result.error, `${kind} journal unexpectedly admitted prompt`);
    assert.equal(f.events(), "");
  });
}

test("scoped cancellation remains available after confirmed cache and journal corruption", { skip: !posix }, async t => {
  const f = await fixture(t), client = f.client();
  const ready = await client.request("session/prompt", prompt("cached-session", "cached-execution"));
  assert.ok(ready.result, "confirmed broker should admit a normal request");
  fs.writeFileSync(f.journal, "{invalid\n");
  const identity = { generation: f.session.generation, sessionId: "cancel-session", executionId: "cancel-execution" };
  const started = Date.now();
  const result = await client.request("broker/cancelTurn", identity, 1000);
  assert.equal(result.result?.reservationAccepted, true);
  assert.equal(result.result?.executionState, "never-accepted");
  assert.ok(Date.now() - started < 1000);
});
