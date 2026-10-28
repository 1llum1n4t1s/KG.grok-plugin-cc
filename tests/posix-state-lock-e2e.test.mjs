import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { linuxSentinelExited, sentinelScript } from "../plugins/grok/scripts/lib/linux-state-sentinel.mjs";

// 先行失敗条件: 明示確認/expected保存先の欠落・不一致、旧regular lockの破壊、
// 未移行writerの副作用、並行RMW/aliasの排他漏れ、保持中timeout、owner SIGKILL、
// detached子へのlock FD継承、lock/marker差替え、utility欠落/停止、不正marker。
// Windowsはfixture作成前にskipする。実利用者stateや他テストのrootは使わない。
// 公開APIを実子processから呼ぶ。utility故障だけは専用preloadで境界に注入する。
const posixOnly = { skip: !["darwin", "linux"].includes(process.platform) ? "POSIX state-lock E2E only" : false };
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
const posixModule = new URL("../plugins/grok/scripts/lib/posix-state-lock.mjs", import.meta.url).href;
const repository = fileURLToPath(new URL("../", import.meta.url));

const utilityPreload = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const {syncBuiltinESMExports}=require('node:module');
const mkdir=fs.mkdirSync;
fs.mkdirSync=function(target,...args){
  if(process.platform==='linux'&&process.env.GROK_POSIX_CRASH_INITIAL_GUARD&&
      path.basename(String(target))==='linux-epoch-recovery-v1'&&
      fs.existsSync(path.join(process.env.GROK_POSIX_LOCK_STATE_DIR,'state.lock','protocol.json')))process.exit(74);
  return mkdir.call(this,target,...args);
};
const link=fs.linkSync;
fs.linkSync=function(source,target){
  if(process.platform==='linux'&&path.basename(String(target))==='protocol.json'&&process.env.GROK_POSIX_SENTINEL_AUDIT){
    const marker=JSON.parse(fs.readFileSync(source,'utf8'));
    if(marker.sentinel)fs.appendFileSync(process.env.GROK_POSIX_SENTINEL_AUDIT,JSON.stringify(marker.sentinel)+'\n',{mode:0o600});
  }
  return link.apply(this,arguments);
};
const opened=new Map(),open=fs.openSync;
// procfs の descriptor 経由と通常パスを同じ実体名へ解決する。失敗時は一致させない。
const real=file=>{try{return fs.realpathSync.native(file)}catch{return null}};
const fdPath=fd=>process.platform==='linux'?real('/proc/self/fd/'+fd):opened.get(fd)||null;
fs.openSync=function(file,...args){
  const target=process.env.GROK_POSIX_FIFO_TARGET;
  if(target&&typeof file==='string'&&real(file)!==null&&real(file)===real(target)&&fs.existsSync(process.env.GROK_POSIX_FIFO_STAGE)){
    fs.renameSync(target,process.env.GROK_POSIX_FIFO_ORIGINAL);
    fs.renameSync(process.env.GROK_POSIX_FIFO_STAGE,target);
    fs.writeFileSync(process.env.GROK_POSIX_FIFO_REPLACED,'replaced');
  }
  const fd=open.call(this,file,...args);opened.set(fd,real(String(file))||String(file));return fd;
};
const fsync=fs.fsyncSync;let delayed=false,gated=false;
fs.fsyncSync=function(fd){
  const kind=process.env.GROK_POSIX_LOCK_FAIL_DIR_FSYNC,state=process.env.GROK_POSIX_LOCK_STATE_DIR;
  const target=fdPath(fd),barrier=state?path.join(state,'state.lock'):null;
  const marker=barrier?path.join(barrier,'protocol.json'):null;
  if(!delayed&&process.env.GROK_POSIX_LOCK_DELAY_DIR_FSYNC&&state&&(target===state||target===barrier)){
    delayed=true;fs.appendFileSync(process.env.GROK_POSIX_LOCK_DELAY_ATTEMPT,'delayed\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.GROK_POSIX_LOCK_DELAY_DIR_FSYNC));
  }
  if(!gated&&process.env.GROK_POSIX_LOCK_GATE_DIR_FSYNC&&target===barrier&&fs.existsSync(marker)){
    gated=true;const gate=process.env.GROK_POSIX_LOCK_GATE_DIR_FSYNC;
    fs.writeFileSync(gate+'.held',String(process.pid));const deadline=Date.now()+10000;
    while(!fs.existsSync(gate+'.release')){if(Date.now()>=deadline)throw new Error('directory fsync gate expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  }
  const reject=kind&&state&&((kind==='state-dir'&&target===state)||
    (kind==='lock-dir-before-marker'&&target===barrier&&!fs.existsSync(marker))||
    (kind==='lock-dir-after-marker'&&target===barrier&&fs.existsSync(marker)));
  if(reject){fs.appendFileSync(process.env.GROK_POSIX_LOCK_FSYNC_ATTEMPTS,kind+'\n');throw Object.assign(new Error('isolated directory fsync failure'),{code:'EIO'});}
  return fsync.call(this,fd);
};
const stat=fs.statSync;
fs.statSync=function(target,...args){
  if(process.env.GROK_POSIX_LOCK_FOREIGN_MOUNT&&String(target)===process.env.GROK_POSIX_LOCK_FOREIGN_MOUNT){
    fs.appendFileSync(process.env.GROK_POSIX_LOCK_FOREIGN_TOUCH,'touched\n');
    throw new Error('isolated unrelated network mount is unavailable');
  }return stat.call(this,target,...args);
};
if(fs.statfsSync){const statfs=fs.statfsSync;fs.statfsSync=function(target,...args){
  const value=statfs.call(this,target,...args),root=process.env.GROK_POSIX_LOCK_FAKE_FS_ROOT;
  if(process.env.GROK_POSIX_LOCK_FAKE_FS&&root&&(String(target)===root||String(target).startsWith(root+path.sep))){
    const type=process.env.GROK_POSIX_LOCK_FAKE_FS==='network'?0x6969:0xdeadbeef;
    return {...value,type:typeof value.type==='bigint'?BigInt(type):type};
  }return value;
};}
for(const name of ['spawn','spawnSync','execFile','execFileSync']){
  const original=cp[name];
  cp[name]=function(command,args=[],options={}){
    const utility=path.basename(String(command));
    if(process.platform==='darwin'&&String(command)==='/sbin/mount'&&process.env.GROK_POSIX_LOCK_FOREIGN_MOUNT){
      const output=original.call(this,command,args,options);
      return String(output)+'isolated-server:/offline on '+process.env.GROK_POSIX_LOCK_FOREIGN_MOUNT+' (nfs, nosuid)\n';
    }
    if(process.platform==='darwin'&&String(command)==='/sbin/mount'&&process.env.GROK_POSIX_LOCK_FAKE_FS){
      const type=process.env.GROK_POSIX_LOCK_FAKE_FS==='network'?'nfs':'isolated-unknown';
      return 'isolated-source on '+process.env.GROK_POSIX_LOCK_FAKE_FS_ROOT+' ('+type+', local)\n';
    }
    if(utility==='flock'||utility==='lockf'){
      const number=Number(args[args.length-1]),mapped=options.stdio?.[number];
      const inherited=typeof mapped==='number'?mapped:number;
      fs.appendFileSync(process.env.GROK_POSIX_LOCK_AUDIT,JSON.stringify({pid:process.pid,at:performance.now(),utility,args,lockPath:fdPath(inherited),extraFds:(options.stdio||[]).slice(3).length})+'\n');
      if(process.env.GROK_POSIX_LOCK_DENY_UTILITY){const e=Object.assign(new Error('isolated utility unavailable'),{code:'ENOENT'});throw e;}
      if(process.env.GROK_POSIX_LOCK_STALL_UTILITY){
        return original.call(this,process.execPath,['-e','setTimeout(()=>{},10000)'],options);
      }
    }
    return original.call(this,command,args,options);
  };
}
syncBuiltinESMExports();
`;

function fixture(t) {
  assert.ok(["darwin", "linux"].includes(process.platform));
  const parent = fs.realpathSync.native(process.env.GROK_POSIX_STATE_LOCK_TEST_ROOT || os.tmpdir());
  assert.ok(path.isAbsolute(parent));
  assert.ok(path.relative(repository, parent).startsWith(`..${path.sep}`), "fixture parent must be outside the repository");
  for (let cursor = parent; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `unsafe fixture ancestor: ${cursor}`);
    if (path.dirname(cursor) === cursor) break;
  }
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-posix-lock-e2e-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const directory of [workspace, data, temp]) fs.mkdirSync(directory);
  const preload = path.join(root, "utility-audit.cjs"), audit = path.join(root, "utility.jsonl"), sentinelAudit = path.join(root, "sentinels.jsonl");
  fs.writeFileSync(preload, utilityPreload);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, TMPDIR: temp, TEMP: temp, TMP: temp,
    GIT_OPTIONAL_LOCKS: "0", GROK_POSIX_LOCK_AUDIT: audit, GROK_POSIX_SENTINEL_AUDIT: sentinelAudit, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") delete env[key];
  // 外部 GIT_* を除去した後も system/global 設定を読まない。
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  const f = { root, workspace, data, env, audit, sentinelAudit, children: new Set(), detached: [], uncertain: false, markerDamaged: false };
  t.diagnostic(`Isolated POSIX fixture: ${root}`);
  t.after(async () => {
    for (const child of f.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed(child);
    }
    for (const detached of f.detached) {
      assert.ok(detached.identity || process.platform !== "linux", `detached child ownership unconfirmed; retained ${root}`);
      fs.writeFileSync(detached.release, "release");
      await until(() => fs.existsSync(detached.ack), "detached child exit acknowledgement");
      if (process.platform === "linux") await until(() => linuxSentinelExited(detached.identity), "detached child exit");
    }
    assert.equal(f.uncertain, false, `worker termination unconfirmed; retained ${root}`);
    if (process.platform === "linux" && fs.existsSync(sentinelAudit)) {
      const sentinels = fs.readFileSync(sentinelAudit, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const markerPath = path.join(f.stateDir, "state.lock", "protocol.json");
      let marker;
      try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch {}
      for (const sentinel of sentinels) {
        assert.ok(Number.isSafeInteger(sentinel.pid) && sentinel.pid > 0 && /^[1-9]\d*$/.test(sentinel.startTick) &&
          /^[0-9a-f-]{36}$/.test(sentinel.generation) && /^[0-9a-f]{32}$/.test(sentinel.nonce), `invalid owned sentinel identity; retained ${root}`);
        if (linuxSentinelExited(sentinel)) continue;
        if (!f.markerDamaged && !fs.existsSync(path.join(f.stateDir, "state.lock", "sentinel-ready.json"))) {
          // 公開途中で bootstrap が失敗した場合、未 commit の sentinel は自ら終了する。
          await until(() => linuxSentinelExited(sentinel), `uncommitted sentinel exit unconfirmed; retained ${root}`);
          continue;
        }
        if (marker?.sentinel?.generation === sentinel.generation && marker.sentinel.nonce === sentinel.nonce) {
          try {
            assert.equal(shutdownPosixStateLockSentinel(f.stateDir, { offlineConfirmed: true, expectedStateDir: f.stateDir }).stopped, true);
            continue;
          } catch (error) {
            if (!f.markerDamaged) throw error;
          }
        }
        assert.equal(f.markerDamaged, true, `sentinel marker unavailable; retained ${root}`);
        // 破損・退避された marker のみ、fixture が公開前に保存した nonce で協調停止する。
        const stopped = spawnSync(process.execPath, [sentinelScript, "stop", sentinel.generation, sentinel.nonce], { encoding: "utf8", timeout: 4000 });
        assert.equal(stopped.status, 0, `owned sentinel stop unconfirmed; retained ${root}`);
        await until(() => linuxSentinelExited(sentinel), `owned sentinel exit unconfirmed; retained ${root}`);
      }
    }
    // このmkdtemp rootだけ。symlink aliasも同じroot内を指す。
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  f.stateDir = run(f, `console.log(JSON.stringify(resolveStateDir(workspace)));`);
  return f;
}

function source(f, body) {
  return `import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
    import {migrateStateLock,resolveStateDir,updateState,withStateSnapshot,loadState} from ${JSON.stringify(stateModule)};
    import {inspectPosixStateLockScope,withPosixStateLock} from ${JSON.stringify(posixModule)};
    const workspace=${JSON.stringify(f.workspace)}; ${body}`;
}
function run(f, body, env = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source(f, body)], {
    cwd: f.workspace, env: { ...f.env, ...env }, encoding: "utf8", timeout: 20000
  });
  if (result.error) f.uncertain = true;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function start(f, body, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source(f, body)], {
    cwd: f.workspace, env: { ...f.env, ...env }, stdio: ["ignore", "pipe", "pipe"]
  });
  f.children.add(child); let stdout = "", stderr = "";
  child.closed = new Promise(resolve => child.once("close", resolve));
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`POSIX worker timed out: ${stderr}`)); }, 20000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return child;
}
async function closed(child) { await child.closed; }
async function until(check, label) {
  const deadline = Date.now() + 6000;
  while (!check()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}
function migrateOnly(f) {
  const result = run(f, `console.log(JSON.stringify(migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}})));`);
  assert.equal(result.localOnly, true);
  assert.equal(result.stateDir, f.stateDir);
  return result;
}
function migrate(f) {
  migrateOnly(f);
  run(f, `updateState(workspace,s=>{s.config.counter=0;s.config.sentinel='original';});console.log('{}');`);
}
const directAdmissionModule = new URL("../plugins/grok/scripts/lib/direct-start-admission.mjs", import.meta.url).href;
function admission(f) {
  return run(f, `const {reserveDirectStart,finishDirectStart}=await import(${JSON.stringify(directAdmissionModule)});
    let entered=false,error,finished=false;try{const token=reserveDirectStart(workspace,()=>{});entered=true;finished=finishDirectStart(workspace,token,'never-started');}catch(e){error=e.message;}
    console.log(JSON.stringify({entered,finished,error}));`);
}
function recoverEpoch(f) {
  const script = path.join(repository, "plugins", "grok", "scripts", "grok-companion.mjs");
  const result = spawnSync(process.execPath, [script, "state-lock", "recover", "--offline-confirmed", "--local-only",
    "--all-old-processes-stopped", "--expected-state-dir", f.stateDir, "--cwd", f.workspace, "--json"],
  { cwd: f.workspace, env: f.env, encoding: "utf8", timeout: 20000 });
  if (result.error) f.uncertain = true;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function epochRecoveryDir(f, epoch) { return path.join(f.stateDir, "linux-epoch-recovery-v1", epoch); }
function metadata(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { bytes: fs.readFileSync(file).toString("base64"), dev: String(stat.dev), ino: String(stat.ino),
    mtime: String(stat.mtimeNs), mode: String(stat.mode), uid: String(stat.uid) };
}
function tree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).map(String).sort().map(name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    return [name, stat.isDirectory() ? "directory" : metadata(file)];
  });
}
async function hold(f, { detached = false } = {}) {
  const ready = path.join(f.root, `ready-${f.children.size}.json`);
  const ownerRelease = path.join(f.root, `owner-release-${f.children.size}`);
  const release = path.join(f.root, "detached-release"), ack = path.join(f.root, "detached-exited");
  const ownedDetached = detached ? { release, ack, identity: null } : null;
  if (ownedDetached) f.detached.push(ownedDetached);
  const detachedSource = `const fs=require('node:fs');const deadline=Date.now()+20000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})||Date.now()>=deadline){try{fs.writeFileSync(${JSON.stringify(ack)},'exiting');}catch{}clearInterval(timer);process.exit(0);}},10);`;
  const child = start(f, `withStateSnapshot(workspace,()=>{
    let detachedPid=null;
    if(${detached}){const c=spawn(process.execPath,['-e',${JSON.stringify(detachedSource)}],{detached:true,stdio:'ignore'});c.unref();detachedPid=c.pid;}
    fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,detachedPid}));
    while(!fs.existsSync(${JSON.stringify(ownerRelease)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  });`);
  await until(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("lock owner exited before entering its callback");
    return fs.existsSync(ready);
  }, "lock owner callback");
  const info = JSON.parse(fs.readFileSync(ready, "utf8"));
  if (ownedDetached && process.platform === "linux") {
    assert.ok(Number.isSafeInteger(info.detachedPid) && info.detachedPid > 0, "detached child PID is unavailable");
    const stat = fs.readFileSync(`/proc/${info.detachedPid}/stat`, "utf8").match(/^[1-9]\d* \(.*\) [A-Za-z] (.*)$/s);
    assert.ok(stat, "detached child identity is unavailable");
    const startTick = stat[1].trim().split(/\s+/)[18];
    assert.match(startTick, /^[1-9]\d*$/, "detached child start time is unavailable");
    ownedDetached.identity = { pid: info.detachedPid, startTick };
  }
  return { child, ownerRelease, ...info };
}
function rejectedUpdate(f, timeoutMs = 150, env = {}) {
  return run(f, `let entered=false,error;const begin=performance.now();try{updateState(workspace,()=>{entered=true;},{timeoutMs:${timeoutMs}});}catch(e){error=e.message;}
    console.log(JSON.stringify({entered,error,elapsed:performance.now()-begin}));`, env);
}

test("POSIX migration requires both offline confirmations and an exact expected state directory", posixOnly, t => {
  const f = fixture(t), before = tree(f.data);
  for (const options of [{}, { offlineConfirmed: true }, { localOnly: true },
    { offlineConfirmed: true, localOnly: true, expectedStateDir: path.join(f.root, "wrong-state") }]) {
    const result = run(f, `let error;try{migrateStateLock(workspace,${JSON.stringify(options)});}catch(e){error=e.message;}console.log(JSON.stringify({error}));`);
    assert.match(result.error, /offline|confirmation|expected.*(?:match|directory)/i);
    assert.deepEqual(tree(f.data), before);
  }
  migrate(f);
});

test("POSIX migration refuses a legacy regular lock without changing bytes, inode or mtime", posixOnly, t => {
  // 正規scope(0700)とscope権限不正(0755)を分け、どちらでも旧lock自体は保全する。
  for (const mode of [0o700, 0o755]) {
    const f = fixture(t); fs.mkdirSync(f.stateDir, { recursive: true, mode }); fs.chmodSync(f.stateDir, mode);
    assert.equal(fs.statSync(f.stateDir).mode & 0o777, mode);
    const lock = path.join(f.stateDir, "state.lock"); fs.writeFileSync(lock, "legacy owner evidence\n", { mode: 0o600 });
    const before = metadata(lock);
    const result = run(f, `let error;try{migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}});}catch(e){error=e.message;}console.log(JSON.stringify({error}));`);
    assert.match(result.error, /legacy.*untouched|legacy.*preserv|offline recovery/i);
    assert.deepEqual(metadata(lock), before);
  }
});

test("unmigrated POSIX updates refuse before callback, state, jobs or lock creation", posixOnly, t => {
  const f = fixture(t), before = tree(f.data), result = rejectedUpdate(f);
  assert.equal(result.entered, false); assert.match(result.error, /explicit.*migration/i);
  assert.deepEqual(tree(f.data), before);
});

test("POSIX migrated RMW operations serialize across independent processes", posixOnly, async t => {
  const f = fixture(t); migrate(f);
  const workers = Array.from({ length: 3 }, () => start(f, `for(let i=0;i<6;i++)updateState(workspace,s=>{
    const n=s.config.counter;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);s.config.counter=n+1;
  },{timeoutMs:5000});console.log('{}');`));
  for (const worker of workers) { const result = await worker.result; assert.equal(result.code, 0, result.stderr); }
  assert.equal(run(f, `console.log(JSON.stringify(loadState(workspace).config.counter));`), 18);
});

// 同時の移行では一方の未完成barrierを完成済みと誤認しない。少なくとも一方が成功し、再実行は一貫する。
test("concurrent POSIX migrations settle consistently when retried without replacing existing state", posixOnly, async t => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(f.stateDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: { sentinel: "before-migration" }, jobs: [] }), { mode: 0o600 });
  const before = metadata(stateFile);
  const workers = Array.from({ length: 2 }, () => start(f, `let result,error;try{result=migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}});}catch(e){error=e.message;}console.log(JSON.stringify({result,error}));`));
  const results = [];
  for (const worker of workers) { const result = await worker.result; assert.equal(result.code, 0, result.stderr); results.push(JSON.parse(result.stdout)); }
  assert.ok(results.some(result => result.result?.localOnly === true), "at least one migration must finish");
  for (const result of results) if (result.error) assert.match(result.error, /migration|lock|exists|recovery|marker|protocol|pending/i);
  assert.deepEqual(metadata(stateFile), before);
  migrateOnly(f); const markerFile = path.join(f.stateDir, "state.lock", "protocol.json"), committed = metadata(markerFile);
  migrateOnly(f); assert.deepEqual(metadata(markerFile), committed); assert.deepEqual(metadata(stateFile), before);
  assert.equal(run(f, `updateState(workspace,s=>{s.config.afterMigration=true;});console.log(JSON.stringify(loadState(workspace).config.sentinel));`), "before-migration");
});

// barrierの存在だけで移行成功にしない。中断・native.lockのみ・不正markerを破壊せず、再開条件を示す。
for (const partial of ["barrier-only", "native-lock-only", "invalid-marker"]) test(`partial POSIX migration is refused unchanged with recovery guidance: ${partial}`, posixOnly, t => {
  const f = fixture(t); const barrier = path.join(f.stateDir, "state.lock");
  fs.mkdirSync(barrier, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.stateDir, "state.json"), '{"version":1,"config":{"sentinel":"partial"},"jobs":[]}', { mode: 0o600 });
  if (partial !== "barrier-only") fs.writeFileSync(path.join(barrier, "native.lock"), "", { mode: 0o600 });
  if (partial === "invalid-marker") fs.writeFileSync(path.join(barrier, "protocol.json"), "{broken", { mode: 0o600 });
  const before = tree(f.data);
  const result = run(f, `let error;try{migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}});}catch(e){error=e.message;}console.log(JSON.stringify({error}));`);
  assert.match(result.error, /offline recovery|explicit.*migration|incomplete.*(?:barrier|marker)|migration.*(?:incomplete|recover)/i);
  assert.deepEqual(tree(f.data), before);
  const update = rejectedUpdate(f);
  assert.equal(update.entered, false); assert.match(update.error, /offline recovery|explicit.*migration|incomplete.*(?:barrier|marker)|migration.*(?:incomplete|recover)/i);
  assert.deepEqual(tree(f.data), before);
});

// 全owner停止が既知の専用fixtureだけで行うoffline復旧。異なるhost/devを自動受理・上書きしない。
for (const mismatch of ["host", "device"]) test(`offline POSIX recovery preserves state after a ${mismatch} mismatch`, posixOnly, t => {
  const f = fixture(t); migrate(f);
  f.markerDamaged = true;
  const barrier = path.join(f.stateDir, "state.lock"), marker = path.join(barrier, "protocol.json"), saved = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (mismatch === "host") saved.hostId = "isolated-foreign-host";
  else saved.directoryIdentity = { ...saved.directoryIdentity, dev: String(BigInt(saved.directoryIdentity.dev) + 1n) };
  fs.writeFileSync(marker, JSON.stringify(saved)); const damaged = tree(barrier), beforeState = metadata(path.join(f.stateDir, "state.json"));
  const refused = rejectedUpdate(f); assert.equal(refused.entered, false); assert.match(refused.error, /host|identity|marker|migration|recovery/i);
  assert.deepEqual(tree(barrier), damaged); assert.deepEqual(metadata(path.join(f.stateDir, "state.json")), beforeState);
  assert.equal(f.children.size, 0, "no owner has ever been started for this isolated fixture");
  const retained = path.join(f.stateDir, "state.lock.offline-backup"); fs.renameSync(barrier, retained);
  migrateOnly(f); assert.deepEqual(tree(retained), damaged); assert.deepEqual(metadata(path.join(f.stateDir, "state.json")), beforeState);
  const result = run(f, `updateState(workspace,s=>{s.config.afterRecovery=true;});console.log(JSON.stringify(loadState(workspace).config));`);
  assert.equal(result.afterRecovery, true); assert.equal(result.sentinel, "original"); assert.deepEqual(tree(retained), damaged);
});

test("POSIX aliases of one state directory contend and a held lock has a bounded timeout", posixOnly, async t => {
  const f = fixture(t); migrate(f); await hold(f);
  const alias = path.join(f.root, "data-alias"); fs.symlinkSync(f.data, alias, "dir");
  const before = metadata(path.join(f.stateDir, "state.json"));
  const result = rejectedUpdate(f, 150, { CLAUDE_PLUGIN_DATA: alias, PLUGIN_DATA: alias });
  assert.equal(result.entered, false); assert.match(result.error, /lock|timed out|deadline/i);
  assert.ok(result.elapsed < 1500); assert.deepEqual(metadata(path.join(f.stateDir, "state.json")), before);
});

// 競合を即時エラーにしてはいけない。期限内に既存ownerが正常解放すればwaiterは取得して更新する。
test("a POSIX waiter succeeds after the owner holds for 250ms and releases normally", posixOnly, async t => {
  const f = fixture(t); migrate(f); const owner = await hold(f);
  const waiting = path.join(f.root, "waiter-entering-api");
  const waiter = start(f, `fs.writeFileSync(${JSON.stringify(waiting)},'starting');const begin=performance.now();let entered=false;
    updateState(workspace,s=>{entered=true;s.config.counter+=1;},{timeoutMs:2000});
    console.log(JSON.stringify({entered,elapsed:performance.now()-begin,config:loadState(workspace).config}));`);
  await until(() => fs.existsSync(waiting), "waiter reaches the public lock API");
  await delay(250); fs.writeFileSync(owner.ownerRelease, "normal release");
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.entered, true);
  assert.ok(payload.elapsed >= 200 && payload.elapsed < 2000, `waiter elapsed ${payload.elapsed}ms`);
  assert.equal(payload.config.counter, 1); assert.equal(payload.config.sentinel, "original");
  const ownerResult = await owner.child.result;
  assert.equal(ownerResult.code, 0, ownerResult.stderr);
});

for (const detached of [false, true]) test(`POSIX owner SIGKILL releases the lock while detached child survival is ${detached}`, posixOnly, async t => {
  const f = fixture(t); migrate(f); const owner = await hold(f, { detached });
  if (detached) assert.doesNotThrow(() => process.kill(owner.detachedPid, 0));
  assert.equal(owner.child.kill("SIGKILL"), true); await owner.child.result;
  assert.equal(owner.child.signalCode, "SIGKILL");
  const result = run(f, `updateState(workspace,s=>{s.config.afterKill=true;},{timeoutMs:2000});console.log(JSON.stringify(loadState(workspace).config));`);
  assert.equal(result.afterKill, true); assert.equal(result.sentinel, "original");
  if (detached) assert.doesNotThrow(() => process.kill(owner.detachedPid, 0), "the detached child must still be alive after peer acquisition");
});

// SIGSTOPは所有者死亡ではない。停止中に年齢等でlockを奪取せず、再開後の解放と死亡を区別する。
for (const signal of ["SIGCONT", "SIGKILL"]) test(`a SIGSTOPped POSIX owner retains exclusion until ${signal}`, posixOnly, async t => {
  const f = fixture(t); migrate(f); const owner = await hold(f);
  assert.equal(owner.child.kill("SIGSTOP"), true);
  const before = metadata(path.join(f.stateDir, "state.json"));
  const blocked = rejectedUpdate(f, 150);
  assert.equal(blocked.entered, false); assert.match(blocked.error, /lock|timed out|deadline/i);
  assert.deepEqual(metadata(path.join(f.stateDir, "state.json")), before);
  if (signal === "SIGCONT") fs.writeFileSync(owner.ownerRelease, "complete callback after resume");
  assert.equal(owner.child.kill(signal), true);
  const exited = await owner.child.result;
  if (signal === "SIGCONT") assert.equal(exited.code, 0, exited.stderr);
  else assert.equal(owner.child.signalCode, "SIGKILL");
  const result = run(f, `updateState(workspace,s=>{s.config.afterSignal=${JSON.stringify(signal)};},{timeoutMs:2000});console.log(JSON.stringify(loadState(workspace).config));`);
  assert.equal(result.afterSignal, signal); assert.equal(result.sentinel, "original");
});

test("POSIX lock utilities use only the platform numeric-FD form", posixOnly, t => {
  const f = fixture(t); migrate(f);
  const rows = fs.readFileSync(f.audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(rows.length > 0, "migration/update must exercise the real utility boundary");
  for (const row of rows) {
    assert.equal(row.utility, process.platform === "darwin" ? "lockf" : "flock");
    assert.match(String(row.args.at(-1)), /^\d+$/);
    assert.equal(row.extraFds, 1, "the lock utility inherits only the native lock descriptor");
    const flags = row.args.slice(0, -1);
    if (process.platform === "darwin") {
      assert.ok(flags.filter(flag => flag === "-s").length <= 1);
      assert.deepEqual(flags.filter(flag => flag !== "-s"), ["-t", "0"]);
    } else {
      assert.deepEqual([...flags].sort(), ["-n", "-x"]);
    }
  }
});

for (const artifact of ["lock-file", "marker"]) test(`POSIX rejects unconfirmed replacement of the ${artifact}`, posixOnly, async t => {
  const f = fixture(t); migrate(f); const owner = await hold(f);
  f.markerDamaged = true;
  let target = path.join(f.stateDir, "state.lock", "protocol.json");
  if (artifact === "lock-file") {
    const rows = fs.readFileSync(f.audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    target = rows.map(row => row.lockPath).find(file => file && path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile());
    assert.ok(target, "the numeric utility FD must map to a real fixture-owned lock file");
    assert.ok(path.relative(f.root, target) && !path.relative(f.root, target).startsWith(".."));
  }
  const beforeState = metadata(path.join(f.stateDir, "state.json")), bytes = fs.readFileSync(target);
  fs.renameSync(target, `${target}.original`); fs.writeFileSync(target, bytes);
  const replacement = metadata(target), result = rejectedUpdate(f);
  assert.equal(result.entered, false); assert.match(result.error, /lock|identity|marker|protocol|migration|replace/i);
  assert.deepEqual(metadata(target), replacement); assert.deepEqual(metadata(path.join(f.stateDir, "state.json")), beforeState);
  assert.equal(owner.child.kill("SIGKILL"), true); await owner.child.result;
  const afterKill = rejectedUpdate(f);
  assert.equal(afterKill.entered, false); assert.match(afterKill.error, /lock|identity|marker|protocol|migration|replace/i);
});

for (const fault of ["missing-utility", "stalled-utility", "invalid-marker"]) test(`POSIX ${fault} fails closed without changing state`, posixOnly, t => {
  const f = fixture(t); migrate(f);
  if (fault === "invalid-marker") { f.markerDamaged = true; fs.writeFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "{broken"); }
  const before = metadata(path.join(f.stateDir, "state.json"));
  const result = rejectedUpdate(f, 150, fault === "missing-utility" ? { GROK_POSIX_LOCK_DENY_UTILITY: "1" }
    : fault === "stalled-utility" ? { GROK_POSIX_LOCK_STALL_UTILITY: "1" } : {});
  assert.equal(result.entered, false); assert.match(result.error, /utility|lock|unavailable|ENOENT|timed out|deadline|marker|protocol/i);
  if (fault === "stalled-utility") assert.ok(result.elapsed < 1500, "the external utility must share the operation deadline");
  assert.deepEqual(metadata(path.join(f.stateDir, "state.json")), before);
});

// callbackのstatus:1はutilityの競合exitと異なる。同じ例外を返し、callback副作用を再試行しない。
test("a POSIX transaction callback with status 1 runs once and preserves its exact exception", posixOnly, t => {
  const f = fixture(t); migrate(f);
  const before = tree(f.data), effect = path.join(f.root, "callback-effects");
  const result = run(f, `const failure=Object.assign(new Error('callback-sentinel'),{status:1});let caught;
    try{updateState(workspace,s=>{s.config.counter=99;fs.appendFileSync(${JSON.stringify(effect)},'once\\n');throw failure;},{timeoutMs:1000});}catch(e){caught=e;}
    console.log(JSON.stringify({same:caught===failure,message:caught?.message,status:caught?.status,effects:fs.readFileSync(${JSON.stringify(effect)},'utf8')}));`);
  assert.equal(result.same, true); assert.equal(result.message, "callback-sentinel"); assert.equal(result.status, 1);
  assert.equal(result.effects, "once\n");
  assert.deepEqual(tree(f.data), before, "callback failure must not commit state or mutate the marker");
  const peer = run(f, `updateState(workspace,s=>{s.config.afterCallbackFailure=true;},{timeoutMs:2000});console.log(JSON.stringify(loadState(workspace).config));`);
  assert.equal(peer.afterCallbackFailure, true); assert.equal(peer.counter, 0); assert.equal(peer.sentinel, "original");
});

// 実FSを変更せず、Linux statfs/Mac mountという当該OSの確認応答だけを隔離preloadで差し替える。
// 未確認filesystemを通してcallback・state・markerを変えた場合は失敗する。
for (const fileSystem of ["unknown", "network"]) test(`POSIX ${fileSystem} filesystem inspection refuses without mutations`, posixOnly, t => {
  const f = fixture(t); migrate(f); const before = tree(f.data);
  const result = rejectedUpdate(f, 1000, { GROK_POSIX_LOCK_FAKE_FS: fileSystem, GROK_POSIX_LOCK_FAKE_FS_ROOT: f.root });
  assert.equal(result.entered, false);
  assert.match(result.error, /filesystem|file system|verified local|APFS|ext4|tmpfs/i);
  assert.deepEqual(tree(f.data), before);
});

// 対象外のremote mountが応答しなくても、local APFSの操作はそのmountpointをstatせず期限内に完了する。
test("macOS local state ignores an unrelated unavailable network mount", { skip: process.platform !== "darwin" }, t => {
  const f = fixture(t); migrate(f);
  const unrelated = path.join(f.root, "unrelated-network-mount"), touched = path.join(f.root, "unrelated-mount-touched");
  const result = run(f, `const begin=performance.now();updateState(workspace,s=>{s.config.localOnlyOperation=true;},{timeoutMs:1000});console.log(JSON.stringify({elapsed:performance.now()-begin,config:loadState(workspace).config}));`,
    { GROK_POSIX_LOCK_FOREIGN_MOUNT: unrelated, GROK_POSIX_LOCK_FOREIGN_TOUCH: touched });
  assert.equal(result.config.localOnlyOperation, true); assert.equal(result.config.sentinel, "original");
  assert.ok(result.elapsed < 1000); assert.equal(fs.existsSync(touched), false, "unrelated mountpoint must never be statted");
});

// directory-entryの同期失敗を成功扱いしない。これは故障注入であり、実再起動後の耐久性実証ではない。
// marker公開後は別processのwriterも未同期markerを使わず、同期回復後だけcallbackを許可する。
for (const stage of ["state-dir", "lock-dir-before-marker", "lock-dir-after-marker"]) test(`POSIX directory fsync failure preserves partial migration until synchronization succeeds: ${stage}`, posixOnly, async t => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(f.stateDir, "state.json"), barrier = path.join(f.stateDir, "state.lock"), marker = path.join(barrier, "protocol.json");
  fs.writeFileSync(stateFile, '{"version":1,"config":{"sentinel":"fsync-original"},"jobs":[]}', { mode: 0o600 });
  const before = metadata(stateFile), attempts = path.join(f.root, "directory-fsync-attempts");
  const fault = { GROK_POSIX_LOCK_FAIL_DIR_FSYNC: stage, GROK_POSIX_LOCK_STATE_DIR: f.stateDir, GROK_POSIX_LOCK_FSYNC_ATTEMPTS: attempts };
  const invoke = `let result,error,causeStatus;try{result=migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}});}catch(e){error=e.message;causeStatus=e.cause?.status;}console.log(JSON.stringify({result,error,causeStatus}));`;
  const failed = run(f, invoke, fault);
  assert.equal(failed.result, undefined);
  if (process.platform === "linux" && stage === "lock-dir-after-marker") {
    assert.match(failed.error, /sentinel directory fsync failed \(EIO\)/i);
    assert.equal(failed.causeStatus, 1, "bootstrap must report its failed fsync");
  } else assert.match(failed.error, /fsync|sync|EIO|durab/i);
  assert.ok(fs.existsSync(attempts), "the intended directory fsync must actually be attempted");
  assert.ok(fs.readFileSync(attempts, "utf8").split("\n").includes(stage), "fault audit must identify the requested fsync stage");
  assert.equal(fs.statSync(barrier).isDirectory(), true, "partial barrier must remain available for offline recovery");
  assert.deepEqual(metadata(stateFile), before);
  if (stage === "lock-dir-after-marker") {
    assert.equal(fs.existsSync(marker), true, "the injected failure follows marker publication");
    const retained = tree(barrier);
    const retry = run(f, invoke, fault);
    assert.equal(retry.result, undefined); assert.match(retry.error, /fsync|sync|EIO|durab/i);
    assert.deepEqual(tree(barrier), retained);
    const blocked = rejectedUpdate(f, 1000, fault);
    assert.equal(blocked.entered, false); assert.match(blocked.error, /fsync|sync|EIO|durab|lock/i);
    assert.deepEqual(metadata(stateFile), before); assert.deepEqual(tree(barrier), retained);
    if (process.platform === "linux") {
      const sentinels = fs.readFileSync(f.sentinelAudit, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(sentinels.length, 1);
      await until(() => linuxSentinelExited(sentinels[0]), "uncommitted bootstrap sentinel must exit before offline recovery");
      const retryWithoutFault = run(f, invoke);
      assert.equal(retryWithoutFault.result, undefined);
      assert.match(retryWithoutFault.error, /sentinel|offline recovery/i);
      assert.deepEqual(tree(barrier), retained);
      f.markerDamaged = true;
      fs.renameSync(barrier, path.join(f.stateDir, "state.lock.offline-backup"));
    }
    migrateOnly(f); assert.deepEqual(metadata(stateFile), before);
    const recovered = run(f, `updateState(workspace,s=>{s.config.afterSync=true;},{timeoutMs:2000});console.log(JSON.stringify(loadState(workspace).config));`);
    assert.equal(recovered.afterSync, true); assert.equal(recovered.sentinel, "fsync-original");
  } else {
    assert.equal(fs.existsSync(marker), false, "failed pre-publication synchronization must not publish a marker");
  }
});

// 先行validate/fsyncの時間も同じ取得予算に含める。期限後にutility待機を新しく開始してはいけない。
// process起動とscope取得は計測外にし、公開helperの開始時刻・utility呼出し時刻を同一processで比較する。
test("POSIX acquisition does not restart its deadline after synchronous validation exhausts it", posixOnly, async t => {
  const f = fixture(t); migrate(f); await hold(f);
  const attempted = path.join(f.root, "validation-delay-attempt");
  const result = run(f, `const dir=resolveStateDir(workspace),scope=inspectPosixStateLockScope(dir);let entered=false,error;
    const started=performance.now();try{withPosixStateLock(dir,scope,()=>{entered=true;},{timeoutMs:100});}catch(e){error=e.message;}
    console.log(JSON.stringify({pid:process.pid,started,elapsed:performance.now()-started,entered,error}));`, {
    GROK_POSIX_LOCK_STATE_DIR: f.stateDir, GROK_POSIX_LOCK_DELAY_DIR_FSYNC: "120", GROK_POSIX_LOCK_DELAY_ATTEMPT: attempted
  });
  assert.ok(fs.existsSync(attempted), "the synchronous validation must actually consume its budget");
  assert.equal(result.entered, false); assert.match(result.error, /timed out|deadline/i);
  const rows = fs.readFileSync(f.audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.pid === result.pid && row.at >= result.started + 100).length, 0,
    "an expired acquisition cannot launch a fresh flock/lockf attempt");
});

// lstat 後・open 前に FIFO へ差し替わっても、待機せず拒否して callback を実行しない。
for (const part of ["marker", "native lock", "state directory", "barrier directory"]) {
  test(`POSIX ${part} replaced with FIFO during open fails without blocking`, { ...posixOnly, timeout: 15000 }, async t => {
    const f = fixture(t); migrateOnly(f);
    const barrier = path.join(f.stateDir, "state.lock");
    const target = part === "marker" ? path.join(barrier, "protocol.json")
      : part === "native lock" ? path.join(barrier, "native.lock")
      : part === "state directory" ? f.stateDir : barrier;
    const fifo = path.join(f.root, "staged-fifo"), original = path.join(f.root, "retained-original");
    const retainedFifo = path.join(f.root, "retained-fifo"), replaced = path.join(f.root, "fifo-replaced");
    const make = spawnSync("mkfifo", ["-m", "600", fifo], { encoding: "utf8", timeout: 3000 });
    assert.equal(make.error, undefined, make.error?.message); assert.equal(make.status, 0, make.stderr);
    assert.ok(fs.lstatSync(fifo).isFIFO());
    assert.equal(fs.existsSync(original), false); assert.equal(fs.existsSync(retainedFifo), false);
    const before = fs.lstatSync(target, { bigint: true });
    const owner = start(f, `const dir=resolveStateDir(workspace),scope=inspectPosixStateLockScope(dir);let entered=false,error;
      const started=performance.now();try{withPosixStateLock(dir,scope,()=>{entered=true;},{timeoutMs:100});}catch(e){error=e.message;}
      console.log(JSON.stringify({entered,error,elapsed:performance.now()-started}));`, {
      GROK_POSIX_FIFO_TARGET: target, GROK_POSIX_FIFO_STAGE: fifo,
      GROK_POSIX_FIFO_ORIGINAL: original, GROK_POSIX_FIFO_REPLACED: replaced
    });
    let expired = false;
    const timer = setTimeout(() => { expired = true; owner.kill("SIGKILL"); }, 2000);
    let result;
    try { result = await owner.result; }
    finally {
      clearTimeout(timer);
      if (fs.existsSync(original)) {
        const saved = fs.lstatSync(original, { bigint: true });
        assert.equal(saved.dev, before.dev); assert.equal(saved.ino, before.ino);
        if (fs.existsSync(target)) {
          assert.ok(fs.lstatSync(target).isFIFO(), "only the fixture FIFO may be moved away");
          fs.renameSync(target, retainedFifo);
        }
        fs.renameSync(original, target);
      }
    }
    assert.equal(fs.existsSync(replaced), true, "the target must be replaced immediately before open");
    assert.equal(expired, false, "open blocked after FIFO replacement past the child timeout");
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.entered, false);
    assert.match(output.error, /lock|identity|invalid|timed out|deadline/i);
    assert.ok(output.elapsed < 2000, "the operation must return before the watchdog");
  });
}

// 異なる device 上に自己整合した marker/lock を bind mount しても受理しない。
// mount namespace は子 process のみに属し、終了時に mount が消える。
for (const part of ["barrier", "marker", "native lock"]) {
  test(`Linux ${part} on a different device is rejected`, { skip: process.platform !== "linux" ? "Linux mount namespace E2E only" : false, timeout: 20000 }, t => {
    const f = fixture(t); migrateOnly(f);
    const mountpoint = path.join(f.root, "submount-device");
    fs.mkdirSync(mountpoint, { mode: 0o700 });
    const program = `
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {inspectPosixStateLockScope,readPosixStateLockProtocol} from ${JSON.stringify(posixModule)};
const root=process.env.PROBE_STATE, base=process.env.PROBE_BASE, mountpoint=process.env.PROBE_MOUNT, part=process.env.PROBE_PART;
const mount=(args,probe=false)=>{const r=spawnSync('mount',args,{encoding:'utf8',timeout:3000});if(r.error||r.status!==0){const detail=r.error?.message||r.stderr||'mount unavailable';if(probe){fs.writeSync(1,JSON.stringify({skip:detail})+'\\n');process.exit(0)}throw new Error('bind mount failed: '+detail)}};
mount(['--make-rprivate','/'],true);mount(['-t','tmpfs','tmpfs',mountpoint],true);
const barrier=path.join(root,'state.lock'),marker=path.join(barrier,'protocol.json'),lock=path.join(barrier,'native.lock');
const scope=inspectPosixStateLockScope(root),payload=JSON.parse(fs.readFileSync(marker,'utf8'));
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
let markerSource,lockSource;
if(part==='barrier'){
 const other=path.join(mountpoint,'barrier');fs.mkdirSync(other,{mode:0o700});
 lockSource=path.join(other,'native.lock');fs.closeSync(fs.openSync(lockSource,'wx',0o600));
 markerSource=path.join(other,'protocol.json');payload.barrierIdentity=identity(fs.statSync(other,{bigint:true}));payload.lockIdentity=identity(fs.statSync(lockSource,{bigint:true}));
}else{
 markerSource=part==='marker'?path.join(mountpoint,'marker'):path.join(base,'same-device-marker');
 if(part==='native lock'){lockSource=path.join(mountpoint,'lock');fs.closeSync(fs.openSync(lockSource,'wx',0o600));payload.lockIdentity=identity(fs.statSync(lockSource,{bigint:true}));}
}

const fd=fs.openSync(markerSource,'wx',0o600);payload.markerIdentity=identity(fs.fstatSync(fd,{bigint:true}));fs.writeFileSync(fd,JSON.stringify(payload));fs.closeSync(fd);
if(part==='barrier')mount(['--bind',path.dirname(markerSource),barrier]);
else {mount(['--bind',markerSource,marker]);if(lockSource)mount(['--bind',lockSource,lock]);}
const devices={state:String(fs.statSync(root,{bigint:true}).dev),barrier:String(fs.statSync(barrier,{bigint:true}).dev),marker:String(fs.statSync(marker,{bigint:true}).dev),lock:String(fs.statSync(lock,{bigint:true}).dev)};
let error;try{readPosixStateLockProtocol(barrier,scope);}catch(e){error=e.message;}
fs.writeSync(1,JSON.stringify({devices,error})+'\\n');`;
    const child = spawnSync("unshare", ["--mount", "--", process.execPath, "--input-type=module", "-e", program], {
      cwd: f.workspace, env: { ...f.env, PROBE_STATE: f.stateDir, PROBE_BASE: f.root, PROBE_MOUNT: mountpoint, PROBE_PART: part }, encoding: "utf8", timeout: 15000
    });
    if (child.error?.code === "ENOENT") return t.skip("unshare is unavailable");
    assert.equal(child.error, undefined, child.error?.message);
    if (child.status !== 0 && /^unshare:.*(?:operation not permitted|permission denied)/im.test(child.stderr)) return t.skip(`mount namespace unavailable: ${child.stderr.trim()}`);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    if (result.skip) return t.skip(`mount capability unavailable: ${result.skip.trim()}`);
    const { devices } = result;
    if (part === "barrier") assert.notEqual(devices.state, devices.barrier);
    else {
      assert.equal(devices.state, devices.barrier);
      assert.equal(devices.state === devices.marker, part !== "marker");
      assert.equal(devices.state === devices.lock, part !== "native lock");
    }
    assert.match(result.error, /POSIX state lock.*mount/i);
  });
}

// 同一 device 上の別 mount では dev/ino の照合だけでは不十分。
// 逆に state root 全体の bind alias は、その配下が同じ mount なら受理する。
for (const part of ["barrier", "marker", "native lock", "ready", "root alias"]) {
  test(`Linux same-device bind mount ${part} has the expected scope`, { skip: process.platform !== "linux" ? "Linux mount namespace E2E only" : false, timeout: 20000 }, t => {
    const f = fixture(t); migrateOnly(f);
    const program = `
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {inspectPosixStateLockScope,readPosixStateLockProtocol,withPosixStateLock} from ${JSON.stringify(posixModule)};
const root=process.env.PROBE_STATE,base=process.env.PROBE_BASE,part=process.env.PROBE_PART;
const mount=(args,probe=false)=>{const r=spawnSync('mount',args,{encoding:'utf8',timeout:3000});if(r.error||r.status!==0){const detail=r.error?.message||r.stderr||'mount unavailable';if(probe){fs.writeSync(1,JSON.stringify({skip:detail})+'\\n');process.exit(0)}throw new Error('bind mount failed: '+detail)}};
mount(['--make-rprivate','/'],true);
const barrier=path.join(root,'state.lock'),marker=path.join(barrier,'protocol.json'),lock=path.join(barrier,'native.lock'),ready=path.join(barrier,'sentinel-ready.json');
const identity=s=>({dev:String(s.dev),ino:String(s.ino)}),payload=JSON.parse(fs.readFileSync(marker,'utf8'));
let observedRoot=root;
if(part==='root alias'){
 observedRoot=path.join(base,'state-root-alias');fs.mkdirSync(observedRoot,{mode:0o700});mount(['--bind',root,observedRoot],true);
}else if(part==='native lock'||part==='ready'){
 const target=part==='ready'?ready:lock,alternate=path.join(base,'same-inode-'+part);fs.linkSync(target,alternate);mount(['--bind',alternate,target],true);
}else{
 const alternate=path.join(base,part==='barrier'?'alternate-barrier':'alternate-marker');
 let source;
 if(part==='barrier'){
  fs.mkdirSync(alternate,{mode:0o700});fs.linkSync(lock,path.join(alternate,'native.lock'));fs.linkSync(ready,path.join(alternate,'sentinel-ready.json'));
  payload.barrierIdentity=identity(fs.statSync(alternate,{bigint:true}));payload.lockIdentity=identity(fs.statSync(path.join(alternate,'native.lock'),{bigint:true}));
  source=path.join(alternate,'protocol.json');
 }else source=alternate;
 const fd=fs.openSync(source,'wx',0o600);payload.markerIdentity=identity(fs.fstatSync(fd,{bigint:true}));fs.writeFileSync(fd,JSON.stringify(payload));fs.closeSync(fd);
 mount(['--bind',part==='barrier'?alternate:source,part==='barrier'?barrier:marker],true);
}
const b=path.join(observedRoot,'state.lock'),m=path.join(b,'protocol.json'),n=path.join(b,'native.lock'),r=path.join(b,'sentinel-ready.json');
const mountId=(file,directory)=>{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(directory?fs.constants.O_DIRECTORY:0));try{const info=fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8');const match=info.match(/^mnt_id:\\s*(\\d+)\\s*$/m);if(!match)throw new Error('fdinfo mnt_id is unavailable');return match[1]}finally{fs.closeSync(fd)}};
const devices={state:String(fs.statSync(observedRoot,{bigint:true}).dev),barrier:String(fs.statSync(b,{bigint:true}).dev),marker:String(fs.statSync(m,{bigint:true}).dev),lock:String(fs.statSync(n,{bigint:true}).dev),ready:String(fs.statSync(r,{bigint:true}).dev)};
const mounts={original:mountId(root,true),state:mountId(observedRoot,true),barrier:mountId(b,true),marker:mountId(m,false),lock:mountId(n,false),ready:mountId(r,false)};
let error,entered=false;try{const scope=inspectPosixStateLockScope(observedRoot);readPosixStateLockProtocol(b,scope);withPosixStateLock(observedRoot,scope,()=>{entered=true},{timeoutMs:2000});}catch(e){error=e.message}
fs.writeSync(1,JSON.stringify({devices,mounts,entered,error})+'\\n');`;
    const child = spawnSync("unshare", ["--mount", "--", process.execPath, "--input-type=module", "-e", program], {
      cwd: f.workspace, env: { ...f.env, PROBE_STATE: f.stateDir, PROBE_BASE: f.root, PROBE_PART: part }, encoding: "utf8", timeout: 15000
    });
    if (child.error?.code === "ENOENT") return t.skip("unshare is unavailable");
    assert.equal(child.error, undefined, child.error?.message);
    if (child.status !== 0 && /^unshare:.*(?:operation not permitted|permission denied)/im.test(child.stderr)) return t.skip(`mount namespace unavailable: ${child.stderr.trim()}`);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    if (result.skip) return t.skip(`mount capability unavailable: ${result.skip.trim()}`);
    const { devices, mounts } = result;
    assert.equal(devices.state, devices.barrier); assert.equal(devices.state, devices.marker); assert.equal(devices.state, devices.lock); assert.equal(devices.state, devices.ready);
    if (part === "root alias") {
      assert.notEqual(mounts.original, mounts.state);
      assert.equal(mounts.state, mounts.barrier); assert.equal(mounts.state, mounts.marker); assert.equal(mounts.state, mounts.lock); assert.equal(mounts.state, mounts.ready);
      assert.equal(result.entered, true, result.error);
    } else {
      const key = part === "native lock" ? "lock" : part;
      assert.notEqual(mounts.state, mounts[key], `fixture did not create a distinct mount ID for ${part}`);
      assert.equal(result.entered, false, `${part} from a different mount was accepted`);
      assert.match(result.error, /mount/i, "rejection must identify the mount boundary");
    }
  });
}

// callbackの同期enqueue完了がunlock境界。返された未解決Promiseの決着をlock内で待ってはいけない。
test("POSIX snapshot releases after synchronous enqueue even while its returned promise is unresolved", posixOnly, async t => {
  const f = fixture(t); migrate(f);
  const ready = path.join(f.root, "promise-enqueued"), release = path.join(f.root, "promise-release"), settled = path.join(f.root, "promise-settled");
  const owner = start(f, `let complete;const pending=new Promise(resolve=>{complete=resolve;});
    const returned=withStateSnapshot(workspace,()=>{fs.appendFileSync(${JSON.stringify(ready)},'enqueued\\n');return pending;});
    if(returned!==pending)throw new Error('snapshot changed the callback promise');
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);complete();}},10);
    await returned;fs.writeFileSync(${JSON.stringify(settled)},'settled');`);
  await until(() => fs.existsSync(ready), "synchronous enqueue is observable");
  assert.equal(fs.existsSync(settled), false);
  const peer = run(f, `updateState(workspace,s=>{s.config.duringPendingPromise=true;},{timeoutMs:1000});console.log(JSON.stringify(loadState(workspace).config));`);
  assert.equal(peer.duringPendingPromise, true); assert.equal(fs.existsSync(settled), false);
  assert.equal(fs.readFileSync(ready, "utf8"), "enqueued\n");
  fs.writeFileSync(release, "resolve pending promise");
  const exited = await owner.result; assert.equal(exited.code, 0, exited.stderr); assert.equal(fs.existsSync(settled), true);
});

// marker公開直後・dir fsync前でownerを実際に停止し、未同期markerを別writerが先に採用しない。
test("a writer cannot adopt the marker while migration is paused before its directory fsync", posixOnly, async t => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(f.stateDir, "state.json"), gate = path.join(f.root, "publication-fsync-gate");
  fs.writeFileSync(stateFile, '{"version":1,"config":{"sentinel":"before-publish"},"jobs":[]}', { mode: 0o600 });
  const before = metadata(stateFile);
  const owner = start(f, `console.log(JSON.stringify(migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}})));`,
    { GROK_POSIX_LOCK_STATE_DIR: f.stateDir, GROK_POSIX_LOCK_GATE_DIR_FSYNC: gate });
  await until(() => {
    if (owner.exitCode !== null || owner.signalCode !== null) throw new Error("migration exited before the directory fsync gate");
    return fs.existsSync(`${gate}.held`);
  }, "marker published before directory fsync");
  assert.equal(owner.kill("SIGSTOP"), true);
  const attempts = path.join(f.root, "publication-writer-fsync-attempt");
  const fault = { GROK_POSIX_LOCK_FAIL_DIR_FSYNC: "lock-dir-after-marker", GROK_POSIX_LOCK_STATE_DIR: f.stateDir,
    GROK_POSIX_LOCK_FSYNC_ATTEMPTS: attempts };
  const blocked = rejectedUpdate(f, 1000, fault);
  assert.equal(blocked.entered, false); assert.match(blocked.error, /fsync|sync|EIO|durab|lock/i);
  assert.ok(fs.existsSync(attempts), "writer must check synchronization before accepting a published marker");
  assert.deepEqual(metadata(stateFile), before);
  fs.writeFileSync(`${gate}.release`, "allow durable publication"); assert.equal(owner.kill("SIGCONT"), true);
  const migrated = await owner.result; assert.equal(migrated.code, 0, migrated.stderr);
  const stillBlocked = rejectedUpdate(f, 1000, fault);
  assert.equal(stillBlocked.entered, false); assert.deepEqual(metadata(stateFile), before);
  const recovered = run(f, `updateState(workspace,s=>{s.config.afterPublication=true;},{timeoutMs:2000});console.log(JSON.stringify(loadState(workspace).config));`);
  assert.equal(recovered.afterPublication, true); assert.equal(recovered.sentinel, "before-publish");
});

// 先行失敗条件: 初回 marker だけが認可される、旧記録が明示確認なしに認可される、
// pointer と履歴の同時消失を初回空状態と誤認、初期化中断を既存 migrate で自動補完する。
const linuxOnly = { skip: process.platform !== "linux" ? "Linux epoch recovery E2E only" : false };
test("fresh Linux migration durably initializes an authorized empty baseline", linuxOnly, t => {
  const f = fixture(t), migrated = migrateOnly(f);
  const barrier = path.join(f.stateDir, "state.lock"), native = fs.statSync(path.join(barrier, "native.lock"), { bigint: true });
  const barrierStat = fs.statSync(barrier, { bigint: true }), ready = fs.statSync(path.join(barrier, "sentinel-ready.json"), { bigint: true });
  const fdDir = `/proc/${migrated.sentinel.pid}/fd`, same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  assert.ok(same(fs.statSync(path.join(fdDir, "3"), { bigint: true }), barrierStat), "sentinel FD 3 must retain the barrier");
  const held = fs.readdirSync(fdDir).map(name => {
    try { return fs.statSync(path.join(fdDir, name), { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }).filter(Boolean);
  assert.ok(held.some(stat => same(stat, ready)), "sentinel must retain the ready descriptor");
  assert.equal(held.some(stat => same(stat, native)), false, "sentinel must not inherit the native lock");
  const recovery = epochRecoveryDir(f, migrated.epoch);
  assert.equal(fs.existsSync(path.join(recovery, "current.json")), true, "initial pointer must exist");
  assert.ok(fs.readdirSync(recovery).some(name => /^[0-9a-f-]{36}\.json$/.test(name)), "initial attempt must exist");
  const first = admission(f);
  assert.equal(first.entered, true, first.error); assert.equal(first.finished, true, first.error);
  const second = admission(f);
  assert.equal(second.entered, true, second.error); assert.equal(second.finished, true, second.error);
});

test("Linux migration records a pending baseline when legacy admission exists", linuxOnly, t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
  const legacy = path.join(f.stateDir, "broker.json");
  fs.writeFileSync(legacy, "legacy admission evidence", { mode: 0o600 });
  const migrated = migrateOnly(f), recovery = epochRecoveryDir(f, migrated.epoch);
  assert.equal(fs.existsSync(path.join(recovery, "current.json")), true, "pending pointer must exist");
  assert.ok(fs.readdirSync(recovery).some(name => /^[0-9a-f-]{36}\.json$/.test(name)), "pending attempt must exist");
  const blocked = admission(f);
  assert.equal(blocked.entered, false); assert.match(blocked.error, /recovery|legacy|admission/i);
  assert.equal(fs.readFileSync(legacy, "utf8"), "legacy admission evidence");
  assert.equal(recoverEpoch(f).epoch, migrated.epoch);
  const admitted = admission(f);
  assert.equal(admitted.entered, true, admitted.error); assert.equal(admitted.finished, true, admitted.error);
  assert.equal(fs.readFileSync(legacy, "utf8"), "legacy admission evidence");
});

for (const loseLegacy of [false, true]) {
  test(`missing Linux recovery pointer and attempts fail closed with legacy ${loseLegacy ? "also missing" : "preserved"}`, linuxOnly, t => {
    const f = fixture(t);
    fs.mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
    const legacy = path.join(f.stateDir, "broker.json");
    fs.writeFileSync(legacy, "legacy admission evidence", { mode: 0o600 });
    const migrated = migrateOnly(f);
    // 現 epoch の通常領域を先に揃え、証跡消失だけをこのケースの変数にする。
    for (const name of ["broker-v3", "direct-start-v2"]) fs.mkdirSync(path.join(f.stateDir, name, migrated.epoch), { recursive: true, mode: 0o700 });
    assert.equal(recoverEpoch(f).epoch, migrated.epoch);
    const before = admission(f);
    assert.equal(before.entered, true, before.error); assert.equal(before.finished, true, before.error);
    const marker = path.join(f.stateDir, "state.lock", "protocol.json"), markerBefore = metadata(marker);
    const recovery = epochRecoveryDir(f, migrated.epoch), retained = path.join(f.root, "retained-recovery");
    assert.equal(fs.existsSync(retained), false);
    const hadPointer = fs.existsSync(path.join(recovery, "current.json"));
    const hadAttempt = fs.readdirSync(recovery).some(name => /^[0-9a-f-]{36}\.json$/.test(name));
    fs.renameSync(recovery, retained);
    if (loseLegacy) fs.renameSync(legacy, path.join(f.root, "retained-legacy"));
    const blocked = admission(f);
    assert.equal(blocked.entered, false, "missing evidence must not become an empty initial state");
    assert.match(blocked.error, /recovery|legacy|admission/i);
    assert.equal(hadPointer, true, "the original pointer must have existed");
    assert.equal(hadAttempt, true, "the original attempt must have existed");
    assert.deepEqual(metadata(marker), markerBefore);
    if (!loseLegacy) assert.equal(fs.readFileSync(legacy, "utf8"), "legacy admission evidence");
    assert.equal(recoverEpoch(f).epoch, migrated.epoch);
    const after = admission(f);
    assert.equal(after.entered, true, after.error); assert.equal(after.finished, true, after.error);
    assert.deepEqual(metadata(marker), markerBefore);
  });
}

test("interrupted Linux guard initialization cannot be repaired by rerunning migrate", linuxOnly, t => {
  const f = fixture(t);
  const body = `migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}});console.log('{}');`;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", source(f, body)], {
    cwd: f.workspace, env: { ...f.env, GROK_POSIX_CRASH_INITIAL_GUARD: "1", GROK_POSIX_LOCK_STATE_DIR: f.stateDir }, encoding: "utf8", timeout: 20000
  });
  if (interrupted.error) f.uncertain = true;
  assert.equal(interrupted.error, undefined, interrupted.error?.message);
  assert.equal(interrupted.status, 74, "fixture must stop the migration after marker publication and before guard creation");
  const marker = path.join(f.stateDir, "state.lock", "protocol.json");
  assert.equal(fs.existsSync(marker), true);
  const markerBefore = metadata(marker), epoch = JSON.parse(fs.readFileSync(marker, "utf8")).epoch;
  const retried = run(f, `let result,error;try{result=migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}});}catch(e){error=e.message;}console.log(JSON.stringify({result,error}));`);
  if (retried.result) assert.equal(retried.result.epoch, epoch);
  const blocked = admission(f);
  assert.equal(blocked.entered, false, "a retry must not authorize an incomplete initial guard");
  assert.match(blocked.error, /recovery|legacy|admission/i);
  assert.deepEqual(metadata(marker), markerBefore);
  assert.equal(recoverEpoch(f).epoch, epoch);
  const after = admission(f);
  assert.equal(after.entered, true, after.error); assert.equal(after.finished, true, after.error);
});
