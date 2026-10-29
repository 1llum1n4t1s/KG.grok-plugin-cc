import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { migratePosixStateLock as migrateV2, inspectPosixStateLockScope } from "./fixtures/darwin-v2-posix-state-lock.mjs";
import { removeTempFixture } from "./helpers.mjs";

// 起動前に想定する失敗: 未確認・破損履歴の受入れ、旧世代との衝突、旧 writer の
// 同時書込み、原本の消失、容量不足による起動拒否、停止未確認の子プロセス残存。
const darwin = { skip: process.platform !== "darwin", timeout: 90000 };
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;

function fixture(t, protocol = "v2", withJournal = true) {
  const parent = fs.realpathSync.native(os.tmpdir());
  assert.ok(path.isAbsolute(parent));
  const relative = path.relative(repository, parent);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`));
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-broker-compact-"));
  const cleanupTarget = path.join(path.resolve(os.tmpdir()), path.basename(root));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const dir of [workspace, data, temp]) fs.mkdirSync(dir, { mode: 0o700 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "TMPDIR", "TMP", "TEMP"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, TMPDIR: temp, TMP: temp, TEMP: temp });
  const stateDir = resolveStateDir(workspace);
  const brokerDir = path.join(stateDir, "broker-v2");
  const journal = path.join(brokerDir, "broker-admission.jsonl");
  const f = { root, workspace, data, temp, stateDir, journal, retain: false };
  t.after(() => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    if (f.retain) t.diagnostic(`Preserved fixture for inspection: ${root}`);
    else removeTempFixture(cleanupTarget, { recursive: true, force: true });
  });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (protocol === "v2") migrateV2(stateDir, { expectedStateDir: stateDir });
  else if (protocol === "file-lock" || protocol === "retained-file-lock") {
    const generator = fileURLToPath(new URL("./fixtures/darwin-legacy-file-lock-state.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [generator, stateDir, ...(protocol === "retained-file-lock" ? ["retain-lock"] : [])], { cwd: workspace, env: process.env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(stateDir, "state.lock")), protocol === "retained-file-lock");
  } else throw new Error(`Unknown fixture protocol: ${protocol}`);
  if (withJournal) fs.mkdirSync(brokerDir, { mode: 0o700 });
  return f;
}

function confirmedJournal(f, large = false) {
  const records = [], generations = new Set();
  let size = 0, number = 0;
  const target = large ? 4 * 1024 * 1024 - 3 * 65536 + 1024 : 1;
  while (size < target) {
    // v2 は UUID 以外も受理するため、新 namespace と似た旧 generation を含める。
    const generation = number === 0 ? "v3:collision:1" : `old-generation-${number}`;
    generations.add(generation);
    const lines = [
      { version: 2, event: "pending", generation, ownerPid: process.pid, platform: "darwin", lockToken: "old-owner",
        endpoint: "unix:/old/b", sessionDir: f.root, pidFile: path.join(f.root, "old.pid"),
        logFile: large ? "x".repeat(24000) : path.join(f.root, "old.log") },
      { version: 2, event: "spawned", generation, pid: null, pgid: null },
      { version: 2, event: "settled", generation, pid: null, outcome: "stopped" },
      { version: 2, event: "confirmed", generation, pid: null, outcome: "stopped" }
    ];
    const bytes = Buffer.from(lines.map(record => JSON.stringify(record)).join("\n") + "\n");
    records.push(bytes); size += bytes.length; number++;
  }
  assert.ok(size <= 4 * 1024 * 1024);
  return { bytes: Buffer.concat(records), generations };
}

function directMarker(f, confirmed = true) {
  const dir = path.join(f.stateDir, "direct-start-v1");
  fs.mkdirSync(dir, { mode: 0o700 });
  const generation = "e958695e-fdbc-4295-8ae8-419cedb35436";
  const file = path.join(dir, `${generation}.jsonl`);
  const scope = inspectPosixStateLockScope(f.stateDir);
  const records = [{ version: 1, event: "pending", generation, ownerPid: process.pid,
    ownerIdentity: { stateDir: f.stateDir, directoryIdentity: scope.directoryIdentity, hostId: scope.hostId, volumeGuid: null } }];
  if (confirmed) records.push(
    { version: 1, event: "released", generation, proof: "never-started" },
    { version: 1, event: "confirmed", generation, proof: "never-started" });
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { file, bytes };
}

function migrate(f) {
  return spawnSync(process.execPath, [cli, "state-lock", "migrate", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", f.stateDir, "--cwd", f.workspace, "--json"], {
    cwd: f.workspace, env: process.env, encoding: "utf8", timeout: 30000
  });
}

function containsExactFile(dir, expected) {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile() && fs.statSync(name).size === expected.length && fs.readFileSync(name).equals(expected)) return true;
    }
  }
  return false;
}

async function oldWriter(f) {
  const entered = path.join(f.root, "old-writer-entered");
  const child = fork(new URL("./fixtures/darwin-v2-state-writer.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    child.send({ stateDir: f.stateDir, entered });
    const [answer] = await once(child, "message");
    assert.equal(answer.accepted, false, "old v2 writer entered the migrated state");
    assert.equal(fs.existsSync(entered), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

async function oldFileLockWriter(f) {
  const child = fork(new URL("./fixtures/darwin-legacy-file-lock-writer.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    child.send({ stateDir: f.stateDir, expectedParent: path.dirname(f.stateDir) });
    const [answer] = await once(child, "message");
    assert.equal(answer.writeCode, "EEXIST", "old file-lock writer entered the migrated state");
    assert.notEqual(answer.cleanupCode, "removed", "old writer removed the new state barrier");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

async function startAndStopBroker(f) {
  const fake = path.join(f.root, "fake-grok");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  const result=m.method==='initialize' ? {protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}
    : m.method==='session/new' ? {sessionId:'test-session'} : m.method==='session/list' ? {sessions:[]}
    : m.method==='session/prompt' ? {stopReason:'end_turn'} : {};
  if (m.id!==undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`, { mode: 0o755 });
  const source = `import {ensureBrokerSession,cleanupIdleBrokerSession} from ${JSON.stringify(lifecycle)};
let session; try { session=await ensureBrokerSession(${JSON.stringify(f.workspace)}, {timeoutMs:15000});
  let cleaned=false; for(let i=0;i<20&&!cleaned;i++){cleaned=await cleanupIdleBrokerSession(${JSON.stringify(f.workspace)},session,{timeoutMs:5000});
  if(!cleaned) await new Promise(r=>setTimeout(r,50));} console.log(JSON.stringify({session,cleaned}));
} catch(e) {console.log(JSON.stringify({error:e.message,started:!!session,cleaned:false}));}`;
  const env = { ...process.env, GROK_BIN: fake, HOME: f.root, USERPROFILE: f.root };
  delete env.GROK_COMPANION_ACP_ENDPOINT; delete env.XAI_API_KEY;
  // 子とその agent の停止が証明できるまで fixture を削除しない。
  f.retain = true;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.retain = true; child.kill("SIGKILL"); reject(new Error(`broker probe timed out: ${stderr}`)); }, 40000);
    child.once("error", error => { clearTimeout(timer); f.retain = true; reject(error); });
    child.once("close", result => { clearTimeout(timer); resolve(result); });
  });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.cleaned, true, "broker termination was not confirmed");
  f.retain = false;
  assert.ok(result.session?.generation);
  return result.session.generation;
}

function captureFile(file) {
  return { file, bytes: fs.readFileSync(file), stat: fs.lstatSync(file, { bigint: true }) };
}

function assertFileUnchanged(before) {
  const after = fs.lstatSync(before.file, { bigint: true });
  assert.equal(after.dev, before.stat.dev);
  assert.equal(after.ino, before.stat.ino);
  assert.deepEqual(fs.readFileSync(before.file), before.bytes);
}

test("offline migration refuses the old v2 marker and preserves confirmed journal", darwin, t => {
  const f = fixture(t), old = confirmedJournal(f, true);
  fs.writeFileSync(f.journal, old.bytes, { mode: 0o600 });
  const journal = captureFile(f.journal);
  const marker = captureFile(path.join(f.stateDir, "state.lock", "protocol.json"));
  const result = migrate(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assertFileUnchanged(journal);
  assertFileUnchanged(marker);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
});

test("offline migration preserves a released shipped file-lock state", darwin, async t => {
  const f = fixture(t, "file-lock", false);
  // 配布版には broker-admission がないため、このケースでは合成 journal を配置しない。
  const stateFile = path.join(f.stateDir, "state.json"), before = fs.readFileSync(stateFile);
  const result = migrate(f);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readFileSync(stateFile), before);
  await oldFileLockWriter(f);
});

test("offline migration refuses the retained lock from a stopped legacy writer", darwin, t => {
  const f = fixture(t, "retained-file-lock", false);
  const lock = captureFile(path.join(f.stateDir, "state.lock"));
  const state = captureFile(path.join(f.stateDir, "state.json"));
  assert.match(lock.bytes.toString("utf8"), /^[1-9]\d*\n$/);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = migrate(f);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assertFileUnchanged(lock);
    assertFileUnchanged(state);
    assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
  }
});

test("offline migration refuses retained lock with confirmed synthetic admissions", darwin, t => {
  const f = fixture(t, "retained-file-lock"), broker = confirmedJournal(f), direct = directMarker(f);
  fs.writeFileSync(f.journal, broker.bytes, { mode: 0o600 });
  const files = [path.join(f.stateDir, "state.lock"), path.join(f.stateDir, "state.json"), f.journal, direct.file].map(captureFile);
  const result = migrate(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  for (const file of files) assertFileUnchanged(file);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
});

for (const kind of ["pending-broker", "pending-direct", "corrupt-direct", "unknown-direct", "foreign-host", "foreign-state"]) {
  test(`offline migration preserves retained old lock when ${kind} is unverified`, darwin, t => {
    const f = fixture(t, "retained-file-lock"), lock = path.join(f.stateDir, "state.lock");
    const oldLock = fs.readFileSync(lock), complete = confirmedJournal(f).bytes;
    const broker = kind === "pending-broker" ? complete.subarray(0, complete.indexOf(10) + 1) : complete;
    fs.writeFileSync(f.journal, broker, { mode: 0o600 });
    const direct = directMarker(f, kind !== "pending-direct");
    if (kind === "corrupt-direct") fs.writeFileSync(direct.file, '{"version":1', { mode: 0o600 });
    if (kind === "unknown-direct") fs.writeFileSync(path.join(path.dirname(direct.file), "unexpected"), "retain\n");
    if (kind === "foreign-host" || kind === "foreign-state") {
      const records = direct.bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      if (kind === "foreign-host") records[0].ownerIdentity.hostId += "-foreign";
      else records[0].ownerIdentity.directoryIdentity.ino = String(BigInt(records[0].ownerIdentity.directoryIdentity.ino) + 1n);
      fs.writeFileSync(direct.file, records.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    }
    const directBytes = fs.readFileSync(direct.file);
    const snapshots = [lock, f.journal, direct.file, path.join(f.stateDir, "state.json")].map(captureFile);
    const result = migrate(f);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `migration accepted ${kind}`);
    assert.match(result.stderr + result.stdout, /completion evidence is unavailable/i);
    for (const snapshot of snapshots) assertFileUnchanged(snapshot);
    assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
    assert.deepEqual(fs.readFileSync(lock), oldLock);
    assert.deepEqual(fs.readFileSync(f.journal), broker);
    assert.deepEqual(fs.readFileSync(direct.file), directBytes);
    if (kind === "unknown-direct") assert.equal(fs.readFileSync(path.join(path.dirname(direct.file), "unexpected"), "utf8"), "retain\n");
  });
}

test("offline migration refuses an old lock with an unrelated hard link", darwin, t => {
  const f = fixture(t, "retained-file-lock", false);
  const lock = path.join(f.stateDir, "state.lock"), alias = path.join(f.root, "unrelated-lock-link");
  const before = fs.readFileSync(lock), identity = fs.lstatSync(lock, { bigint: true });
  fs.linkSync(lock, alias);
  assert.equal(fs.lstatSync(lock, { bigint: true }).nlink, 2n);
  const result = migrate(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(lock), before);
  assert.deepEqual(fs.readFileSync(alias), before);
  assert.equal(fs.lstatSync(lock, { bigint: true }).ino, identity.ino);
  assert.equal(fs.lstatSync(alias, { bigint: true }).ino, identity.ino);
});

test("offline migration refuses an unparseable old file lock without changing it", darwin, t => {
  const f = fixture(t, "retained-file-lock", false), lock = path.join(f.stateDir, "state.lock");
  const bytes = Buffer.from("not-an-old-owner\n");
  fs.writeFileSync(lock, bytes);
  const identity = fs.lstatSync(lock, { bigint: true });
  const result = migrate(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(lock), bytes);
  assert.equal(fs.lstatSync(lock, { bigint: true }).ino, identity.ino);
});

test("offline migration refuses shipped state with synthetic confirmed admission", darwin, t => {
  const f = fixture(t, "file-lock"), old = confirmedJournal(f, true);
  fs.writeFileSync(f.journal, old.bytes, { mode: 0o600 });
  const journal = captureFile(f.journal), state = captureFile(path.join(f.stateDir, "state.json"));
  const result = migrate(f);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assertFileUnchanged(journal);
  assertFileUnchanged(state);
  assert.equal(fs.existsSync(path.join(f.stateDir, "state.lock", "protocol.json")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, ".darwin-legacy-migration")), false);
});

for (const kind of ["pending", "settled-only", "corrupt", "legacy", "oversized"]) {
  test(`offline migration refuses and preserves ${kind} broker journal`, darwin, t => {
    const f = fixture(t), complete = confirmedJournal(f).bytes;
    let bytes;
    if (kind === "pending") bytes = complete.subarray(0, complete.indexOf(10) + 1);
    else if (kind === "settled-only") bytes = complete.subarray(0, complete.lastIndexOf(10, complete.length - 2) + 1);
    else if (kind === "corrupt") bytes = Buffer.from('{"version":2,"event":');
    else if (kind === "legacy") bytes = Buffer.from(complete.toString().replaceAll('"version":2', '"version":1'));
    else bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 120);
    fs.writeFileSync(f.journal, bytes, { mode: 0o600 });
    const journal = captureFile(f.journal), marker = captureFile(path.join(f.stateDir, "state.lock", "protocol.json"));
    const result = migrate(f);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `migration accepted ${kind}`);
    assertFileUnchanged(journal);
    assertFileUnchanged(marker);
    assert.deepEqual(fs.readFileSync(f.journal), bytes);
  });
}
