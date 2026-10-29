import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

const posix = process.platform === "darwin" || process.platform === "linux";
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(message); await pause(20); }
}
function alive(pid) {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  if (ps.status === 1 && !ps.stdout.trim() && !ps.error) return false;
  assert.equal(ps.status, 0, ps.stderr || ps.error?.message);
  const state = ps.stdout.trim();
  assert.ok(state, `Could not inspect PID ${pid}`);
  return !state.startsWith("Z");
}
function groupAlive(pgid) {
  const ps = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  assert.equal(ps.status, 0, ps.stderr);
  return ps.stdout.split("\n").some(line => { const [group, stat] = line.trim().split(/\s+/); return Number(group) === pgid && stat && !stat.startsWith("Z"); });
}
function processWithOutput(source, env, cwd) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", done = false, code = null, signal = null;
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.stdin.on("error", () => {});
  const exit = new Promise(resolve => child.once("close", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; done = true; resolve(code); }));
  return { child, exit, get stdout() { return stdout; }, get stderr() { return stderr; }, get done() { return done; }, get code() { return code; }, get signal() { return signal; } };
}

// This covers a crash before the first prompt, not a lost in-flight turn or persisted job cancellation.
// Separate direct agents may coexist; the assertions concern only the recorded generation and prompt.
test("pre-confirm broker crash does not duplicate a subsequent prompt", { skip: !posix, timeout: 90000 }, async t => {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || os.tmpdir());
  const relative = path.relative(repository, parent);
  assert.ok(path.isAbsolute(parent) && (relative === ".." || relative.startsWith(`..${path.sep}`)));
  for (let dir = parent; ; dir = path.dirname(dir)) {
    const stat = fs.lstatSync(dir); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    if (path.dirname(dir) === dir) break;
  }
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "orphan-"));
  const cwd = path.join(root, "w"), data = path.join(root, "d"), temp = path.join(root, "t");
  for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
  const fake = path.join(root, "fake-grok"), log = path.join(root, "agents.jsonl"), spawnLog = path.join(root, "agent-spawns.jsonl"), release = path.join(root, "release");
  const fifo = path.join(root, "fifo"), gate = path.join(root, "at-confirmed"), crash = path.join(root, "crash-generation");
  const preload = path.join(root, "preload.cjs");
  let migrate, owner, brokerDir, journal, session, first, saved, replacementSession;
  let migrationStarted = false;
  const probes = [];
  const agents = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    try {
      if (fs.existsSync(root)) fs.writeFileSync(release, "release");
      if (fs.existsSync(root)) fs.writeFileSync(`${release}.direct`, "release");
      for (const probe of probes) probe.child.stdin.end("release\n");
      // owner が gate 到達前の場合も、到達した後で FIFO を解放する。
      const processes = [migrate, owner, ...probes].filter(Boolean);
      const deadline = Date.now() + 12000;
      while (processes.some(process => !process.done) && Date.now() < deadline) {
        if (fs.existsSync(fifo)) {
          try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
            try { fs.writeSync(fd, "1"); } finally { fs.closeSync(fd); } } catch (error) {
            if (!["ENXIO", "ENOENT"].includes(error.code)) throw error;
          }
        }
        await pause(20);
      }
      if (processes.some(process => !process.done)) {
        for (const process of processes) if (!process.done) process.child.kill("SIGTERM");
        await Promise.race([Promise.all(processes.map(process => process.exit)), pause(3000)]);
        throw new Error("fixture owner did not exit naturally; possible unrecorded spawn");
      }
      assert.ok(!migrationStarted || migrate, "migration process identity is unavailable");
      assert.ok([owner, ...probes].filter(Boolean).every(process => process.code === 0 && process.signal === null), "owner ended abnormally; spawn recording is unconfirmed");
      if (migrationStarted) {
        const metadata = migrate.stdout.trim().split("\n").filter(Boolean).map(JSON.parse).at(-1);
        assert.ok(metadata?.stateDir && metadata.dev && metadata.ino, "migration state identity is unavailable");
        assert.equal(path.dirname(metadata.stateDir), path.join(data, "state"), "migration state escaped fixture");
        const stat = fs.lstatSync(metadata.stateDir, { bigint: true });
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && String(stat.dev) === metadata.dev && String(stat.ino) === metadata.ino, "state directory identity changed");
        if (process.platform === "linux") {
          assert.ok(metadata.epoch, "migration sentinel identity is unavailable");
          const marker = JSON.parse(fs.readFileSync(path.join(metadata.stateDir, "state.lock", "protocol.json"), "utf8"));
          assert.equal(marker.epoch, metadata.epoch, "sentinel epoch changed");
        }
        if (owner) {
          assert.ok(metadata.brokerDir, "broker directory identity is unavailable");
          const journalPath = path.join(metadata.brokerDir, "broker-admission.jsonl");
          assert.ok(fs.existsSync(journalPath), "broker journal is unavailable after owner spawn");
          const records = fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
          const spawned = records.filter(record => record.event === "spawned");
          for (const pending of records.filter(record => record.event === "pending")) {
            assert.ok(spawned.some(record => record.generation === pending.generation), `unrecorded spawn may exist for ${pending.generation}`);
          }
          for (const record of spawned) {
            assert.ok(Number.isInteger(record.pid) && record.pid > 0 && record.pgid === record.pid, "invalid spawned identity");
            fs.writeFileSync(crash, record.generation);
            await until(() => !alive(record.pid), `broker ${record.pid} did not exit`, 12000);
          }
          const spawnRecords = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
          assert.ok(spawnRecords.every(record => ["intent", "spawned"].includes(record.event)), "invalid agent spawn record");
          const agentSpawns = spawnRecords.filter(record => record.event === "spawned");
          for (const intent of spawnRecords.filter(record => record.event === "intent")) {
            assert.ok(agentSpawns.some(record => record.id === intent.id && record.ppid === intent.ppid && record.generation === intent.generation), "agent spawn outcome is unconfirmed");
          }
          for (const agent of agentSpawns) {
            assert.ok(spawnRecords.some(record => record.event === "intent" && record.id === agent.id && record.ppid === agent.ppid && record.generation === agent.generation), "agent spawn intent is unconfirmed");
            assert.ok(Number.isInteger(agent.pid) && agent.pid > 0 && Number.isInteger(agent.ppid));
            if (agent.generation) assert.ok(spawned.some(record => record.generation === agent.generation && record.pid === agent.ppid), "broker agent identity is unconfirmed");
            else assert.ok(probes.some(probe => probe.child.pid === agent.ppid), "direct agent owner is unconfirmed");
          }
          const allAgents = agents();
          for (const agent of allAgents) assert.ok(agentSpawns.some(record => record.pid === agent.pid && record.ppid === agent.ppid && record.generation === agent.generation), "agent spawn identity is unconfirmed");
          await until(() => agentSpawns.every(agent => !alive(agent.pid)), `agents did not exit: ${JSON.stringify(agentSpawns)}`, 12000);
          for (const record of spawned) await until(() => !groupAlive(record.pgid), `broker group ${record.pgid} did not exit`, 12000);
          for (const agent of agentSpawns.filter(agent => !agent.generation)) await until(() => !groupAlive(agent.pid), `direct group ${agent.pid} did not exit`, 12000);
        }
        if (saved && fs.existsSync(saved) && !fs.existsSync(path.join(metadata.brokerDir, "broker.json"))) fs.renameSync(saved, path.join(metadata.brokerDir, "broker.json"));
        if (process.platform === "linux") {
          const stopped = shutdownPosixStateLockSentinel(metadata.stateDir, { offlineConfirmed: true, expectedStateDir: metadata.stateDir });
          assert.equal(stopped.stopped, true);
          assert.equal(stopped.epoch, metadata.epoch);
        }
      }
      assert.equal(path.dirname(root), parent);
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Fixture retained because offline cleanup could not be confirmed: ${root}; ${error.message}`, { cause: error });
    }
  });
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({pid:process.pid,ppid:process.ppid,generation:process.env.GROK_COMPANION_BROKER_GENERATION||null})+'\n');
process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{});
setInterval(()=>{ if(fs.existsSync(process.env.FAKE_RELEASE) || (!process.env.GROK_COMPANION_BROKER_GENERATION && fs.existsSync(process.env.FAKE_RELEASE+'.direct'))) process.exit(0); },20);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='session/prompt') fs.appendFileSync(process.env.FAKE_LOG+'.prompts',JSON.stringify({pid:process.pid,request:m})+'\n');
  const result=m.method==='initialize'?{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}
    :m.method==='session/new'?{sessionId:'fixture-session'}:m.method==='session/list'?{sessions:[]}
    :m.method==='session/prompt'?{stopReason:'end_turn'}:{};
  if(m.id!==undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`, { mode: 0o755 });
  fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), mod=require('node:module'), cp=require('node:child_process'), spawn=cp.spawn;
let spawnSequence=0;
cp.spawn=function(command,args,options) {
  if(args?.[0]!=='agent' || args?.[1]!=='stdio') return spawn.call(this,command,args,options);
  const identity={id:process.pid+':'+(++spawnSequence),ppid:process.pid,generation:options?.env?.GROK_COMPANION_BROKER_GENERATION||null};
  fs.appendFileSync(process.env.FAKE_SPAWNS,JSON.stringify({event:'intent',...identity})+'\n');
  const child=spawn.call(this,command,args,options);
  fs.appendFileSync(process.env.FAKE_SPAWNS,JSON.stringify({event:'spawned',...identity,pid:child.pid})+'\n');
  return child;
}; mod.syncBuiltinESMExports();
if(!process.env.GROK_COMPANION_BROKER_GENERATION && process.env.ORPHAN_GATE==='1') {
  const original=fs.writeSync;
  fs.writeSync=function(fd,bytes,...args) {
    if(Buffer.isBuffer(bytes) && bytes.toString().includes('"event":"confirmed"') && bytes.toString().includes('"outcome":"ready"')) {
      fs.writeFileSync(process.env.ORPHAN_GATE_FILE,'entered');
      const gate=fs.openSync(process.env.ORPHAN_FIFO,'r'); fs.readSync(gate,Buffer.alloc(1),0,1,null); fs.closeSync(gate);
    }
    return original.call(this,fd,bytes,...args);
  }; mod.syncBuiltinESMExports();
}
if(process.env.GROK_COMPANION_BROKER_GENERATION && process.argv[1] && process.argv[1].endsWith('/acp-broker.mjs')) {
  setInterval(()=>{ try { if(fs.readFileSync(process.env.ORPHAN_CRASH,'utf8')===process.env.GROK_COMPANION_BROKER_GENERATION) process.exit(71); } catch {} },10);
}`);
  const env = { ...process.env, HOME: root, USERPROFILE: root, TMPDIR: temp, TMP: temp, TEMP: temp,
    CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_LOG: log, FAKE_SPAWNS: spawnLog, FAKE_RELEASE: release,
    ORPHAN_GATE_FILE: gate, ORPHAN_FIFO: fifo, ORPHAN_CRASH: crash, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  delete env.XAI_API_KEY; delete env.GROK_COMPANION_ACP_ENDPOINT;
  const stateUrl = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
  const brokerUrl = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const acpUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const grokUrl = new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).href;
  migrationStarted = true;
  migrate = processWithOutput(`import fs from "node:fs"; import path from "node:path"; import {resolveStateDir,migrateStateLock} from ${JSON.stringify(stateUrl)}; import {resolveBrokerStateDir} from ${JSON.stringify(brokerUrl)}; const c=${JSON.stringify(cwd)}; let s,brokerDir,epoch,dev,ino; try { s=resolveStateDir(c); migrateStateLock(c,{offlineConfirmed:true,localOnly:true,expectedStateDir:s}); brokerDir=resolveBrokerStateDir(c); } finally { try { epoch=JSON.parse(fs.readFileSync(path.join(s,"state.lock","protocol.json"),"utf8")).epoch; } catch {} try { const stat=fs.lstatSync(s,{bigint:true}); if(stat.isDirectory()&&!stat.isSymbolicLink()){dev=String(stat.dev);ino=String(stat.ino);} } catch {} console.log(JSON.stringify({stateDir:s,brokerDir,epoch,dev,ino})); }`, env, cwd);
  assert.equal(await migrate.exit, 0, migrate.stderr);
  brokerDir = JSON.parse(migrate.stdout.trim().split("\n").at(-1)).brokerDir;
  journal = path.join(brokerDir, "broker-admission.jsonl");
  owner = processWithOutput(`import {ensureBrokerSession} from ${JSON.stringify(brokerUrl)}; try {const session=await ensureBrokerSession(${JSON.stringify(cwd)},{timeoutMs:30000,createBrokerEndpoint:dir=>'unix:'+dir+'/b',env:{...process.env,PATH:${JSON.stringify(root)}+':'+process.env.PATH}}); console.log(JSON.stringify({session}));} catch(e) {console.log(JSON.stringify({error:e.message}));}`, { ...env, ORPHAN_GATE: "1", PATH: `${root}:${env.PATH}` }, cwd);
  await until(() => fs.existsSync(gate) || owner.done, `owner did not reach confirmed gate: ${owner.stderr}`);
  assert.ok(fs.existsSync(gate), `${owner.stdout} ${owner.stderr}`);
  const pending = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
  const spawned = pending.find(r => r.event === "spawned"), settled = pending.find(r => r.event === "settled");
  assert.ok(spawned && settled && settled.outcome === "ready");
  await until(() => agents().length === 1, "broker agent not started");
  first = agents()[0];
  assert.equal(first.generation, spawned.generation); assert.equal(first.ppid, spawned.pid);
  fs.writeFileSync(crash, spawned.generation);
  await until(() => !alive(spawned.pid), "broker did not exit itself");
  assert.ok(alive(first.pid) && groupAlive(spawned.pid), "owned agent must survive broker crash");
  const fd = fs.openSync(fifo, "w"); fs.writeSync(fd, "1"); fs.closeSync(fd);
  await until(() => owner.done, "owner did not settle");
  const result = JSON.parse(owner.stdout.trim()); session = result.session;
  assert.ok(session, JSON.stringify(result));
  assert.equal(session.pid, spawned.pid); assert.equal(session.generation, spawned.generation);
  const records = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some(r => r.event === "confirmed" && r.generation === session.generation && r.pid === session.pid && r.outcome === "ready"));
  t.diagnostic(`old owner ${owner.child.pid}; broker ${session.pid}; agent ${first.pid}; generation ${session.generation}; ready confirmed after crash`);

  const resumeSource = `import {interruptGrokTurn,runGrokTurn} from ${JSON.stringify(grokUrl)};
    const cancelled=await interruptGrokTurn(${JSON.stringify(cwd)},{sessionId:'fixture-session',executionId:'orphan-probe',transport:'broker',brokerGeneration:${JSON.stringify(session.generation)},env:process.env});
    let resumed; try {await runGrokTurn(${JSON.stringify(cwd)},{resumeSessionId:'fixture-session',executionId:'orphan-probe',prompt:'one user prompt',env:process.env}); resumed={ok:true};} catch(e) {resumed={error:e.message};}
    console.log(JSON.stringify({cancelled,resumed}));`;
  const resume = processWithOutput(resumeSource, env, cwd); probes.push(resume);
  await until(() => resume.done, `cancel/resume probe stalled: ${resume.stderr}`);
  const resumeResult = JSON.parse(resume.stdout.trim().split("\n").at(-1));
  assert.equal(resumeResult.cancelled.attempted, true);
  assert.equal(resumeResult.cancelled.interrupted, false);
  assert.notEqual(resumeResult.cancelled.stopConfirmed, true);
  assert.match(resumeResult.cancelled.detail, /ECONNREFUSED|ENOENT/);
  assert.match(resumeResult.resumed.error, /ECONNREFUSED|ENOENT/, "resume must not fall back to a new agent");
  assert.equal(agents().length, 1, "cancel or resume started a replacement agent");
  assert.ok(alive(first.pid));
  t.diagnostic(`cancel/resume: ${JSON.stringify(resumeResult)}`);

  const connectSource = `import {GrokAcpClient} from ${JSON.stringify(acpUrl)}; try { const c=await GrokAcpClient.connect(${JSON.stringify(cwd)},{grokBin:${JSON.stringify(fake)},env:process.env}); const s=await c.request('session/new',{cwd:${JSON.stringify(cwd)},mcpServers:[]}); await c.request('session/prompt',{sessionId:s.sessionId,executionId:'orphan-probe',prompt:[{type:'text',text:'one user prompt'}]}); console.log(JSON.stringify({transport:c.transport})); await new Promise(r=>process.stdin.once('data',r)); await c.close(); } catch(e) {console.log(JSON.stringify({error:e.message}));}`;
  const direct = processWithOutput(connectSource, env, cwd); probes.push(direct);
  await until(() => direct.stdout.includes("\n") || direct.done, `direct attempt stalled: ${direct.stderr}`);
  const directResult = JSON.parse(direct.stdout.trim().split("\n")[0]);
  assert.ok(alive(first.pid), "old agent must still be alive during direct attempt");
  t.diagnostic(`endpoint-unreachable attempt: ${JSON.stringify(directResult)}, agents=${JSON.stringify(agents())}`);
  const prompts = () => fs.existsSync(`${log}.prompts`) ? fs.readFileSync(`${log}.prompts`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  assert.ok(prompts().every(p => p.pid !== first.pid), "the crashed broker's agent received a prompt before ready confirmation");
  assert.equal(prompts().length, directResult.transport ? 1 : 0, `unexpected user prompt delivery: ${JSON.stringify(prompts())}`);
  if (directResult.transport) assert.notEqual(prompts()[0].pid, first.pid);
  fs.writeFileSync(`${release}.direct`, "release");
  direct.child.stdin.end("release\n");
  await until(() => direct.done, `direct owner did not finish: ${direct.stderr}`);

  // Move only this fixture's state file to reproduce absent broker.json; the confirmed journal remains intact.
  const brokerFile = path.join(brokerDir, "broker.json"); saved = `${brokerFile}.saved`;
  fs.renameSync(brokerFile, saved);
  const brokerSource = `import {ensureBrokerSession} from ${JSON.stringify(brokerUrl)}; try { const s=await ensureBrokerSession(${JSON.stringify(cwd)},{timeoutMs:6000,createBrokerEndpoint:dir=>'unix:'+dir+'/b',env:process.env}); console.log(JSON.stringify({session:s})); } catch(e) { console.log(JSON.stringify({error:e.message})); }`;
  const replacement = processWithOutput(brokerSource, { ...env, PATH: `${root}:${env.PATH}` }, cwd); probes.push(replacement);
  await until(() => replacement.done, `replacement attempt stalled: ${replacement.stderr}`, 20000);
  const replacementResult = JSON.parse(replacement.stdout.trim().split("\n")[0]);
  replacementSession = replacementResult.session;
  t.diagnostic(`missing broker.json attempt: ${JSON.stringify(replacementResult)}, agents=${JSON.stringify(agents())}`);
  assert.ok(prompts().every(p => p.pid !== first.pid));
  assert.ok(prompts().length <= 1, "the same user prompt was delivered more than once");
});
