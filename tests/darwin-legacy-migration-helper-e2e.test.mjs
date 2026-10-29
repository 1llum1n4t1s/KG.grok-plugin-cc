import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeTempFixture } from "./helpers.mjs";

// 失敗条件: 偽 callback で未検証 state が移行される、切替中の旧 inode 消失、
// guard 分裂、異常終了や I/O 失敗後の無記録起動、symlink/hardlink の採用。
const darwin = { skip: process.platform !== "darwin", timeout: 90000 };
const childScript = fileURLToPath(new URL("./fixtures/darwin-legacy-migration-helper-child.mjs", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const originalTemp = path.resolve(os.tmpdir());
  const parent = fs.realpathSync.native(originalTemp);
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-lock-migration-"));
  const cleanupTarget = path.join(originalTemp, path.basename(root));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const lock = path.join(stateDir, "state.lock"), bytes = Buffer.from("123456\n");
  fs.writeFileSync(lock, bytes, { mode: 0o600 });
  const before = fs.lstatSync(lock, { bigint: true });
  const f = { root, stateDir, lock, bytes, before, retain: false, children: new Set() };
  t.after(async () => {
    for (const child of f.children) {
      f.retain = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.closed;
    }
    if (f.retain) t.diagnostic(`Preserved interrupted fixture: ${root}`);
    else removeTempFixture(cleanupTarget, { recursive: true, force: true });
  });
  return f;
}

function launch(f, { mode = "normal", gate = "", timeout = 7500, preload = null } = {}) {
  const env = { ...process.env, TMPDIR: f.root, TMP: f.root, TEMP: f.root };
  if (preload) env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  const child = spawn(process.execPath, [childScript, f.stateDir, mode, gate, String(timeout)], {
    cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"]
  });
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

function backup(f) { return path.join(f.stateDir, ".darwin-legacy-migration", "legacy-state.lock"); }
function assertBackup(f) {
  assert.deepEqual(fs.readFileSync(backup(f)), f.bytes);
  const actual = fs.lstatSync(backup(f), { bigint: true });
  assert.equal(actual.dev, f.before.dev);
  assert.equal(actual.ino, f.before.ino);
  assert.equal(actual.nlink, 1n);
}

async function atGate(processHandle, gate) {
  const deadline = Date.now() + 25000;
  while (!processHandle.output.includes(`PAUSE:${gate}\n`)) {
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) throw new Error(`child exited before ${gate}: ${processHandle.errors} ${processHandle.output}`);
    if (Date.now() >= deadline) throw new Error(`child did not reach ${gate}: ${processHandle.errors}`);
    await pause(20);
  }
}

function preload(f, kind) {
  const file = path.join(f.root, `fault-${kind}.cjs`);
  const source = String.raw`
const fs=require('node:fs'), cp=require('node:child_process'), mod=require('node:module');
const fail=()=>Object.assign(new Error('injected I/O failure'),{code:'EIO'});
const kind=process.env.FIXTURE_FAULT;
if(kind==='fsync') fs.fsyncSync=()=>{throw fail()};
if(kind==='marker-fsync') {
  const opened=fs.openSync, closed=fs.closeSync, sync=fs.fsyncSync, watched=new Set();
  fs.openSync=(name,...args)=>{const fd=opened(name,...args); if(String(name).endsWith('/.darwin-legacy-migration/transition.json')) watched.add(fd); return fd;};
  fs.closeSync=fd=>{watched.delete(fd); return closed(fd);};
  fs.fsyncSync=fd=>{if(watched.has(fd)) throw fail(); return sync(fd);};
}
if(kind==='link') {const original=fs.linkSync; fs.linkSync=(from,to)=>{
  if(String(to).endsWith('/.darwin-legacy-migration/legacy-state.lock')) throw fail(); return original(from,to);
};}
if(kind==='lock' || kind==='timeout') {const original=cp.execFileSync; cp.execFileSync=(bin,...args)=>{
  if(bin==='/usr/bin/lockf') throw Object.assign(new Error('injected lock failure'),{status:kind==='timeout'?75:2});
  return original(bin,...args);
};}
mod.syncBuiltinESMExports();`;
  fs.writeFileSync(file, source, { mode: 0o600 });
  return file;
}

function assertDisabled(f, result) {
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /requires the fixed v4 state migration and mutex capability/i);
  const after = fs.lstatSync(f.lock, { bigint: true });
  assert.equal(after.dev, f.before.dev);
  assert.equal(after.ino, f.before.ino);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "worker-leases")), false);
}

test("disabled helper repeatedly preserves the original inode", darwin, async t => {
  const f = fixture(t);
  assertDisabled(f, await launch(f).child.closed);
  assertDisabled(f, await launch(f).child.closed);
});

test("forged verification callbacks cannot remove the old lock", darwin, async t => {
  const f = fixture(t), unknown = path.join(f.stateDir, "unknown-record");
  fs.writeFileSync(unknown, "keep\n");
  const result = await launch(f, { mode: "forged" }).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, f.before.ino);
  assert.equal(fs.readFileSync(unknown, "utf8"), "keep\n");
});

test("disabled helper does not invoke the forged physical barrier callback", darwin, async t => {
  const f = fixture(t), result = await launch(f, { mode: "forged-barrier" }).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assertDisabled(f, result);
});

for (const mode of ["truthy-offline", "truthy-local"]) {
  test(`disabled helper does not proceed with non-boolean ${mode} confirmation`, darwin, async t => {
    const f = fixture(t), result = await launch(f, { mode }).child.closed;
    assert.notEqual(result.code, 0, result.output);
    assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
    assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, f.before.ino);
  });
}

test("disabled helper does not invoke an async inventory callback", darwin, async t => {
  const f = fixture(t), result = await launch(f, { mode: "async-callback" }).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.equal(fs.existsSync(path.join(f.stateDir, "async-effect")), false);
});

test("disabled helper does not invoke the rejected thenable callback", darwin, async t => {
  const f = fixture(t), result = await launch(f, { mode: "reject-thenable" }).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.doesNotMatch(result.output, /UNHANDLED/);
});

test("disabled helper does not invoke the reentry callback", darwin, async t => {
  const f = fixture(t), result = await launch(f, { mode: "reentry" }).child.closed;
  assertDisabled(f, result);
});

test("disabled helper preserves a preexisting transition marker", darwin, async t => {
  const f = fixture(t), directory = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(directory, { mode: 0o700 });
  const marker = path.join(directory, "transition.json"), bytes = Buffer.from("{changed");
  fs.writeFileSync(marker, bytes, { mode: 0o600 });
  const before = fs.lstatSync(marker, { bigint: true });
  const result = await launch(f).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /requires the fixed v4 state migration/i);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, f.before.ino);
  assert.equal(fs.lstatSync(marker, { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(marker), bytes);
});

test("disabled helper preserves transition evidence without attempting synchronization", darwin, async t => {
  const f = fixture(t), directory = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(directory, { mode: 0o700 });
  const marker = path.join(directory, "transition.json"), bytes = Buffer.from("{pending");
  fs.writeFileSync(marker, bytes, { mode: 0o600 });
  const before = fs.lstatSync(marker, { bigint: true });
  const file = preload(f, "marker-fsync"), previous = process.env.FIXTURE_FAULT;
  process.env.FIXTURE_FAULT = "marker-fsync";
  try {
    const result = await launch(f, { preload: file }).child.closed;
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /requires the fixed v4 state migration/i);
    assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
    assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, f.before.ino);
    assert.equal(fs.lstatSync(marker, { bigint: true }).ino, before.ino);
    assert.deepEqual(fs.readFileSync(marker), bytes);
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_FAULT;
    else process.env.FIXTURE_FAULT = previous;
  }
});

for (const gate of ["transition-synced", "backup-linked", "backup-synced", "legacy-name-unlinked", "legacy-name-synced"]) {
  test(`disabled helper refuses before the ${gate} crash gate`, darwin, async t => {
    const f = fixture(t), result = await launch(f, { gate }).child.closed;
    assertDisabled(f, result);
    assert.doesNotMatch(result.output, /PAUSE:/);
  });
}

for (const kind of ["fsync", "link", "lock", "timeout"]) {
  test(`disabled helper refuses before injected ${kind} failure`, darwin, async t => {
    const f = fixture(t), file = preload(f, kind);
    const previous = process.env.FIXTURE_FAULT;
    process.env.FIXTURE_FAULT = kind;
    try {
      const result = await launch(f, { preload: file, timeout: kind === "timeout" ? 300 : 7500 }).child.closed;
      assertDisabled(f, result);
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_FAULT;
      else process.env.FIXTURE_FAULT = previous;
    }
  });
}

test("parallel disabled migration processes preserve the old lock", darwin, async t => {
  const f = fixture(t), first = launch(f, { gate: "transition-synced" }), second = launch(f, { timeout: 300 });
  const [a, b] = await Promise.all([first.child.closed, second.child.closed]);
  assertDisabled(f, a);
  assertDisabled(f, b);
  assert.doesNotMatch(a.output, /PAUSE:/);
});

test("helper refuses a preexisting hardlink without altering either name", darwin, async t => {
  const f = fixture(t), alias = path.join(f.root, "alias");
  fs.linkSync(f.lock, alias);
  const result = await launch(f).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.deepEqual(fs.readFileSync(alias), f.bytes);
  assert.equal(fs.lstatSync(alias, { bigint: true }).ino, f.before.ino);
});

test("helper refuses a symbolic legacy lock without touching its target", darwin, async t => {
  const f = fixture(t), target = path.join(f.root, "lock-target");
  fs.renameSync(f.lock, target);
  fs.symlinkSync(target, f.lock);
  try {
    const result = await launch(f).child.closed;
    assert.notEqual(result.code, 0, result.output);
    assert.ok(fs.lstatSync(f.lock).isSymbolicLink());
    assert.equal(fs.readlinkSync(f.lock), target);
    assert.deepEqual(fs.readFileSync(target), f.bytes);
  } finally {
    const current = fs.lstatSync(f.lock);
    if (current.isSymbolicLink() && fs.readlinkSync(f.lock) === target) fs.unlinkSync(f.lock);
    else f.retain = true;
  }
});

test("disabled helper preserves a corrupt transition marker and old lock", darwin, async t => {
  const f = fixture(t), directory = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(directory, { mode: 0o700 });
  const marker = path.join(directory, "transition.json"), bytes = Buffer.from("{corrupt");
  fs.writeFileSync(marker, bytes, { mode: 0o600 });
  const before = fs.lstatSync(marker, { bigint: true });
  const result = await launch(f).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /requires the fixed v4 state migration/i);
  assert.deepEqual(fs.readFileSync(f.lock), f.bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, f.before.ino);
  assert.equal(fs.lstatSync(marker, { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(marker), bytes);
});
