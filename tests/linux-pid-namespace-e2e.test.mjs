import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { inspectPosixStateLockScope, readPosixStateLockProtocol } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { sentinelScript } from "../plugins/grok/scripts/lib/linux-state-sentinel.mjs";
import { initializeLinuxLeaseLedger } from "../plugins/grok/scripts/lib/linux-lease-ledger.mjs";

// 先行失敗条件: 別 namespace の生存 PID/PGID を不在と誤認、同 namespace の誤拒否、
// 旧 marker の誤受理、boot/namespace 変更や照会不能の見逃し、PID 衝突による誤状態更新・signal、
// 祖先 namespace の procfs と現在の kill(0) が別の PID を解釈する場合の誤照合。
// sentinel の起動途中の親死亡・期限、未同期 marker と ready、終了後の PID 再利用、
// zombie・不正 argv/開始 tick・照会不能・time/net namespace 不一致も拒否する。
// 明示された専用 tmpfs/ext4 root と unshare が必要。実アカウントや利用者 state は使わない。
const root = process.env.GROK_PID_NAMESPACE_TEST_ROOT;
const enabled = process.platform === "linux" && !!root;
const processModule = new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).href;
const lockModule = new URL("../plugins/grok/scripts/lib/posix-state-lock.mjs", import.meta.url).href;
const jobModule = new URL("../plugins/grok/scripts/lib/job-control.mjs", import.meta.url).href;
const brokerSource = fileURLToPath(new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url));
const brokerModule = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
const ledgerModule = new URL("../plugins/grok/scripts/lib/linux-lease-ledger.mjs", import.meta.url).href;
const migrationImport = `import {migratePosixStateLock} from ${JSON.stringify(lockModule)};import {initializeLinuxLeaseLedger} from ${JSON.stringify(ledgerModule)};`;
const migrationCall = `migratePosixStateLock(process.env.PROBE_STATE,{expectedStateDir:process.env.PROBE_STATE,prepareLinuxGeneration:context=>initializeLinuxLeaseLedger({context})})`;
const migrateFixtureLock = (lock, stateDir) => lock.migratePosixStateLock(stateDir, {
  expectedStateDir: stateDir, prepareLinuxGeneration: context => initializeLinuxLeaseLedger({ context })
});

const ownerSource = `
import net from 'node:net';
import {getProcessSnapshot} from ${JSON.stringify(processModule)};
const server=net.createServer(c=>c.on('data',()=>c.end('pong')));
server.listen(process.env.PROBE_SOCKET,()=>console.log(JSON.stringify({pid:process.pid,startKey:getProcessSnapshot(process.pid).startKey})));
process.stdin.resume();process.stdin.on('end',()=>server.close());
setTimeout(()=>server.close(),60000).unref();
`;

const observerSource = `
import fs from 'node:fs';import net from 'node:net';import {spawn,spawnSync} from 'node:child_process';
import {inspectTrackedJobProcess} from ${JSON.stringify(processModule)};
import {inspectPosixStateLockScope,readPosixStateLockProtocol,migratePosixStateLock} from ${JSON.stringify(lockModule)};
import {initializeLinuxLeaseLedger} from ${JSON.stringify(ledgerModule)};
import {buildStatusSnapshot} from ${JSON.stringify(jobModule)};
const owner=JSON.parse(process.env.PROBE_OWNER), stateDir=process.env.PROBE_STATE, cwd=process.env.PROBE_WORKSPACE;
const nspid=fs.readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s*(.+)$/m)?.[1].trim().split(/\\s+/).map(Number)??[];
const result={namespace:fs.readlinkSync('/proc/self/ns/pid'),ownerNamespace:process.env.PROBE_OWNER_NS,nspid,selfPid:process.pid,procSelf:fs.readlinkSync('/proc/self'),signals:[]};
const actualKill=process.kill.bind(process);process.kill=(pid,signal)=>{if(signal!==0){result.signals.push([pid,signal]);throw Error('unexpected signal');}return actualKill(pid,signal);};
for(const [key,pid] of [['pid',owner.pid],['pgid',-owner.pid]]){try{process.kill(pid,0);result[key]='present';}catch(e){result[key]=e.code;}}
result.tracked=inspectTrackedJobProcess(owner.pid,owner.startKey);
const text=fs.readFileSync(${JSON.stringify(brokerSource)},'utf8');
const body=text.slice(text.indexOf('function brokerHasExited('),text.indexOf('\\nfunction cleanupBrokerArtifacts('));
result.brokerExited=Function('process',body+';return brokerHasExited;')(process)('',{pid:owner.pid,ownedGroup:{pgid:owner.pid}});
let gate;
if(process.env.PROBE_COLLISION==='1'){
  if(owner.pid>1200)result.collisionSkipped='owner PID exceeds bounded fixture limit';
  else {
    let previous=0;
    while(previous<owner.pid-1){const c=spawnSync('/bin/true');if(c.error||c.status!==0)throw c.error??Error('PID allocator child failed');previous=c.pid;}
    if(previous===owner.pid-1){gate=spawn('/bin/sh',['-c','read ignored'],{stdio:['pipe','ignore','ignore']});result.collisionPid=gate.pid;try{process.kill(owner.pid,0);result.collisionExists=true;}catch{result.collisionExists=false;}result.collisionTracked=inspectTrackedJobProcess(owner.pid,owner.startKey);}
    else result.collisionSkipped='PID allocated past target';
  }
}
try{readPosixStateLockProtocol(stateDir+'/state.lock',inspectPosixStateLockScope(stateDir));result.marker='accepted';}catch(e){result.marker='rejected';}
try{const s=buildStatusSnapshot(cwd,{env:{}});result.status='returned';result.running=s.running.map(j=>j.id);}catch(e){result.status='rejected';}
if(process.env.PROBE_INHERITED==='1'){const separate=process.env.PROBE_SEPARATE;fs.mkdirSync(separate,{mode:0o700});try{migratePosixStateLock(separate,{expectedStateDir:separate,prepareLinuxGeneration:context=>initializeLinuxLeaseLedger({context})});result.inheritedMigration='accepted';}catch{result.inheritedMigration='rejected';}result.inheritedArtifacts=fs.readdirSync(separate);}
const socket=net.connect(process.env.PROBE_SOCKET);socket.on('connect',()=>socket.write('ping'));
socket.on('data',data=>{result.socketReply=data.toString();socket.end();});
socket.on('error',e=>{result.socketError=e.message;});
socket.on('close',()=>{if(gate)gate.stdin.end('release\\n');console.log(JSON.stringify(result));});
`;

function childResult(source, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("Linux PID namespace ownership is enforced for shared state", { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 120000 }, async t => {
  assert.ok(path.isAbsolute(root));
  const base = fs.realpathSync(root);
  assert.ok(fs.statSync(base).isDirectory());
  const support = spawnSync("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", "mount -t proc proc /proc"], { encoding: "utf8" });
  if (support.status !== 0) return t.skip(`PID/mount namespace unavailable: ${support.stderr?.trim() || support.error?.message || "unknown error"}`);
  const dir = fs.mkdtempSync(path.join(base, "pidns-e2e-"));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const priorData = process.env.CLAUDE_PLUGIN_DATA, priorPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(dir, "plugin-data");
  delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const socket = path.join(dir, "broker.sock");
  let owner;
  t.after(async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      owner.stdin.end();
      await new Promise(resolve => owner.once("close", resolve));
    }
    if (priorData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = priorData;
    if (priorPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = priorPlugin;
    const lock = await import(lockModule);
    if (typeof lock.shutdownPosixStateLockSentinel === "function" && fs.existsSync(path.join(stateDir, "state.lock", "protocol.json"))) {
      await lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const scope = inspectPosixStateLockScope(stateDir);
  await t.test("same namespace accepts its marker", () => {
    assert.ok(readPosixStateLockProtocol(path.join(stateDir, "state.lock"), scope));
  });
  owner = spawn(process.execPath, ["--input-type=module", "-e", ownerSource], { detached: true, env: { ...process.env, PROBE_SOCKET: socket }, stdio: ["pipe", "pipe", "pipe"] });
  const ownerInfo = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    owner.stderr.on("data", c => { errors += c; });
    owner.stdout.on("data", c => { output += c; if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0])); });
    owner.once("error", reject); owner.once("exit", code => reject(new Error(`owner exited before ready: ${code} ${errors}`)));
  });
  const seed = () => {
    const job = { id: "owner", status: "running", pid: ownerInfo.pid, processStartKey: ownerInfo.startKey, createdAt: new Date().toISOString() };
    updateState(workspace, (state, context) => {
      state.jobs = [job];
      writeJobFile(workspace, job.id, job, context);
    });
  };
  seed();
  const env = { ...process.env, PROBE_OWNER: JSON.stringify(ownerInfo), PROBE_OWNER_NS: fs.readlinkSync("/proc/self/ns/pid"), PROBE_STATE: stateDir, PROBE_WORKSPACE: workspace, PROBE_SOCKET: socket };
  function observe(collision, inheritedProc = false) {
    const launch = inheritedProc ? 'exec "$@"' : 'mount -t proc proc /proc && exec "$@"';
    const r = spawnSync("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", launch, "probe", process.execPath, "--input-type=module", "-e", observerSource], { env: { ...env, PROBE_COLLISION: collision ? "1" : "0", PROBE_INHERITED: inheritedProc ? "1" : "0", PROBE_SEPARATE: path.join(dir, "inherited-state") }, encoding: "utf8", timeout: 60000 });
    assert.equal(r.error, undefined, r.error?.message); assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim());
  }
  const before = fs.readFileSync(path.join(stateDir, "state.json"), "utf8");
  const foreign = observe(false);
  await t.test("foreign namespace cannot treat a live owner as exited", () => {
    assert.notEqual(foreign.namespace, foreign.ownerNamespace);
    assert.equal(foreign.socketReply, "pong");
    assert.equal(foreign.pid, "ESRCH"); assert.equal(foreign.pgid, "ESRCH");
    assert.deepEqual(foreign.nspid, [foreign.selfPid]);
    assert.equal(foreign.marker, "rejected", JSON.stringify(foreign));
    assert.equal(foreign.status, "rejected", JSON.stringify(foreign));
    assert.deepEqual(foreign.signals, []);
    assert.equal(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"), before);
  });
  seed();
  const inherited = observe(false, true);
  await t.test("ancestor procfs PID view is rejected", () => {
    assert.notEqual(inherited.namespace, inherited.ownerNamespace);
    assert.equal(inherited.socketReply, "pong");
    assert.ok(inherited.nspid.length > 1, JSON.stringify(inherited));
    assert.equal(inherited.nspid.at(-1), inherited.selfPid);
    assert.notEqual(Number(inherited.procSelf), inherited.selfPid);
    assert.equal(inherited.inheritedMigration, "rejected", JSON.stringify(inherited));
    assert.deepEqual(inherited.inheritedArtifacts, []);
    assert.equal(inherited.marker, "rejected", JSON.stringify(inherited));
    assert.equal(inherited.status, "rejected", JSON.stringify(inherited));
    assert.deepEqual(inherited.signals, []);
  });
  seed();
  const collisionBefore = fs.readFileSync(path.join(stateDir, "state.json"), "utf8");
  const collision = observe(true);
  await t.test("a colliding PID cannot change status or signal an unrelated process", t => {
    if (collision.collisionSkipped) return t.skip(collision.collisionSkipped);
    assert.equal(collision.collisionPid, ownerInfo.pid);
    assert.equal(collision.collisionExists, true);
    assert.equal(collision.socketReply, "pong");
    assert.equal(collision.status, "rejected", JSON.stringify(collision));
    assert.deepEqual(collision.signals, []);
    assert.equal(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"), collisionBefore);
  });
  const markerPath = path.join(stateDir, "state.lock", "protocol.json");
  const original = fs.readFileSync(markerPath, "utf8");
  await t.test("marker contains a live sentinel generation and time namespace", () => {
    const marker = JSON.parse(original);
    assert.match(marker.timeNamespace, /^time:\[[1-9]\d*\]$/);
    assert.match(marker.netNamespace, /^net:\[[1-9]\d*\]$/);
    assert.match(marker.sentinel?.generation, /^[a-f0-9-]{36}$/);
    assert.match(marker.sentinel?.nonce, /^[a-f0-9]{32}$/);
    assert.ok(Number.isSafeInteger(marker.sentinel?.pid) && marker.sentinel.pid > 0);
    assert.match(marker.sentinel?.startTick, /^[1-9]\d*$/);
  });
  for (const [name, mutate] of [
    ["generation", marker => { marker.sentinel.generation = "invalid"; }],
    ["nonce", marker => { marker.sentinel.nonce = "00000000000000000000000000000000"; }],
    ["pid", marker => { marker.sentinel.pid = 2147483647; }],
    ["start tick", marker => { marker.sentinel.startTick = "1"; }],
    ["time namespace", marker => { marker.timeNamespace = "time:[1]"; }],
    ["network namespace", marker => { marker.netNamespace = "net:[1]"; }],
  ]) await t.test(`changed sentinel ${name} fails closed`, t => {
    const marker = JSON.parse(original);
    if (!marker.sentinel) return t.skip("sentinel marker is not implemented");
    mutate(marker);
    try {
      fs.writeFileSync(markerPath, JSON.stringify(marker));
      assert.throws(() => readPosixStateLockProtocol(path.join(stateDir, "state.lock"), inspectPosixStateLockScope(stateDir)));
    } finally { fs.writeFileSync(markerPath, original); }
  });
  await t.test("legacy marker without namespace identity fails closed", () => {
    const current = JSON.parse(original);
    const legacy = Object.fromEntries(["localOnly", "hostId", "fileSystem", "directoryIdentity", "barrierIdentity", "lockIdentity", "markerIdentity"].map(key => [key, current[key]]));
    legacy.protocol = "posix-local-v1";
    try { const data = JSON.stringify(legacy); fs.writeFileSync(markerPath, data); assert.throws(() => readPosixStateLockProtocol(path.join(stateDir, "state.lock"), inspectPosixStateLockScope(stateDir))); assert.equal(fs.readFileSync(markerPath, "utf8"), data); }
    finally { fs.writeFileSync(markerPath, original); }
  });
  const preload = path.join(dir, "preload.cjs");
  fs.writeFileSync(preload, `const fs=require('node:fs'),{syncBuiltinESMExports}=require('node:module');for(const name of ['readFileSync','readlinkSync','statSync','lstatSync']){const orig=fs[name];fs[name]=function(p,...a){const target=String(p),mode=process.env.PROBE_MODE;if((mode==='missing-ns'&&target==='/proc/self/ns/pid')||(mode==='missing-boot'&&target==='/proc/sys/kernel/random/boot_id')||(mode==='missing-status'&&target==='/proc/self/status'))throw Object.assign(new Error('isolated lookup failure'),{code:'EIO'});if(name==='readlinkSync'&&target==='/proc/self/ns/pid'&&mode==='invalid-ns')return 'pid:[0]';if(name==='readFileSync'&&target==='/proc/sys/kernel/random/boot_id'){if(mode==='invalid-boot')return 'invalid';if(mode==='boot')return '00000000-0000-4000-8000-000000000000';}if(name==='readFileSync'&&target==='/proc/self/status'){const value=orig.call(this,p,...a);if(mode==='duplicate-status')return value.replace(/^NSpid:.*$/m,'NSpid:\\t'+process.pid+'\\nNSpid:\\t'+process.pid);if(mode==='wrong-status')return value.replace(/^NSpid:.*$/m,'NSpid:\\t'+(process.pid+1));if(mode==='nested-status')return value.replace(/^NSpid:.*$/m,'NSpid:\\t'+process.pid+'\\t'+process.pid);}return orig.call(this,p,...a);};}syncBuiltinESMExports();`);
  const probe = `import {inspectPosixStateLockScope,readPosixStateLockProtocol} from ${JSON.stringify(lockModule)};try{readPosixStateLockProtocol(process.env.PROBE_STATE+'/state.lock',inspectPosixStateLockScope(process.env.PROBE_STATE));console.log(JSON.stringify('accepted'));}catch{console.log(JSON.stringify('rejected'));}`;
  for (const mode of ["missing-ns", "missing-boot", "missing-status", "invalid-ns", "invalid-boot", "duplicate-status", "wrong-status", "nested-status", "boot"]) await t.test(`identity check fails closed: ${mode}`, () => {
    assert.equal(childResult(probe, { ...env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, PROBE_MODE: mode }), "rejected");
  });
  const sentinelPreload = path.join(dir, "sentinel-preload.cjs");
  fs.writeFileSync(sentinelPreload, `
const fs = require('node:fs'), {syncBuiltinESMExports} = require('node:module');
for (const method of ['readFileSync', 'readlinkSync']) {
  const original = fs[method];
  fs[method] = function(p, ...args) {
    const target = String(p), mode = process.env.PROBE_MODE, sentinel = '/proc/' + process.env.PROBE_SENTINEL;
    const fail = () => { throw Object.assign(new Error('isolated sentinel lookup failure'), {code: 'EIO'}); };
    if (mode === 'missing-time' && target === '/proc/self/ns/time') fail();
    if (mode === 'missing-net' && target === '/proc/self/ns/net') fail();
    if (mode === 'missing-sentinel' && target.startsWith(sentinel + '/')) fail();
    if (method === 'readlinkSync' && target === sentinel + '/ns/time' && mode === 'wrong-time') return 'time:[1]';
    if (method === 'readlinkSync' && target === sentinel + '/ns/net' && mode === 'wrong-net') return 'net:[1]';
    let value = original.call(this, p, ...args);
    if (target === sentinel + '/status' && (mode === 'zombie' || mode === 'dead')) {
      value = String(value).replace(/^State:.*$/m, 'State:\\t' + (mode === 'zombie' ? 'Z' : 'X') + ' (dead)');
    }
    if (target === sentinel + '/cmdline' && mode === 'wrong-argv') value = Buffer.from('unrelated\\0process\\0');
    return value;
  };
}
syncBuiltinESMExports();
`);
  for (const mode of ["missing-time", "missing-net", "missing-sentinel", "wrong-time", "wrong-net", "zombie", "dead", "wrong-argv"]) await t.test(`sentinel observation fails closed: ${mode}`, t => {
    const marker = JSON.parse(original);
    if (!marker.sentinel) return t.skip("sentinel marker is not implemented");
    assert.equal(childResult(probe, { ...env, NODE_OPTIONS: `--require ${JSON.stringify(sentinelPreload)}`, PROBE_MODE: mode, PROBE_SENTINEL: String(marker.sentinel.pid) }), "rejected");
  });
});

test("sentinel shutdown invalidates its marker without signaling a PID", { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(root), "sentinel-stop-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const lock = await import(lockModule);
  let stopped = false;
  t.after(async () => {
    if (!stopped && typeof lock.shutdownPosixStateLockSentinel === "function") {
      await lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  migrateFixtureLock(lock, stateDir);
  const scope = lock.inspectPosixStateLockScope(stateDir);
  assert.ok(lock.readPosixStateLockProtocol(path.join(stateDir, "state.lock"), scope));
  assert.equal(typeof lock.shutdownPosixStateLockSentinel, "function");
  assert.throws(() => lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: false, expectedStateDir: stateDir }));
  assert.throws(() => lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: path.join(dir, "other") }));
  assert.ok(lock.readPosixStateLockProtocol(path.join(stateDir, "state.lock"), scope));
  await lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
  stopped = true;
  assert.throws(() => lock.readPosixStateLockProtocol(path.join(stateDir, "state.lock"), scope));
  assert.throws(() => migrateFixtureLock(lock, stateDir));
});

// sentinel と観測側が別々の安定した mount namespace にいる。旧パスを隠すのは観測側だけ。
// FD 3 の旧 sentinel・不整合は、実 process 境界で procfs の観測だけを注入する。
test("sentinel barrier identity and stable cross-namespace root aliases", { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(root), "sentinel-mount-alias-"));
  const stateDir = path.join(dir, "state"), alias = path.join(dir, "alias"), wrong = path.join(dir, "wrong");
  for (const directory of [stateDir, alias, wrong]) fs.mkdirSync(directory, { mode: 0o700 });
  const lock = await import(lockModule);
  let initialized = false;
  t.after(() => {
    if (initialized) lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const marker = migrateFixtureLock(lock, stateDir);
  initialized = true;
  const markerPath = path.join(stateDir, "state.lock", "protocol.json"), originalMarker = fs.readFileSync(markerPath, "utf8");
  const preload = path.join(dir, "fd-observation.cjs");
  fs.writeFileSync(preload, `
const fs=require('node:fs'),{syncBuiltinESMExports}=require('node:module');
const stat=fs.statSync,read=fs.readFileSync,readdir=fs.readdirSync;let fd3Calls=0,phase='other';
const prefix='/proc/'+process.env.PROBE_SENTINEL;
fs.readdirSync=function(file,...args){if(String(file)===prefix+'/fd')phase='enumeration';return readdir.call(this,file,...args)};
fs.readFileSync=function(file,...args){if(String(file)===prefix+'/cmdline')phase='barrier';return read.call(this,file,...args)};
fs.statSync=function(file,...args){
 if(String(file)===prefix+'/fd/3'){
  fd3Calls++;fs.appendFileSync(process.env.PROBE_AUDIT,'seen:'+phase+':'+fd3Calls+'\\n');
  // 旧 marker には barrier 判定がないため、列挙時の観測を操作する。
  if(phase===process.env.PROBE_INJECT_PHASE && process.env.PROBE_FD_MODE!=='actual'){
  fs.appendFileSync(process.env.PROBE_AUDIT,'injected:'+process.env.PROBE_FD_MODE+':'+phase+':'+fd3Calls+'\\n');
  if(process.env.PROBE_FD_MODE==='missing')throw Object.assign(new Error('legacy fd absent'),{code:'ENOENT'});
  if(process.env.PROBE_FD_MODE==='denied')throw Object.assign(new Error('fd access denied'),{code:'EACCES'});
  if(process.env.PROBE_FD_MODE==='legacy-file')return stat.call(this,process.env.PROBE_READY,...args);
  if(process.env.PROBE_FD_MODE==='wrong-directory')return stat.call(this,process.env.PROBE_WRONG,...args);
  }
 }
 return stat.call(this,file,...args);
};syncBuiltinESMExports();
`);
  const source = `
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {inspectPosixStateLockScope,readPosixStateLockProtocol,withPosixStateLock} from ${JSON.stringify(lockModule)};
const original=process.env.PROBE_STATE,alias=process.env.PROBE_ALIAS,hidden=process.env.PROBE_HIDDEN==='1';
if(hidden){
 const mount=(args)=>{
  const r=spawnSync('mount',args,{encoding:'utf8',timeout:5000});
  if(r.error?.code==='ENOENT'||(!r.error&&r.status!==0&&/(operation not permitted|permission denied|must be superuser|not permitted)/i.test(r.stderr))){console.log(JSON.stringify({skip:r.error?.message||r.stderr}));process.exit(0)}
  if(r.error||r.status!==0)throw new Error('mount fixture failed: '+(r.error?.message||r.stderr||'status '+r.status));
 };
 mount(['--make-rprivate','/']);mount(['--bind',original,alias]);mount(['-t','tmpfs','tmpfs',original]);
}
const observed=hidden?alias:original, originalVisible=fs.existsSync(path.join(original,'state.lock','protocol.json'));
const namespace=fs.readlinkSync('/proc/self/ns/mnt'),sentinelNamespace=fs.readlinkSync('/proc/'+process.env.PROBE_SENTINEL+'/ns/mnt');
let accepted=false,entered=false,error;try{const scope=inspectPosixStateLockScope(observed);readPosixStateLockProtocol(path.join(observed,'state.lock'),scope);withPosixStateLock(observed,scope,()=>{entered=true},{timeoutMs:2000});accepted=true}catch(e){error=e.message}
console.log(JSON.stringify({accepted,entered,error,originalVisible,namespace,sentinelNamespace}));
`;
  for (const [hidden, mode, markerKind, expected] of [
    [false, "actual", "new", true], [false, "missing", "new", false], [false, "legacy-file", "new", false],
    [false, "wrong-directory", "new", false], [false, "denied", "new", false],
    [false, "missing", "old", true], [false, "legacy-file", "old", true], [false, "wrong-directory", "old", true], [false, "denied", "old", false],
    [false, "actual", "invalid-null", false], [false, "actual", "invalid-number", false], [false, "actual", "invalid-string", false], [false, "actual", "invalid-false", false],
    [true, "actual", "new", true], [true, "wrong-directory", "new", false], [true, "missing", "new", false],
    [true, "missing", "old", false], [true, "legacy-file", "old", false]
  ]) {
    await t.test(`${hidden ? "mount namespace" : "same namespace"}: ${markerKind} marker, ${mode}`, t => {
    const mutated = JSON.parse(originalMarker);
    if (markerKind === "old") delete mutated.sentinel.barrierFd;
    else mutated.sentinel.barrierFd = ({ new: 3, "invalid-null": null, "invalid-number": 4, "invalid-string": "3", "invalid-false": false })[markerKind];
    fs.writeFileSync(markerPath, JSON.stringify(mutated));
    try {
    const audit = path.join(dir, `audit-${hidden}-${markerKind}-${mode}`);
    const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, PROBE_STATE: stateDir,
      PROBE_ALIAS: alias, PROBE_SENTINEL: String(marker.sentinel.pid), PROBE_READY: path.join(hidden ? alias : stateDir, "state.lock", "sentinel-ready.json"),
      PROBE_WRONG: wrong, PROBE_HIDDEN: hidden ? "1" : "0", PROBE_FD_MODE: mode, PROBE_AUDIT: audit,
      PROBE_INJECT_PHASE: markerKind === "old" ? "enumeration" : "barrier" };
    const args = [process.execPath, "--input-type=module", "-e", source];
    const result = spawnSync(hidden ? "unshare" : process.execPath, hidden ? ["--mount", "--", ...args] : args.slice(1), { env, encoding: "utf8", timeout: 15000 });
    if (hidden && result.error?.code === "ENOENT") return t.skip("unshare is unavailable");
    assert.equal(result.error, undefined, result.error?.message);
    if (hidden && result.status !== 0 && /^unshare:.*(?:operation not permitted|permission denied)/im.test(result.stderr)) return t.skip(`mount namespace unavailable: ${result.stderr.trim()}`);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim());
    if (observed.skip) return t.skip(`mount capability unavailable: ${observed.skip.trim()}`);
    assert.equal(observed.originalVisible, !hidden);
    if (hidden) assert.notEqual(observed.namespace, observed.sentinelNamespace, "the observer must use a different mount namespace");
    else assert.equal(observed.namespace, observed.sentinelNamespace);
    if (mode !== "actual") {
      const calls = fs.readFileSync(audit, "utf8").trim().split("\n");
      assert.ok(calls.includes("seen:enumeration:1"), "the ready FD enumeration must run");
      const phase = markerKind === "old" ? "enumeration" : "barrier", index = markerKind === "old" ? 1 : 2;
      assert.ok(calls.includes(`seen:${phase}:${index}`), `the ${phase} observation must run`);
      assert.ok(calls.includes(`injected:${mode}:${phase}:${index}`), `the ${mode} fault must fire at ${phase}`);
      if (markerKind === "old") assert.equal(calls.some(line => line.startsWith("seen:barrier:")), false, "legacy markers must not inspect FD 3 as a barrier");
    }
    assert.equal(observed.accepted, expected, `${hidden} ${mode}: ${observed.error}`);
    assert.equal(observed.entered, expected, `${hidden} ${mode}: callback result`);
    } finally { fs.writeFileSync(markerPath, originalMarker); }
    });
  }
});

// ready は実際の名前を FIFO に差し替える。directory 同期は保持 FD により名前の差替えを
// 通常は追わないため、open 境界で FIFO パスを注入し、拒否と非停止を確認する。
for (const targetKind of ["ready read", "directory sync"]) {
  test(`Linux sentinel ${targetKind} rejects a FIFO replacement without blocking`, { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 15000 }, async t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(root), "sentinel-fifo-"));
    const stateDir = path.join(dir, "state"), lockDir = path.join(stateDir, "state.lock");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const lock = await import(lockModule);
    let initialized = false, owner, closed;
    const target = targetKind === "ready read" ? path.join(lockDir, "sentinel-ready.json") : lockDir;
    const fifo = path.join(dir, "staged-fifo"), saved = path.join(dir, "saved-original"), retainedFifo = path.join(dir, "retained-fifo");
    const replaced = path.join(dir, "replaced"), preload = path.join(dir, "fifo-preload.cjs");
    let before;
    const restore = () => {
      if (!fs.existsSync(saved)) return;
      const stat = fs.lstatSync(saved, { bigint: true });
      assert.equal(stat.dev, before.dev); assert.equal(stat.ino, before.ino);
      if (fs.existsSync(target)) {
        assert.ok(fs.lstatSync(target).isFIFO(), "only the fixture FIFO may be moved aside");
        assert.equal(fs.existsSync(retainedFifo), false);
        fs.renameSync(target, retainedFifo);
      }
      fs.renameSync(saved, target);
    };
    t.after(async () => {
      if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      if (closed) await closed;
      restore();
      if (initialized) lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      t.diagnostic(`Isolated fixture retained: ${dir}`);
    });
    if (targetKind === "ready read") {
      try { migrateFixtureLock(lock, stateDir); }
      finally {
        initialized = fs.existsSync(path.join(lockDir, "protocol.json")) && fs.existsSync(path.join(lockDir, "sentinel-ready.json"));
      }
    } else fs.mkdirSync(lockDir, { mode: 0o700 });
    before = fs.lstatSync(target, { bigint: true });
    assert.equal(fs.existsSync(saved), false); assert.equal(fs.existsSync(retainedFifo), false);
    const made = spawnSync("mkfifo", ["-m", "600", fifo], { encoding: "utf8", timeout: 3000 });
    assert.equal(made.error, undefined, made.error?.message); assert.equal(made.status, 0, made.stderr);
    assert.ok(fs.lstatSync(fifo).isFIFO());
    fs.writeFileSync(preload, `
const fs=require('node:fs'),path=require('node:path'),{syncBuiltinESMExports}=require('node:module');
 const open=fs.openSync;
 const real=file=>{try{return fs.realpathSync.native(file)}catch{return null}};
fs.openSync=function(file,...args){
  if(typeof file==='string'&&real(file)!==null&&real(file)===real(process.env.PROBE_FIFO_TARGET)&&fs.existsSync(process.env.PROBE_FIFO_STAGE)){
   const target=process.env.PROBE_FIFO_TARGET;
   fs.renameSync(target,process.env.PROBE_FIFO_SAVED);fs.renameSync(process.env.PROBE_FIFO_STAGE,target);
   if(process.env.PROBE_FIFO_KIND==='directory sync'){
    const pinned=fs.statSync(file,{bigint:true}),saved=fs.statSync(process.env.PROBE_FIFO_SAVED,{bigint:true});
    if(pinned.dev!==saved.dev||pinned.ino!==saved.ino||!fs.lstatSync(target).isFIFO())throw new Error('directory FD did not retain its original identity');
   }
   fs.writeFileSync(process.env.PROBE_FIFO_REPLACED,process.env.PROBE_FIFO_KIND);
   if(process.env.PROBE_FIFO_KIND==='directory sync')return open.call(this,target,...args);
 }
 return open.call(this,file,...args);
};syncBuiltinESMExports();
`);
    const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, PROBE_FIFO_TARGET: target,
      PROBE_FIFO_STAGE: fifo, PROBE_FIFO_SAVED: saved, PROBE_FIFO_REPLACED: replaced, PROBE_FIFO_KIND: targetKind, PROBE_STATE: stateDir };
    if (targetKind === "ready read") {
      const source = `import {inspectPosixStateLockScope,withPosixStateLock} from ${JSON.stringify(lockModule)};
const scope=inspectPosixStateLockScope(process.env.PROBE_STATE);let entered=false,error;const started=performance.now();
try{withPosixStateLock(process.env.PROBE_STATE,scope,()=>{entered=true},{timeoutMs:100})}catch(e){error=e.message}
console.log(JSON.stringify({entered,error,elapsed:performance.now()-started}));`;
      owner = spawn(process.execPath, ["--input-type=module", "-e", source], { env, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const generation = randomUUID(), nonce = randomBytes(16).toString("hex");
      const barrierFd = fs.openSync(lockDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { owner = spawn(process.execPath, [sentinelScript, "sentinel", lockDir, generation, nonce], { env, stdio: ["pipe", "pipe", "pipe", barrierFd] }); }
      finally { fs.closeSync(barrierFd); }
      owner.stdin.on("error", () => {});
      let started = false, startup = "";
      owner.stdout.on("data", data => {
        startup += data.toString();
        if (!started && startup.includes("started\n")) { started = true; owner.stdin.write(`commit:${nonce}`); }
      });
    }
    let stdout = "", stderr = "";
    owner.stdout.on("data", data => { stdout += data; });
    owner.stderr.on("data", data => { stderr += data; });
    closed = new Promise((resolve, reject) => { owner.once("error", reject); owner.once("close", (code, signal) => resolve({ code, signal })); });
    let expired = false;
    const watchdog = setTimeout(() => { expired = true; owner.kill("SIGKILL"); }, 2000);
    let result;
    try { result = await closed; }
    finally { clearTimeout(watchdog); restore(); }
    assert.equal(fs.existsSync(replaced), true, "FIFO must replace the checked target immediately before open");
    assert.equal(fs.readFileSync(replaced, "utf8"), targetKind, "the requested injection must run");
    assert.equal(expired, false, "sentinel open blocked on the FIFO past the child timeout");
    if (targetKind === "ready read") {
      assert.equal(result.code, 0, stderr);
      const output = JSON.parse(stdout);
      assert.equal(output.entered, false); assert.match(output.error, /sentinel|identity|invalid|lock/i);
      assert.ok(output.elapsed < 2000);
    } else {
      assert.notEqual(result.code, 0, "sentinel must refuse the replaced directory");
      assert.equal(stdout.includes("ready\n"), false);
    }
  });
}

for (const mode of ["marker-fsync", "after-link", "directory-fsync", "after-ready"]) {
  test(`sentinel initialization fails safely on ${mode}`, { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(root), "sentinel-crash-"));
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const lockDir = path.join(stateDir, "state.lock");
    let marker;
    const alive = () => {
      if (!Number.isSafeInteger(marker?.sentinel?.pid)) return false;
      try {
        const text = fs.readFileSync(`/proc/${marker.sentinel.pid}/stat`, "utf8");
        const match = text.match(/^([1-9]\d*) \((.*)\) ([A-Za-z]) (.*)$/s);
        if (!match) throw new Error("invalid sentinel stat");
        return !["Z", "X", "x"].includes(match[3]) && match[4].trim().split(/\s+/)[18] === marker.sentinel.startTick;
      } catch (error) { if (error?.code === "ENOENT" || error?.code === "ESRCH") return false; throw error; }
    };
    t.after(async () => {
      if (!marker && fs.existsSync(lockDir)) {
        const name = fs.readdirSync(lockDir).find(value => /^prepared-.*\.json$/.test(value));
        if (name) try { marker = JSON.parse(fs.readFileSync(path.join(lockDir, name), "utf8")); } catch { /* 状態を保全する。 */ }
      }
      if (!Number.isSafeInteger(marker?.sentinel?.pid)) {
        await new Promise(resolve => setTimeout(resolve, 5500));
        throw new Error(`sentinel identity unavailable; retained ${dir}`);
      }
      const lock = await import(lockModule);
      if (mode === "after-ready" && alive()) {
        lock.readPosixStateLockProtocol(lockDir, lock.inspectPosixStateLockScope(stateDir));
        await lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      }
      for (let i = 0; i < 300 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(), false, `sentinel remained alive; retained ${dir}`);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const preload = path.join(dir, "failure.cjs");
    fs.writeFileSync(preload, `
const fs=require('node:fs'), {syncBuiltinESMExports}=require('node:module');
if (process.argv[2]==='bootstrap') {
 const mode=process.env.PROBE_FAILURE, originalSync=fs.fsyncSync, originalLink=fs.linkSync;
 const audit=()=>fs.writeFileSync(process.env.PROBE_AUDIT,mode);
 fs.fsyncSync=function(fd) {
  if ((mode==='marker-fsync' && fd===4) || (mode==='directory-fsync' && fs.fstatSync(fd).isDirectory())) { audit(); throw Object.assign(new Error('injected fsync failure'),{code:'EIO'}); }
  return originalSync.apply(this,arguments);
 };
 fs.linkSync=function() { const value=originalLink.apply(this,arguments); if(mode==='after-link'){audit();process.exit(73);} return value; };
 if(mode==='after-ready')process.stdout.write=()=>{audit();process.exit(74);};
 syncBuiltinESMExports();
}
`);
    const source = `${migrationImport}try{${migrationCall};process.exit(2)}catch{process.exit(0)}`;
    const audit = path.join(dir, "failure-triggered");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, PROBE_STATE: stateDir, PROBE_FAILURE: mode, PROBE_AUDIT: audit }, encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(audit, "utf8"), mode, "the requested initialization fault must fire");
    const prepared = fs.readdirSync(lockDir).find(name => /^prepared-.*\.json$/.test(name));
    assert.ok(prepared, "migration did not create the prepared marker");
    marker = JSON.parse(fs.readFileSync(path.join(lockDir, prepared), "utf8"));
    assert.ok(Number.isSafeInteger(marker.sentinel?.pid));
    const lock = await import(lockModule);
    if (mode === "after-ready") {
      assert.ok(lock.readPosixStateLockProtocol(lockDir, lock.inspectPosixStateLockScope(stateDir)));
    } else {
      assert.throws(() => lock.readPosixStateLockProtocol(lockDir, lock.inspectPosixStateLockScope(stateDir)));
      for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(), false, "uncommitted sentinel survived initialization failure");
    }
  });
}

for (const outcome of ["success", "failure"]) {
  test(`ready remains unaccepted during its fsync and after ${outcome}`, { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(root), "sentinel-ready-race-"));
    const stateDir = path.join(dir, "state");
    const lockDir = path.join(stateDir, "state.lock");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const preload = path.join(dir, "ready-pause.cjs");
    fs.writeFileSync(preload, `
const fs=require('node:fs'), {syncBuiltinESMExports}=require('node:module');
if(process.argv[2]==='sentinel') {
 const original=fs.fsyncSync, sleep=new Int32Array(new SharedArrayBuffer(4));
 fs.fsyncSync=function(fd) {
  let target='';try{target=fs.readlinkSync('/proc/self/fd/'+fd)}catch{}
  if(target.endsWith('/sentinel-ready.json')) {
   fs.writeFileSync(process.env.PROBE_GATE+'/paused','paused');
   const deadline=Date.now()+8000;
   while(!fs.existsSync(process.env.PROBE_GATE+'/release') && Date.now()<deadline) Atomics.wait(sleep,0,0,10);
   if(!fs.existsSync(process.env.PROBE_GATE+'/release') || process.env.PROBE_READY_OUTCOME==='failure') {
    fs.writeFileSync(process.env.PROBE_GATE+'/failed',fs.existsSync(process.env.PROBE_GATE+'/release')?'requested':'timeout');
    throw Object.assign(new Error('injected ready fsync failure'),{code:'EIO'});
   }
  }
  return original.apply(this,arguments);
 };
 syncBuiltinESMExports();
}
`);
    const source = `${migrationImport}try{${migrationCall};process.exit(0)}catch{process.exit(2)}`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, PROBE_STATE: stateDir, PROBE_GATE: dir, PROBE_READY_OUTCOME: outcome }, stdio: ["ignore", "ignore", "ignore"] });
    const closed = new Promise(resolve => owner.once("close", resolve));
    const alive = sentinel => {
      try {
        const text = fs.readFileSync(`/proc/${sentinel.pid}/stat`, "utf8");
        const match = text.match(/^([1-9]\d*) \((.*)\) ([A-Za-z]) (.*)$/s);
        if (!match) throw new Error("invalid sentinel stat");
        return !["Z", "X", "x"].includes(match[3]) && match[4].trim().split(/\s+/)[18] === sentinel.startTick;
      } catch (error) { if (error?.code === "ENOENT" || error?.code === "ESRCH") return false; throw error; }
    };
    t.after(async () => {
      if (!fs.existsSync(path.join(dir, "release"))) fs.writeFileSync(path.join(dir, "release"), "release");
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 9000))]);
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGKILL"); await closed; }
      const markerPath = path.join(lockDir, "protocol.json");
      if (!fs.existsSync(markerPath)) throw new Error(`sentinel marker unavailable; retained ${dir}`);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      assert.ok(Number.isSafeInteger(marker.sentinel?.pid));
      const lock = await import(lockModule);
      if (outcome === "success" && alive(marker.sentinel)) {
        lock.readPosixStateLockProtocol(lockDir, lock.inspectPosixStateLockScope(stateDir));
        lock.shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      }
      for (let i = 0; i < 300 && alive(marker.sentinel); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(marker.sentinel), false, `sentinel remained alive; retained ${dir}`);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    for (let i = 0; i < 250 && !fs.existsSync(path.join(dir, "paused")); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(path.join(dir, "paused")), true, "sentinel did not reach ready fsync");
    const lock = await import(lockModule);
    const scope = lock.inspectPosixStateLockScope(stateDir);
    assert.throws(() => lock.readPosixStateLockProtocol(lockDir, scope));
    fs.writeFileSync(path.join(dir, "release"), "release");
    assert.equal(await closed, outcome === "success" ? 0 : 2);
    if (outcome === "failure") assert.equal(fs.readFileSync(path.join(dir, "failed"), "utf8"), "requested", "the requested ready fsync failure must fire");
    else assert.equal(fs.existsSync(path.join(dir, "failed")), false);
    if (outcome === "success") assert.ok(lock.readPosixStateLockProtocol(lockDir, scope));
    else assert.throws(() => lock.readPosixStateLockProtocol(lockDir, scope));
  });
}

// 先行失敗条件: 同一 boot 中に namespace inode が再利用され、旧 marker が別世代で受理される。
// namespace の終了は、このテストが起動した PID 1 の stdin gate と child close で確認する。
test("a reused PID namespace inode cannot adopt an old state marker", { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 120000 }, async t => {
  const base = fs.realpathSync(root);
  const support = spawnSync("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", "mount -t proc proc /proc"], { encoding: "utf8" });
  if (support.status !== 0) return t.skip(`PID/mount namespace unavailable: ${support.stderr?.trim() || support.error?.message || "unknown error"}`);
  const dir = fs.mkdtempSync(path.join(base, "pidns-reuse-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  let owner;
  t.after(async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      owner.stdin.end();
      await new Promise(resolve => owner.once("close", resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const shell = 'mount -t proc proc /proc && exec "$@"';
  const writer = `import fs from 'node:fs';${migrationImport}${migrationCall};console.log(JSON.stringify({namespace:fs.readlinkSync('/proc/self/ns/pid'),pid:process.pid,boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
  owner = spawn("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", shell, "probe", process.execPath, "--input-type=module", "-e", writer], { env: { ...process.env, PROBE_STATE: stateDir }, stdio: ["pipe", "pipe", "pipe"] });
  const first = await new Promise((resolve, reject) => {
    let out = "", err = "";
    owner.stderr.on("data", data => { err += data; });
    owner.stdout.on("data", data => { out += data; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); });
    owner.once("error", reject); owner.once("exit", code => reject(new Error(`namespace owner exited before ready: ${code} ${err}`)));
  });
  assert.equal(first.pid, 1);
  const closed = new Promise(resolve => owner.once("close", resolve));
  owner.stdin.end();
  assert.equal(await closed, 0);
  const observer = `import fs from 'node:fs';import {inspectPosixStateLockScope,readPosixStateLockProtocol} from ${JSON.stringify(lockModule)};const result={namespace:fs.readlinkSync('/proc/self/ns/pid'),boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};if(result.namespace===process.env.PROBE_NS){try{readPosixStateLockProtocol(process.env.PROBE_STATE+'/state.lock',inspectPosixStateLockScope(process.env.PROBE_STATE));result.marker='accepted';}catch{result.marker='rejected';}}console.log(JSON.stringify(result));`;
  let reused;
  for (let i = 0; i < 256; i++) {
    const child = spawnSync("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", shell, "probe", process.execPath, "--input-type=module", "-e", observer], { env: { ...process.env, PROBE_STATE: stateDir, PROBE_NS: first.namespace }, encoding: "utf8", timeout: 15000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    if (result.namespace === first.namespace) { reused = result; break; }
  }
  if (!reused) return t.skip("namespace inode was not reused within 256 isolated attempts");
  assert.equal(reused.boot, first.boot);
  assert.equal(reused.marker, "rejected", JSON.stringify({ first, reused }));
});

// 先行失敗条件: 旧 namespace の消滅後、別世代が同じ socket を使い始めたのに、
// inode 再利用と過去の shutdown ACK により生存 socket が旧 broker の回収対象となる。
test("reused namespace cannot clean up a replacement broker socket", { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 120000 }, async t => {
  const base = fs.realpathSync(root);
  const support = spawnSync("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", "mount -t proc proc /proc"], { encoding: "utf8" });
  if (support.status !== 0) return t.skip(`PID/mount namespace unavailable: ${support.stderr?.trim() || support.error?.message || "unknown error"}`);
  const dir = fs.mkdtempSync(path.join(base, "pidns-broker-"));
  const sessionDir = fs.mkdtempSync(path.join(base, "gkc-"));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const socketPath = path.join(sessionDir, "broker.sock");
  const env = { ...process.env, TMPDIR: base, TMP: base, TEMP: base, CLAUDE_PLUGIN_DATA: path.join(dir, "plugin-data"), PROBE_WORKSPACE: workspace, PROBE_DIR: sessionDir, PROBE_SOCKET: socketPath };
  delete env.PLUGIN_DATA;
  const shell = 'mount -t proc proc /proc && exec "$@"';
  let owner, replacement;
  t.after(async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) { owner.stdin.end(); await new Promise(resolve => owner.once("close", resolve)); }
    if (replacement?.listening) await new Promise(resolve => replacement.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  const broker = `const net=require('node:net');const server=net.createServer(c=>c.end('old'));server.listen(process.env.PROBE_SOCKET,()=>console.log('ready'));process.stdin.resume();process.stdin.on('end',()=>server.close());`;
  const writer = `import fs from 'node:fs';import {spawn} from 'node:child_process';import {migrateStateLock,resolveStateDir} from ${JSON.stringify(stateModule)};import {saveBrokerSession,resolveBrokerStateDir} from ${JSON.stringify(brokerModule)};
const cwd=process.env.PROBE_WORKSPACE,dir=process.env.PROBE_DIR;const marker=migrateStateLock(cwd,{offlineConfirmed:true,localOnly:true,expectedStateDir:resolveStateDir(cwd)});
const c=spawn(process.execPath,['-e',${JSON.stringify(broker)}],{detached:true,stdio:['pipe','pipe','inherit']});let out='';c.stdout.on('data',d=>{out+=d;if(!out.includes('\\n'))return;c.stdout.removeAllListeners('data');const generation='old-fixture-generation';const session={generation,epoch:marker.epoch,pid:c.pid,endpoint:'unix:'+process.env.PROBE_SOCKET,sessionDir:dir,pidFile:dir+'/broker.pid',logFile:dir+'/broker.log',ownedGroup:{pgid:c.pid,generation,platform:'linux'},shutdownAcceptedGeneration:generation};fs.writeFileSync(session.pidFile,String(c.pid));fs.writeFileSync(session.logFile,'old');saveBrokerSession(cwd,session);
const journal=resolveBrokerStateDir(cwd)+'/broker-admission.jsonl';const records=[{event:'pending',ownerPid:process.pid,platform:'linux',lockToken:'fixture',endpoint:session.endpoint,sessionDir:dir,pidFile:session.pidFile,logFile:session.logFile},{event:'spawned',pid:c.pid,pgid:c.pid},{event:'settled',pid:c.pid,outcome:'ready'},{event:'confirmed',pid:c.pid,outcome:'ready'}].map(r=>JSON.stringify({version:2,generation,epoch:marker.epoch,...r})).join('\\n')+'\\n';fs.writeFileSync(journal,records,{mode:0o600});
console.log(JSON.stringify({namespace:fs.readlinkSync('/proc/self/ns/pid'),boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:c.pid,session}));});process.stdin.resume();process.stdin.on('end',()=>c.stdin.end());c.on('close',code=>process.exit(code??1));`;
  owner = spawn("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", shell, "probe", process.execPath, "--input-type=module", "-e", writer], { env, stdio: ["pipe", "pipe", "pipe"] });
  const first = await new Promise((resolve, reject) => {
    let out = "", err = "";
    owner.stderr.on("data", data => { err += data; });
    owner.stdout.on("data", data => { out += data; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); });
    owner.once("error", reject); owner.once("exit", code => reject(new Error(`broker owner exited before ready: ${code} ${err}`)));
  });
  assert.ok(first.pid > 1);
  const closed = new Promise(resolve => owner.once("close", resolve));
  owner.stdin.end(); assert.equal(await closed, 0);
  assert.equal(fs.existsSync(socketPath), false);
  replacement = net.createServer(client => client.end("replacement"));
  await new Promise((resolve, reject) => { replacement.once("error", reject); replacement.listen(socketPath, resolve); });
  const reply = await new Promise((resolve, reject) => { const client = net.connect(socketPath); client.on("data", data => resolve(data.toString())); client.on("error", reject); });
  assert.equal(reply, "replacement");
  const observer = `import fs from 'node:fs';import {cleanupIdleBrokerSession,ensureBrokerSession,loadBrokerSession} from ${JSON.stringify(brokerModule)};const result={namespace:fs.readlinkSync('/proc/self/ns/pid'),boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};if(result.namespace===process.env.PROBE_NS){const s=JSON.parse(process.env.PROBE_SESSION);try{result.loaded=loadBrokerSession(process.env.PROBE_WORKSPACE)?.generation??null;}catch(e){result.loadError=e.message;}try{result.adopted=(await ensureBrokerSession(process.env.PROBE_WORKSPACE,{timeoutMs:3000,env:{}}))?.generation??null;}catch(e){result.adoptionError=e.message;}try{result.cleaned=await cleanupIdleBrokerSession(process.env.PROBE_WORKSPACE,s,{timeoutMs:1800});}catch(e){result.error=e.message;}result.socketExists=fs.existsSync(process.env.PROBE_SOCKET);}console.log(JSON.stringify(result));`;
  let reused;
  for (let i = 0; i < 256; i++) {
    const child = spawnSync("unshare", ["-m", "-p", "-f", "/bin/sh", "-c", shell, "probe", process.execPath, "--input-type=module", "-e", observer], { env: { ...env, PROBE_NS: first.namespace, PROBE_SESSION: JSON.stringify(first.session) }, encoding: "utf8", timeout: 15000 });
    assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    if (result.namespace === first.namespace) { reused = result; break; }
  }
  if (!reused) return t.skip("namespace inode was not reused within 256 isolated attempts");
  assert.equal(reused.boot, first.boot);
  await t.test("replacement endpoint is not adopted as the old generation", () => {
    assert.match(reused.loadError ?? "", /sentinel|namespace/i, JSON.stringify({ first, reused }));
    assert.match(reused.adoptionError ?? "", /sentinel|namespace/i, JSON.stringify({ first, reused }));
    assert.notEqual(reused.loaded, "old-fixture-generation", JSON.stringify({ first, reused }));
    assert.notEqual(reused.adopted, "old-fixture-generation", JSON.stringify({ first, reused }));
  });
  await t.test("replacement endpoint is not removed by old cleanup", async () => {
    assert.equal(reused.socketExists, true, JSON.stringify({ first, reused }));
    assert.match(reused.error ?? "", /sentinel|namespace/i, JSON.stringify({ first, reused }));
    assert.notEqual(reused.cleaned, true, JSON.stringify({ first, reused }));
    const reply = await new Promise((resolve, reject) => {
      const client = net.connect(socketPath);
      client.on("data", data => resolve(data.toString()));
      client.on("error", reject);
    });
    assert.equal(reply, "replacement");
  });
});
