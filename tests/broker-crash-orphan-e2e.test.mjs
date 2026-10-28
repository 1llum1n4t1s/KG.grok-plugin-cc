import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const posix = process.platform === "darwin" || process.platform === "linux";
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(message); await pause(20); }
}
function alive(pid) {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return ps.status === 0 && !ps.stdout.trim().startsWith("Z");
}
function groupAlive(pgid) {
  const ps = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  assert.equal(ps.status, 0, ps.stderr);
  return ps.stdout.split("\n").some(line => { const [group, stat] = line.trim().split(/\s+/); return Number(group) === pgid && stat && !stat.startsWith("Z"); });
}
function processWithOutput(source, env, cwd) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", done = false;
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.stdin.on("error", () => {});
  const exit = new Promise(resolve => child.once("close", code => { done = true; resolve(code); }));
  return { child, exit, get stdout() { return stdout; }, get stderr() { return stderr; }, get done() { return done; } };
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
  const fake = path.join(root, "fake-grok"), log = path.join(root, "agents.jsonl"), release = path.join(root, "release");
  const fifo = path.join(root, "fifo"), gate = path.join(root, "at-confirmed"), crash = path.join(root, "crash-generation");
  const preload = path.join(root, "preload.cjs");
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
const fs=require('node:fs'), mod=require('node:module');
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
    CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_LOG: log, FAKE_RELEASE: release,
    ORPHAN_GATE_FILE: gate, ORPHAN_FIFO: fifo, ORPHAN_CRASH: crash, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  delete env.XAI_API_KEY; delete env.GROK_COMPANION_ACP_ENDPOINT;
  const stateUrl = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
  const brokerUrl = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const acpUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
  const grokUrl = new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).href;
  const migrate = processWithOutput(`import {resolveStateDir,migrateStateLock} from ${JSON.stringify(stateUrl)}; const c=${JSON.stringify(cwd)}; const s=resolveStateDir(c); migrateStateLock(c,{offlineConfirmed:true,localOnly:true,expectedStateDir:s}); console.log(s);`, env, cwd);
  assert.equal(await migrate.exit, 0, migrate.stderr);
  const state = migrate.stdout.trim(), brokerDir = path.join(state, "broker-v2"), journal = path.join(brokerDir, "broker-admission.jsonl");
  const owner = processWithOutput(`import {ensureBrokerSession} from ${JSON.stringify(brokerUrl)}; try {const session=await ensureBrokerSession(${JSON.stringify(cwd)},{timeoutMs:30000,createBrokerEndpoint:dir=>'unix:'+dir+'/b',env:{...process.env,PATH:${JSON.stringify(root)}+':'+process.env.PATH}}); console.log(JSON.stringify({session}));} catch(e) {console.log(JSON.stringify({error:e.message}));}`, { ...env, ORPHAN_GATE: "1", PATH: `${root}:${env.PATH}` }, cwd);
  const probes = [];
  const agents = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  let session, first, saved, replacementSession;
  t.after(async () => {
    if (!fs.existsSync(gate) && fs.existsSync(temp)) {
      for (const entry of fs.readdirSync(temp)) {
        const brokerLog = path.join(temp, entry, "broker.log");
        if (fs.existsSync(brokerLog)) t.diagnostic(`broker startup log: ${fs.readFileSync(brokerLog, "utf8")}`);
      }
    }
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, "1"); fs.closeSync(fd); } catch {}
    if (replacementSession) fs.writeFileSync(crash, replacementSession.generation);
    fs.writeFileSync(release, "release");
    for (const probe of probes) probe.child.stdin.end("release\n");
    if (saved && fs.existsSync(saved)) fs.renameSync(saved, path.join(brokerDir, "broker.json"));
    await until(() => agents().every(a => !alive(a.pid)), `Agents did not exit naturally: ${JSON.stringify(agents())}`, 12000);
    if (session) await until(() => !groupAlive(session.pid), `Owned group ${session.pid} still alive`, 12000);
    if (replacementSession) await until(() => !groupAlive(replacementSession.pid), `Replacement group ${replacementSession.pid} still alive`, 12000);
    await Promise.all([owner, ...probes].map(p => Promise.race([p.exit, pause(12000)])));
    if ([owner, ...probes].some(p => !p.done)) { t.diagnostic(`Processes still running; retained ${root}`); throw new Error("fixture process did not exit naturally"); }
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
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
