import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { inspectPosixStateLockScope } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { removeTempFixture } from "./helpers.mjs";

// 失敗条件: backup からの未検証再開、partial barrier の削除・再作成、旧 inode の消失。
const darwin = { skip: process.platform !== "darwin", timeout: 90000 };
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const oldHolder = fileURLToPath(new URL("./fixtures/darwin-126-file-lock-holder.mjs", import.meta.url));
const stateApi = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const originalTemp = path.resolve(os.tmpdir()), parent = fs.realpathSync.native(originalTemp);
  const relative = path.relative(repository, parent);
  assert.ok(path.isAbsolute(parent) && (relative === ".." || relative.startsWith(`..${path.sep}`)));
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-old-lock-crash-"));
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

function start(f, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, { cwd: f.cwd, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  child.closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.retain = true; child.kill("SIGKILL"); reject(new Error(`child timed out: ${errors}`)); }, 40000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); f.children.delete(child); resolve({ code, signal, output, errors }); });
  });
  f.children.add(child);
  return { child, get output() { return output; }, get errors() { return errors; } };
}

async function waitFor(owner, predicate, label) {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error(`child exited before ${label}: ${owner.errors} ${owner.output}`);
    if (Date.now() >= deadline) throw new Error(`child did not reach ${label}: ${owner.errors}`);
    await pause(20);
  }
}

async function oldLock(f) {
  const owner = start(f, [oldHolder, f.stateDir]);
  await waitFor(owner, () => owner.output.includes("LEGACY_LOCK_HELD\n"), "old lock");
  const bytes = fs.readFileSync(f.lock), stat = fs.lstatSync(f.lock, { bigint: true });
  assert.equal(bytes.toString("utf8"), `${owner.child.pid}\n`);
  owner.child.kill("SIGKILL");
  assert.equal((await owner.child.closed).signal, "SIGKILL");
  return { bytes, stat };
}

function admissions(f) {
  // 配布版 1.0.26 に admission はない。未出荷の混在状態として合成する。
  const brokerDir = path.join(f.stateDir, "broker-v2"), directDir = path.join(f.stateDir, "direct-start-v1");
  fs.mkdirSync(brokerDir, { mode: 0o700 });
  fs.mkdirSync(directDir, { mode: 0o700 });
  const generation = "ea8ba920-9786-4c20-a12c-00434a4186ae";
  const broker = [
    { version: 2, event: "pending", generation, ownerPid: process.pid, platform: "darwin", lockToken: "fixture-owner",
      endpoint: "unix:/old/b", sessionDir: f.root, pidFile: path.join(f.root, "old.pid"), logFile: path.join(f.root, "old.log") },
    { version: 2, event: "spawned", generation, pid: null, pgid: null },
    { version: 2, event: "settled", generation, pid: null, outcome: "stopped" },
    { version: 2, event: "confirmed", generation, pid: null, outcome: "stopped" }
  ];
  const scope = inspectPosixStateLockScope(f.stateDir);
  const ownerIdentity = { stateDir: f.stateDir, directoryIdentity: scope.directoryIdentity, hostId: scope.hostId, volumeGuid: null };
  const direct = [
    { version: 1, event: "pending", generation, ownerPid: process.pid, ownerIdentity },
    { version: 1, event: "released", generation, proof: "never-started" },
    { version: 1, event: "confirmed", generation, proof: "never-started" }
  ];
  const brokerFile = path.join(brokerDir, "broker-admission.jsonl"), directFile = path.join(directDir, `${generation}.jsonl`);
  const brokerBytes = Buffer.from(broker.map(item => JSON.stringify(item)).join("\n") + "\n");
  const directBytes = Buffer.from(direct.map(item => JSON.stringify(item)).join("\n") + "\n");
  fs.writeFileSync(brokerFile, brokerBytes, { mode: 0o600 });
  fs.writeFileSync(directFile, directBytes, { mode: 0o600 });
  return { brokerFile, brokerBytes, directFile, directBytes, brokerStat: fs.lstatSync(brokerFile, { bigint: true }), directStat: fs.lstatSync(directFile, { bigint: true }),
    preservedBroker: path.join(f.stateDir, ".darwin-legacy-migration", "broker-admission-preserved.jsonl"),
    preservedDirect: path.join(f.stateDir, ".darwin-legacy-migration", "direct-start-v1-preserved", `${generation}.jsonl`) };
}

function assertAdmissions(records) {
  for (const [file, bytes, before] of [[records.brokerFile, records.brokerBytes, records.brokerStat], [records.directFile, records.directBytes, records.directStat]]) {
    const after = fs.lstatSync(file, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  assert.equal(fs.existsSync(records.preservedBroker), false);
  assert.equal(fs.existsSync(records.preservedDirect), false);
}

function migrationArgs(f) {
  return [cli, "state-lock", "migrate", "--offline-confirmed", "--local-only", "--all-old-processes-stopped", "--expected-state-dir", f.stateDir, "--cwd", f.cwd, "--json"];
}

function gate(f, stage) {
  const preload = path.join(f.root, `gate-${stage}.cjs`), marker = path.join(f.root, `reached-${stage}`);
  fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), moduleApi=require('node:module'), original=fs.mkdirSync;
let stopped=false;
fs.mkdirSync=function(target,...args){
  if(!stopped && String(target)===process.env.MIGRATION_GATE_LOCK) {
    const pause=()=>{stopped=true;fs.writeFileSync(process.env.MIGRATION_GATE_MARKER,'reached',{mode:0o600});process.kill(process.pid,'SIGSTOP');};
    if(process.env.MIGRATION_GATE_STAGE==='before') pause();
    const result=original.call(this,target,...args);
    if(process.env.MIGRATION_GATE_STAGE==='after') pause();
    return result;
  }
  return original.call(this,target,...args);
};
moduleApi.syncBuiltinESMExports();`, { mode: 0o600 });
  return { marker, env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, MIGRATION_GATE_LOCK: f.lock,
    MIGRATION_GATE_MARKER: marker, MIGRATION_GATE_STAGE: stage } };
}

function assertUnchanged(f, old, records) {
  const after = fs.lstatSync(f.lock, { bigint: true });
  assert.equal(after.dev, old.stat.dev);
  assert.equal(after.ino, old.stat.ino);
  assert.deepEqual(fs.readFileSync(f.lock), old.bytes);
  assert.deepEqual(fs.readFileSync(f.stateFile), f.state);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
  assertAdmissions(records);
}

for (const stage of ["before", "after"]) {
  test(`old lock migration refuses before the ${stage} barrier mkdir crash gate`, darwin, async t => {
    const f = fixture(t), old = await oldLock(f), records = admissions(f), point = gate(f, stage);
    const owner = start(f, migrationArgs(f), point.env);
    const result = await owner.child.closed;
    assert.notEqual(result.code, 0, result.errors + result.output);
    assert.match(result.errors + result.output, /completion evidence is unavailable/i);
    assert.equal(fs.existsSync(point.marker), false, "unintegrated crash gate was reached");
    assertUnchanged(f, old, records);
  });
}

// 未統合のため旧 crash gate は到達しない。注入コードは復旧実装の検証用に残す。
for (const stage of ["backup-linked", "old-name-unlinked"]) {
  test(`old lock migration refuses before the ${stage} crash gate`, darwin, async t => {
    const f = fixture(t), old = await oldLock(f), records = admissions(f);
    const preload = path.join(f.root, `gate-${stage}.cjs`), marker = path.join(f.root, `reached-${stage}`);
    fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), moduleApi=require('node:module');
const link=fs.linkSync, unlink=fs.unlinkSync;
function pause(){fs.writeFileSync(process.env.MIGRATION_GATE_MARKER,'reached',{mode:0o600});process.kill(process.pid,'SIGSTOP');}
fs.linkSync=function(source,target,...args){
  const result=link.call(this,source,target,...args);
  if(process.env.MIGRATION_GATE_STAGE==='backup-linked' && String(target)===process.env.MIGRATION_GATE_BACKUP) pause();
  return result;
};
fs.unlinkSync=function(target,...args){
  const result=unlink.call(this,target,...args);
  if(process.env.MIGRATION_GATE_STAGE==='old-name-unlinked' && String(target)===process.env.MIGRATION_GATE_LOCK) pause();
  return result;
};
moduleApi.syncBuiltinESMExports();`, { mode: 0o600 });
    const backup = path.join(f.stateDir, ".darwin-legacy-migration", "legacy-state.lock");
    const owner = start(f, migrationArgs(f), { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      MIGRATION_GATE_MARKER: marker, MIGRATION_GATE_STAGE: stage, MIGRATION_GATE_LOCK: f.lock, MIGRATION_GATE_BACKUP: backup });
    const result = await owner.child.closed;
    assert.notEqual(result.code, 0, result.errors + result.output);
    assert.match(result.errors + result.output, /completion evidence is unavailable/i);
    assert.equal(fs.existsSync(marker), false, "unintegrated crash gate was reached");
    assertUnchanged(f, old, records);
  });
}

test("old lock migration refuses before copying independent admissions", darwin, async t => {
  const f = fixture(t), old = await oldLock(f), records = admissions(f);
  const secondName = "fa8ba920-9786-4c20-a12c-00434a4186ae.jsonl";
  const secondSource = path.join(path.dirname(records.directFile), secondName);
  const secondBytes = Buffer.from(records.directBytes.toString("utf8").replaceAll("ea8ba920-9786-4c20-a12c-00434a4186ae", secondName.slice(0, -6)));
  fs.writeFileSync(secondSource, secondBytes, { mode: 0o600 });
  const secondStat = fs.lstatSync(secondSource, { bigint: true });
  const secondCopy = path.join(path.dirname(records.preservedDirect), secondName);
  const preload = path.join(f.root, "gate-copy.cjs"), marker = path.join(f.root, "reached-copy");
  fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), moduleApi=require('node:module'), open=fs.openSync;
fs.openSync=function(target,...args){
  if(String(target)===process.env.MIGRATION_GATE_COPY){
    fs.writeFileSync(process.env.MIGRATION_GATE_MARKER,'reached',{mode:0o600});process.kill(process.pid,'SIGSTOP');
  }
  return open.call(this,target,...args);
};
moduleApi.syncBuiltinESMExports();`, { mode: 0o600 });
  const owner = start(f, migrationArgs(f), { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    MIGRATION_GATE_COPY: secondCopy, MIGRATION_GATE_MARKER: marker });
  const result = await owner.child.closed;
  assert.notEqual(result.code, 0, result.errors + result.output);
  assert.match(result.errors + result.output, /completion evidence is unavailable/i);
  assert.equal(fs.existsSync(marker), false, "unintegrated admission copy gate was reached");
  assert.equal(fs.existsSync(secondCopy), false);
  const after = fs.lstatSync(secondSource, { bigint: true });
  assert.equal(after.dev, secondStat.dev);
  assert.equal(after.ino, secondStat.ino);
  assert.deepEqual(fs.readFileSync(secondSource), secondBytes);
  assertUnchanged(f, old, records);
});

test("unknown preserved broker evidence is retained and blocks migration", darwin, async t => {
  const f = fixture(t), old = await oldLock(f);
  const directory = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(directory, { mode: 0o700 });
  const unknown = path.join(directory, "broker-admission-preserved.jsonl");
  const bytes = Buffer.from("unverified evidence\n");
  fs.writeFileSync(unknown, bytes, { mode: 0o600 });
  const before = fs.lstatSync(unknown, { bigint: true });
  const result = await start(f, migrationArgs(f)).child.closed;
  assert.notEqual(result.code, 0, result.output);
  assert.equal(fs.lstatSync(unknown, { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(unknown), bytes);
  assert.equal(fs.lstatSync(f.lock, { bigint: true }).ino, old.stat.ino);
  assert.deepEqual(fs.readFileSync(f.lock), old.bytes);
  assert.deepEqual(fs.readFileSync(f.stateFile), f.state);
});
