import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir, withStateLockMigrationScope } from "../plugins/grok/scripts/lib/state.mjs";
import * as state from "../plugins/grok/scripts/lib/state.mjs";
import { acquireDarwinMigrationGuard } from "../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";

// Real macOS CLI and filesystem; all processes and paths are fixture-owned.
// Old runtimes can bypass the guard, so they remain externally stopped.
const mac = { skip: process.platform !== "darwin", timeout: 60000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const crashHook = fileURLToPath(new URL("./fixtures/darwin-migration-guard-crash.cjs", import.meta.url));
const guardHolder = fileURLToPath(new URL("./fixtures/darwin-migration-guard-holder.mjs", import.meta.url));
function fixture(t, { createStateDir = true } = {}) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-darwin-migration-guard-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(() => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    t.diagnostic(`Migration guard fixture retained: ${root}`);
  });
  const stateDir = resolveStateDir(workspace);
  if (createStateDir) fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const args = ["state-lock", "migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  return { root, workspace, stateDir, args, env: { ...process.env },
    guard: path.join(stateDir, ".darwin-legacy-migration", "native.lock") };
}

test("Darwin fresh workspace creates its state and persistent migration guard", mac, t => {
  const f = fixture(t, { createStateDir: false });
  assert.equal(fs.existsSync(f.stateDir), false);
  const result = spawnSync(process.execPath, [cli, ...f.args], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.lstatSync(f.guard).isFile());
  const status = spawnSync(process.execPath, [cli, "status", "--cwd", f.workspace, "--json"], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(status.status, 0, status.stderr);
});
function start(f) {
  const child = spawn(process.execPath, [cli, ...f.args], { env: f.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stderr })); });
  return { child, closed };
}

test("concurrent Darwin migrations use one persistent guard and leave a usable v4 barrier", mac, async t => {
  const f = fixture(t), first = start(f), second = start(f);
  t.after(async () => {
    for (const owner of [first, second]) if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL");
    await Promise.allSettled([first.closed, second.closed]);
  });
  const results = await Promise.all([first.closed, second.closed]);
  assert.ok(results.some(result => result.code === 0), JSON.stringify(results));
  const guard = fs.lstatSync(f.guard, { bigint: true });
  assert.ok(guard.isFile() && guard.nlink === 1n && (guard.mode & 0o077n) === 0n);
  const marker = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8"));
  assert.equal(marker.protocol, "posix-local-v4");
  const status = spawnSync(process.execPath, [cli, "status", "--cwd", f.workspace, "--json"], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(status.status, 0, status.stderr);
  const after = fs.lstatSync(f.guard, { bigint: true });
  assert.equal(after.dev, guard.dev); assert.equal(after.ino, guard.ino);
});

test("Darwin migration crash before barrier creation retains its durable guard", mac, t => {
  const f = fixture(t), barrier = path.join(f.stateDir, "state.lock");
  const interrupted = spawnSync(process.execPath, ["--require", crashHook, cli, ...f.args], {
    env: { ...f.env, GROK_TEST_BARRIER_PATH: barrier }, encoding: "utf8", timeout: 15000
  });
  assert.equal(interrupted.status, 74, interrupted.stderr);
  assert.ok(fs.lstatSync(f.guard).isFile(), "migration reached barrier creation without a guard");
  assert.equal(fs.existsSync(barrier), false);
});

test("Darwin normal migration cannot pass a held migration guard", mac, async t => {
  const f = fixture(t);
  const first = spawnSync(process.execPath, [cli, ...f.args], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(first.status, 0, first.stderr);
  const before = fs.lstatSync(f.guard, { bigint: true });
  const marker = path.join(f.stateDir, "state.lock", "protocol.json"), markerBytes = fs.readFileSync(marker);
  const owner = spawn(process.execPath, [guardHolder, f.guard], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { owner.once("error", reject); owner.once("close", resolve); });
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await closed; });
  const deadline = Date.now() + 10000;
  while (!stdout.includes("guard-held\n") && owner.exitCode === null && owner.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(stdout, /guard-held/, stderr);
  const blocked = spawnSync(process.execPath, [cli, ...f.args], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.notEqual(blocked.status, 0, "migration ignored the held common guard");
  assert.deepEqual(fs.readFileSync(marker), markerBytes);
  owner.kill("SIGKILL"); await closed;
  const retry = spawnSync(process.execPath, [cli, ...f.args], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(retry.status, 0, retry.stderr);
  const after = fs.lstatSync(f.guard, { bigint: true });
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
});

test("Darwin migration scope check rejects a transition that appears after inspection", mac, t => {
  const f = fixture(t);
  const migration = spawnSync(process.execPath, [cli, ...f.args], { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(migration.status, 0, migration.stderr);
  assert.throws(() => withStateLockMigrationScope(f.stateDir, check => {
    const migrationDir = path.dirname(f.guard);
    if (!fs.existsSync(migrationDir)) fs.mkdirSync(migrationDir, { mode: 0o700 });
    const marker = path.join(migrationDir, "transition.json");
    fs.writeFileSync(marker, "pending transition\n", { mode: 0o600 });
    assert.throws(() => check(), /migration|transition|guard/i);
    assert.equal(fs.readFileSync(marker, "utf8"), "pending transition\n");
  }), /migration|transition|guard/i);
});

test("Darwin legacy preflight requires a real guard and preserves old state records", mac, t => {
  const f = fixture(t), jobs = path.join(f.stateDir, "jobs"), index = path.join(f.stateDir, "state.json");
  fs.mkdirSync(jobs, { mode: 0o700 });
  const job = { id: "old-job", status: "completed", createdAt: "2020-01-01T00:00:00.000Z", logFile: null };
  const detail = path.join(jobs, "old-job.json"), indexBytes = JSON.stringify({ version: 1, config: {}, jobs: [job], reviewGateSessions: [] });
  fs.writeFileSync(index, indexBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(detail, JSON.stringify(job), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(f.stateDir, "state.lock"), "12345\n", { flag: "wx", mode: 0o600 });
  const guard = acquireDarwinMigrationGuard(f.stateDir);
  let preflight;
  try {
    assert.equal(typeof state.verifyDarwinLegacyPreflight, "function");
    assert.throws(() => state.verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: { ...guard.context } }));
    preflight = state.verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: guard.context });
    assert.ok(preflight && typeof preflight === "object" && Object.isFrozen(preflight), "preflight must issue an opaque immutable capability");
    assert.equal(typeof state.assertDarwinLegacyPreflightToken, "function");
    const evidence = state.assertDarwinLegacyPreflightToken(preflight, guard.context);
    assert.ok(Object.isFrozen(evidence));
    assert.equal(evidence.size, "6"); assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
    const forged = new Proxy({}, { get() { throw new Error("untrusted token getter was evaluated"); } });
    assert.throws(() => state.assertDarwinLegacyPreflightToken(forged, guard.context), /capability|token/i);
    assert.equal(fs.readFileSync(index, "utf8"), indexBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(detail, "utf8")), job);
  } finally { guard.close(); }
  assert.throws(() => state.verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: guard.context }));
  assert.throws(() => state.assertDarwinLegacyPreflightToken(preflight, guard.context));
});

test("Darwin legacy barrier cannot be published with only a guard", mac, t => {
  const f = fixture(t), guard = acquireDarwinMigrationGuard(f.stateDir);
  try {
    assert.equal(typeof state.prepareDarwinLegacyBarrier, "function");
    assert.throws(() => state.prepareDarwinLegacyBarrier({ stateDir: f.stateDir, guardContext: guard.context,
      expectedStateDir: f.stateDir, offlineConfirmed: true, localOnly: true }));
    assert.equal(fs.existsSync(path.join(f.stateDir, "state.lock")), false, "guard alone published a v4 barrier");
  } finally { guard.close(); }
});

test("Darwin legacy barrier also requires fixed offline authorization", mac, t => {
  const f = fixture(t), index = path.join(f.stateDir, "state.json"), jobs = path.join(f.stateDir, "jobs");
  fs.mkdirSync(jobs, { mode: 0o700 });
  fs.writeFileSync(index, JSON.stringify({ version: 1, config: {}, jobs: [], reviewGateSessions: [] }), { flag: "wx", mode: 0o600 });
  const old = path.join(f.stateDir, "state.lock"); fs.writeFileSync(old, "12345\n", { flag: "wx", mode: 0o600 });
  const guard = acquireDarwinMigrationGuard(f.stateDir);
  try {
    const token = state.verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: guard.context });
    const oldEvidence = state.assertDarwinLegacyPreflightToken(token, guard.context);
    const marker = { version: 2, stateDir: f.stateDir, state: guard.context.directoryIdentity, hostId: guard.context.hostId,
      guardIdentity: guard.context.guardIdentity, migrationDirectoryIdentity: guard.context.migrationDirectoryIdentity, old: oldEvidence };
    const transition = path.join(guard.context.migrationDir, "transition.json"), backup = path.join(guard.context.migrationDir, "legacy-state.lock");
    const fd = fs.openSync(transition, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(marker)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(old, backup);
    const dirFd = fs.openSync(guard.context.migrationDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    const rootFd = fs.openSync(f.stateDir, "r"); try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
    assert.equal(typeof state.prepareDarwinLegacyBarrier, "function");
    const options = { stateDir: f.stateDir, guardContext: guard.context, expectedStateDir: f.stateDir,
      offlineConfirmed: true, localOnly: true };
    assert.throws(() => state.prepareDarwinLegacyBarrier({ ...options, preflightToken: Object.freeze({}) }));
    assert.equal(fs.existsSync(old), false);
    assert.throws(() => state.prepareDarwinLegacyBarrier({ ...options, preflightToken: token }), /offline authorization/i);
    assert.equal(fs.readFileSync(backup, "utf8"), "12345\n");
    assert.equal(fs.existsSync(old), false, "raw offline flags must not publish a barrier");
    const status = spawnSync(process.execPath, [cli, "status", "--cwd", f.workspace, "--json"], { env: f.env, encoding: "utf8", timeout: 15000 });
    assert.notEqual(status.status, 0, "normal runtime entered before completion evidence");
  } finally { guard.close(); }
});
