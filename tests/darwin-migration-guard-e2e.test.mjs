import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeTempFixture } from "./helpers.mjs";

// 失敗条件: 実 FD なしの capability、close 後の再利用、guard 分裂、旧 lock の変更。
const darwin = { skip: process.platform !== "darwin", timeout: 90000 };
const childScript = fileURLToPath(new URL("./fixtures/darwin-migration-guard-child.mjs", import.meta.url));
const oldHolder = fileURLToPath(new URL("./fixtures/darwin-126-file-lock-holder.mjs", import.meta.url));
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const originalTemp = path.resolve(os.tmpdir()), parent = fs.realpathSync.native(originalTemp);
  const relative = path.relative(repository, parent);
  assert.ok(path.isAbsolute(parent) && (relative === ".." || relative.startsWith(`..${path.sep}`)));
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-migration-guard-"));
  const cleanupTarget = path.join(originalTemp, path.basename(root));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const f = { root, stateDir, lock: path.join(stateDir, "state.lock"), children: new Set(), retain: false };
  t.after(async () => {
    for (const child of f.children) {
      f.retain = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.closed;
    }
    if (f.retain) t.diagnostic(`Preserved fixture for inspection: ${root}`);
    else removeTempFixture(cleanupTarget, { recursive: true, force: true });
  });
  return f;
}

function start(f, script, args = [], extraEnv = {}) {
  const env = { ...process.env, TMPDIR: f.root, TMP: f.root, TEMP: f.root, ...extraEnv };
  const child = spawn(process.execPath, [script, f.stateDir, ...args], { cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"] });
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

async function oldLock(f) {
  const owner = start(f, oldHolder);
  await waitFor(owner, "LEGACY_LOCK_HELD");
  const bytes = fs.readFileSync(f.lock), stat = fs.lstatSync(f.lock, { bigint: true });
  assert.equal(bytes.toString("utf8"), `${owner.child.pid}\n`);
  owner.child.kill("SIGKILL");
  assert.equal((await owner.child.closed).signal, "SIGKILL");
  return { bytes, stat };
}

function assertOldLock(f, before) {
  assert.deepEqual(fs.readFileSync(f.lock), before.bytes);
  const after = fs.lstatSync(f.lock, { bigint: true });
  assert.equal(after.dev, before.stat.dev);
  assert.equal(after.ino, before.stat.ino);
  assert.equal(after.nlink, 1n);
}

function deadlinePreload(f, mode) {
  const file = path.join(f.root, `deadline-${mode}.cjs`);
  const source = String.raw`
const cp=require('node:child_process'), original=cp.execFileSync, mod=require('node:module');
const mode=process.env.GUARD_DEADLINE_TEST;
cp.execFileSync=function(command,args,options){
  if(command==='/sbin/mount' && mode==='slow-subprocess') {
    return original(process.execPath,['-e','setTimeout(()=>{},5000)'],options);
  }
  const result=original(command,args,options);
  if(command==='/sbin/mount' && mode==='cumulative') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,220);
  if(command==='/sbin/mount' && mode==='backup' && process.env.BACKUP_VERIFY_DELAY==='1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180);
  return result;
};
mod.syncBuiltinESMExports();`;
  fs.writeFileSync(file, source, { mode: 0o600 });
  return { NODE_OPTIONS: `--require=${JSON.stringify(file)}`, GUARD_DEADLINE_TEST: mode };
}

test("a real guard capability is valid only while its native FD is held", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_HELD/);
  assert.match(result.output, /GUARD_EXPIRED/);
  assertOldLock(f, before);
});

test("two migration processes share a guard and recover after its owner exits", darwin, async t => {
  const f = fixture(t), before = await oldLock(f), first = start(f, childScript, ["hold", "7500"]);
  await waitFor(first, "GUARD_HELD");
  const second = await start(f, childScript, ["once", "500"]).child.closed;
  assert.notEqual(second.code, 0, second.output);
  assert.match(second.errors, /timed out/i);
  assertOldLock(f, before);
  first.child.kill("SIGKILL");
  assert.equal((await first.child.closed).signal, "SIGKILL");
  const third = await start(f, childScript).child.closed;
  assert.equal(third.code, 0, third.errors);
  assert.match(third.output, /GUARD_EXPIRED/);
  assertOldLock(f, before);
});

test("the 500ms guard budget also limits a slow APFS inspection subprocess", darwin, async t => {
  const f = fixture(t), before = await oldLock(f), env = deadlinePreload(f, "slow-subprocess");
  const startTime = process.hrtime.bigint();
  const result = await start(f, childScript, ["once", "500"], env).child.closed;
  const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  assert.notEqual(result.code, 0, result.output);
  assert.ok(elapsedMs < 2000, `500ms budget was not propagated to APFS subprocess: ${elapsedMs.toFixed(0)}ms`);
  assertOldLock(f, before);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
});

test("the 500ms guard budget spans inspection, FD acquisition, and final capability validation", darwin, async t => {
  const f = fixture(t), before = await oldLock(f), env = deadlinePreload(f, "cumulative");
  const startTime = process.hrtime.bigint();
  const result = await start(f, childScript, ["once", "500"], env).child.closed;
  const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  assert.notEqual(result.code, 0, `guard capability was issued after the budget: ${result.output}`);
  assert.ok(elapsedMs < 2000, `budget rejection was delayed: ${elapsedMs.toFixed(0)}ms`);
  assert.doesNotMatch(result.output, /GUARD_HELD/);
  assertOldLock(f, before);
  // 模擬した同期遅延は割り込めず、戻った直後に期限判定する契約。
  const retry = await start(f, childScript, ["once", "7500"]).child.closed;
  assert.equal(retry.code, 0, retry.errors);
  assertOldLock(f, before);
});

test("a process cannot reenter its live guard", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript, ["reenter", "7500"]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assertOldLock(f, before);
});

test("guard capability exposes the frozen identity of its actual native FD", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript, ["guard-identity", "7500"]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assertOldLock(f, before);
});

test("completion publication rejects a forged state mutex capability before reading it", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript, ["forged-state-completion", "7500"]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration", "completed.json")), false);
  assertOldLock(f, before);
});

test("backup verification rejects a forged preflight token before reading it", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript, ["forged-backup-token", "7500"]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration", "transition.json")), false);
  assertOldLock(f, before);
});

test("manifest creation rejects forged offline authorization without writing", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript, ["forged-manifest-authorization", "7500"]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration", "manifest.json")), false);
  assertOldLock(f, before);
});

for (const mode of ["backup-valid", "backup-marker-corrupt", "backup-foreign-inode", "backup-expired-token"]) {
  test(`fixed backup verifier checks genuine token and ${mode}`, darwin, async t => {
    const f = fixture(t), before = await oldLock(f);
    const result = await start(f, childScript, [mode, "7500"]).child.closed;
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /GUARD_EXPIRED/);
    assert.deepEqual(fs.readFileSync(f.lock), before.bytes);
    const current = fs.lstatSync(f.lock, { bigint: true });
    assert.equal(current.dev, before.stat.dev);
    assert.equal(current.ino, before.stat.ino);
    if (mode === "backup-expired-token") assert.equal(current.nlink, 1n);
    else {
      const backup = path.join(f.stateDir, ".darwin-legacy-migration", "legacy-state.lock");
      assert.deepEqual(fs.readFileSync(backup), before.bytes);
      if (mode === "backup-foreign-inode") assert.notEqual(fs.lstatSync(backup, { bigint: true }).ino, before.stat.ino);
      else assert.equal(fs.lstatSync(backup, { bigint: true }).ino, before.stat.ino);
    }
  });
}

test("fixed backup verification respects the caller's cumulative deadline", darwin, async t => {
  const f = fixture(t), before = await oldLock(f), env = deadlinePreload(f, "backup");
  const result = await start(f, childScript, ["backup-budget", "7500"], env).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assert.deepEqual(fs.readFileSync(f.lock), before.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, before.stat.ino);
});

// 正規 authorization による backup 作成は CLI の crash E2E で確認する。
for (const mode of ["prepare-conflicting-marker", "prepare-orphan-backup"]) {
  test(`fixed backup preparation preserves the old lock for ${mode}`, darwin, async t => {
    const f = fixture(t), before = await oldLock(f);
    const result = await start(f, childScript, [mode, "7500"]).child.closed;
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /GUARD_EXPIRED/);
    assert.deepEqual(fs.readFileSync(f.lock), before.bytes);
    assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, before.stat.ino);
    const dir = path.join(f.stateDir, ".darwin-legacy-migration"), marker = path.join(dir, "transition.json"), backup = path.join(dir, "legacy-state.lock");
    if (mode === "prepare-conflicting-marker") {
      assert.equal(fs.readFileSync(marker, "utf8"), "{unknown");
      assert.equal(fs.existsSync(backup), false);
      assert.equal(fs.lstatSync(f.lock, { bigint: true }).nlink, 1n);
    } else {
      assert.equal(fs.readFileSync(backup, "utf8"), "unknown\n");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.lstatSync(f.lock, { bigint: true }).nlink, 1n);
    }
  });
}

for (const mode of ["prepare-missing-authorization", "prepare-forged-authorization"]) {
  test(`fixed backup preparation requires offline authorization for ${mode}`, darwin, async t => {
    const f = fixture(t), before = await oldLock(f);
    const result = await start(f, childScript, [mode, "7500"]).child.closed;
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /GUARD_EXPIRED/);
    const dir = path.join(f.stateDir, ".darwin-legacy-migration");
    assert.equal(fs.existsSync(path.join(dir, "transition.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "legacy-state.lock")), false);
    assertOldLock(f, before);
  });
}

for (const mode of ["release-missing-authorization", "release-forged-authorization", "release-other-guard"]) {
  test(`fixed legacy name release requires offline authorization for ${mode}`, darwin, async t => {
    const f = fixture(t), before = await oldLock(f);
    const result = await start(f, childScript, [mode, "7500"]).child.closed;
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /GUARD_EXPIRED/);
    const backup = path.join(f.stateDir, ".darwin-legacy-migration", "legacy-state.lock");
    const stat = fs.lstatSync(backup, { bigint: true });
    assert.equal(stat.dev, before.stat.dev);
    assert.equal(stat.ino, before.stat.ino);
    assert.deepEqual(fs.readFileSync(backup), before.bytes);
    assert.deepEqual(fs.readFileSync(f.lock), before.bytes);
    assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, before.stat.ino);
    assert.equal(stat.nlink, 2n);
  });
}

test("barrier preparation rejects raw offline booleans without fixed authorization", darwin, async t => {
  const f = fixture(t), before = await oldLock(f);
  const result = await start(f, childScript, ["unauthorized-barrier", "7500"]).child.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /GUARD_EXPIRED/);
  assert.equal(fs.existsSync(f.lock), false);
  const backup = path.join(f.stateDir, ".darwin-legacy-migration", "legacy-state.lock");
  assert.equal(fs.lstatSync(backup, { bigint: true }).ino, before.stat.ino);
  assert.deepEqual(fs.readFileSync(backup), before.bytes);
});

test("a symlink guard is rejected without touching its target", darwin, async t => {
  const f = fixture(t), before = await oldLock(f), dir = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(dir, { mode: 0o700 });
  const target = path.join(f.root, "guard-target"), guard = path.join(dir, "native.lock");
  fs.writeFileSync(target, "unchanged\n", { mode: 0o600 });
  fs.symlinkSync(target, guard);
  try {
    const result = await start(f, childScript).child.closed;
    assert.notEqual(result.code, 0, result.output);
    assert.equal(fs.readFileSync(target, "utf8"), "unchanged\n");
    assert.ok(fs.lstatSync(guard).isSymbolicLink());
    assertOldLock(f, before);
  } finally {
    if (fs.lstatSync(guard).isSymbolicLink() && fs.readlinkSync(guard) === target) fs.unlinkSync(guard);
    else f.retain = true;
  }
});

test("a hardlinked guard is rejected without changing either name", darwin, async t => {
  const f = fixture(t), before = await oldLock(f), dir = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(dir, { mode: 0o700 });
  const target = path.join(f.root, "guard-target"), guard = path.join(dir, "native.lock");
  fs.writeFileSync(target, "", { mode: 0o600 });
  fs.linkSync(target, guard);
  const initial = fs.lstatSync(target, { bigint: true });
  const result = await start(f, childScript).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.equal(fs.lstatSync(target, { bigint: true }).ino, initial.ino);
  assert.equal(fs.lstatSync(guard, { bigint: true }).ino, initial.ino);
  assert.equal(fs.lstatSync(guard, { bigint: true }).nlink, 2n);
  assertOldLock(f, before);
});
