import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { removeTempFixture } from "./helpers.mjs";

// 起動前に想定する失敗: 旧 owner が残した inode の消失、未検証入力の移行、
// 偽 callback の実行、偽 mutex capability の使用、旧 lock 再取得、並行 state 更新。
const darwin = { skip: process.platform !== "darwin", timeout: 90000 };
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const holder = fileURLToPath(new URL("./fixtures/darwin-126-file-lock-holder.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const stateApi = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
const lockApi = new URL("../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs", import.meta.url).href;
const posixApi = new URL("../plugins/grok/scripts/lib/posix-state-lock.mjs", import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const originalTemp = path.resolve(os.tmpdir()), parent = fs.realpathSync.native(originalTemp);
  assert.ok(path.isAbsolute(parent));
  const relative = path.relative(repository, parent);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`));
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-old-lock-e2e-"));
  const cleanupTarget = path.join(originalTemp, path.basename(root));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const dir of [cwd, data, temp]) fs.mkdirSync(dir, { mode: 0o700 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "TMPDIR", "TMP", "TEMP"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, TMPDIR: temp, TMP: temp, TEMP: temp });
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, "jobs"), { mode: 0o700 });
  const stateFile = path.join(stateDir, "state.json");
  const state = Buffer.from(`${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [], reviewGateSessions: [] }, null, 2)}\n`);
  fs.writeFileSync(stateFile, state, { mode: 0o600 });
  const f = { root, cwd, stateDir, stateFile, state, lock: path.join(stateDir, "state.lock"), children: new Set(), retain: false };
  t.after(async () => {
    for (const child of f.children) {
      f.retain = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.closed;
    }
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    if (f.retain) t.diagnostic(`Preserved fixture for inspection: ${root}`);
    else removeTempFixture(cleanupTarget, { recursive: true, force: true });
  });
  return f;
}

function start(f, args) {
  const child = spawn(process.execPath, args, { cwd: f.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  child.closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.retain = true; child.kill("SIGKILL"); reject(new Error(`child timed out: ${errors}`)); }, 35000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); f.children.delete(child); resolve({ code, signal, output, errors }); });
  });
  f.children.add(child);
  return { child, get output() { return output; }, get errors() { return errors; } };
}

async function waitFor(owner, line) {
  const deadline = Date.now() + 25000;
  while (!owner.output.includes(`${line}\n`)) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error(`child exited before ${line}: ${owner.errors}`);
    if (Date.now() >= deadline) throw new Error(`child did not reach ${line}: ${owner.errors}`);
    await pause(20);
  }
}

async function preserveRealOldLock(f) {
  const owner = start(f, [holder, f.stateDir]);
  await waitFor(owner, "LEGACY_LOCK_HELD");
  const before = fs.lstatSync(f.lock, { bigint: true }), bytes = fs.readFileSync(f.lock);
  assert.ok(before.isFile());
  assert.equal(bytes.toString("utf8"), `${owner.child.pid}\n`);
  owner.child.kill("SIGKILL");
  const stopped = await owner.child.closed;
  assert.equal(stopped.signal, "SIGKILL");
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(f.lock), bytes);
  return { before, bytes };
}

function migrate(f) {
  return spawnSync(process.execPath, [cli, "state-lock", "migrate", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", f.stateDir, "--cwd", f.cwd, "--json"], {
    cwd: f.cwd, env: process.env, encoding: "utf8", timeout: 30000
  });
}

function retainedOldInode(dir, expected, bytes) {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const stat = fs.lstatSync(file, { bigint: true });
        if (stat.dev === expected.dev && stat.ino === expected.ino && fs.readFileSync(file).equals(bytes)) return true;
      }
    }
  }
  return false;
}

function probeSource(cwd, mode) {
  return `import fs from 'node:fs'; import {withStateSnapshot} from ${JSON.stringify(stateApi)};
try { withStateSnapshot(${JSON.stringify(cwd)}, (_state, context) => {
  context.check(); fs.writeSync(1, 'STATE_MUTEX_HELD\\n');
  ${mode === "hold" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);" : ""}
}, {timeoutMs:${mode === "hold" ? 15000 : 2000}}); }
catch (e) { console.error(e.message); process.exitCode=1; }`;
}

test("offline migration retains a lock held by the 1.0.26-derived fixture and publishes an exclusive v4 state mutex", darwin, async t => {
  const f = fixture(t), old = await preserveRealOldLock(f);
  const result = migrate(f);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readFileSync(f.stateFile), f.state);
  assert.ok(retainedOldInode(f.stateDir, old.before, old.bytes), "old lock inode and bytes were not retained");
  assert.ok(fs.lstatSync(f.lock).isDirectory());
  const marker = JSON.parse(fs.readFileSync(path.join(f.lock, "protocol.json"), "utf8"));
  assert.equal(marker.protocol, "posix-local-v4");

  const first = start(f, ["--input-type=module", "-e", probeSource(f.cwd, "hold")]);
  await waitFor(first, "STATE_MUTEX_HELD");
  const second = start(f, ["--input-type=module", "-e", probeSource(f.cwd, "once")]);
  const contender = await second.child.closed;
  assert.notEqual(contender.code, 0, contender.output);
  assert.doesNotMatch(contender.output, /STATE_MUTEX_HELD/);
  assert.match(contender.errors, /timed out|lock/i);
  first.child.kill("SIGKILL");
  assert.equal((await first.child.closed).signal, "SIGKILL");
  const after = await start(f, ["--input-type=module", "-e", probeSource(f.cwd, "once")]).child.closed;
  assert.equal(after.code, 0, after.errors);
  assert.match(after.output, /STATE_MUTEX_HELD/);
  assert.ok(retainedOldInode(f.stateDir, old.before, old.bytes));
});

test("runtime refuses modified completion evidence and preserves the old inode", darwin, async t => {
  const f = fixture(t), old = await preserveRealOldLock(f);
  const result = migrate(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const file = path.join(f.stateDir, ".darwin-legacy-migration", "completion.json");
  const completion = JSON.parse(fs.readFileSync(file, "utf8"));
  completion.epoch = "00000000-0000-4000-8000-000000000000";
  const bytes = Buffer.from(`${JSON.stringify(completion)}\n`);
  fs.writeFileSync(file, bytes);
  const before = fs.lstatSync(file, { bigint: true });
  const runtime = await start(f, ["--input-type=module", "-e", probeSource(f.cwd, "once")]).child.closed;
  assert.notEqual(runtime.code, 0, runtime.output);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.lstatSync(file, { bigint: true }).ino, before.ino);
  assert.ok(retainedOldInode(f.stateDir, old.before, old.bytes));
});

test("forged migration callbacks cannot inspect or remove the actual legacy lock", darwin, async t => {
  const f = fixture(t), old = await preserveRealOldLock(f);
  const unknown = path.join(f.stateDir, "unknown-record"), called = path.join(f.root, "forged-callback-called");
  fs.writeFileSync(unknown, "retain\n", { mode: 0o600 });
  const source = `import fs from 'node:fs';
import {withDarwinLegacyLockMigration} from ${JSON.stringify(lockApi)};
import {inspectPosixStateLockScope} from ${JSON.stringify(posixApi)};
const called=${JSON.stringify(called)}; try {
  withDarwinLegacyLockMigration(${JSON.stringify(f.stateDir)}, {expectedStateDir:${JSON.stringify(f.stateDir)},
    offlineConfirmed:true,localOnly:true,inspectScope:inspectPosixStateLockScope,
    verifyInventory:()=>{fs.writeFileSync(called,'inventory');return true;},
    runMigration:()=>{fs.writeFileSync(called,'migration');return {};}});
} catch (e) {console.error(e.message); process.exitCode=1;}`;
  const result = await start(f, ["--input-type=module", "-e", source]).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.equal(fs.existsSync(called), false, "untrusted callback was executed");
  assert.deepEqual(fs.readFileSync(f.lock), old.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, old.before.ino);
  assert.equal(fs.readFileSync(unknown, "utf8"), "retain\n");
});

test("disabled migration does not evaluate injected callback accessors", darwin, async t => {
  const f = fixture(t), old = await preserveRealOldLock(f);
  const called = path.join(f.root, "forged-accessor-called");
  const source = `import fs from 'node:fs';
import {withDarwinLegacyLockMigration} from ${JSON.stringify(lockApi)};
const options = {expectedStateDir:${JSON.stringify(f.stateDir)},offlineConfirmed:true,localOnly:true};
Object.defineProperty(options,'verifyInventory',{get(){fs.writeFileSync(${JSON.stringify(called)},'called');return ()=>true;}});
try {withDarwinLegacyLockMigration(${JSON.stringify(f.stateDir)},options);}
catch(e){console.error(e.message);process.exitCode=1;}`;
  const result = await start(f, ["--input-type=module", "-e", source]).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.equal(fs.existsSync(called), false, "untrusted callback accessor was evaluated");
  assert.deepEqual(fs.readFileSync(f.lock), old.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, old.before.ino);
});

for (const missing of ["offline", "local", "old-stopped", "expected-path"]) {
  test(`offline migration preserves the real old lock when ${missing} confirmation is missing`, darwin, async t => {
    const f = fixture(t), old = await preserveRealOldLock(f);
    const args = [cli, "state-lock", "migrate", "--cwd", f.cwd, "--json"];
    if (missing !== "offline") args.push("--offline-confirmed");
    if (missing !== "local") args.push("--local-only");
    if (missing !== "old-stopped") args.push("--all-old-processes-stopped");
    if (missing !== "expected-path") args.push("--expected-state-dir", f.stateDir);
    const result = await start(f, args).child.closed;
    assert.notEqual(result.code, 0, result.output);
    if (missing === "old-stopped") assert.match(result.errors, /--all-old-processes-stopped/i);
    assert.deepEqual(fs.readFileSync(f.lock), old.bytes);
    assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, old.before.ino);
    assert.deepEqual(fs.readFileSync(f.stateFile), f.state);
    assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
  });
}

test("the legacy migration guard rejects fabricated capabilities without reading their fields", darwin, async t => {
  const f = fixture(t), old = await preserveRealOldLock(f);
  const source = `import * as migration from ${JSON.stringify(lockApi)};
if(typeof migration.assertDarwinLegacyGuardContext !== 'function') throw Error('guard validator unavailable');
let read=false; const fake=Object.defineProperty({},'check',{get(){read=true;throw Error('untrusted getter');}});
for(const candidate of [null,{},fake,Object.freeze({stateDir:${JSON.stringify(f.stateDir)},fd:3,check(){}})]) {
  let rejected=false; try {migration.assertDarwinLegacyGuardContext(candidate);} catch {rejected=true;}
  if(!rejected) throw Error('fabricated guard capability was accepted');
}
if(read) throw Error('untrusted capability getter was evaluated');`;
  const result = await start(f, ["--input-type=module", "-e", source]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.deepEqual(fs.readFileSync(f.lock), old.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, old.before.ino);
});
