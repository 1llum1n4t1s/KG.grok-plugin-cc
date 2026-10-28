import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import * as state from "../plugins/grok/scripts/lib/state.mjs";
import { migratePosixStateLock } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

// 実 Mac の CLI・native mutex を使用する。旧 runtime の停止と再起動防止は
// 外部前提であり、このテストは旧 process を勝手に終了させない。
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;

function setup(t) {
  const root = fs.realpathSync(makeTempDir("grok-darwin-v4-state-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(() => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    t.diagnostic(`Darwin v4 state fixture retained: ${root}`);
  });
  const stateDir = state.resolveStateDir(workspace);
  const env = { ...process.env };
  const run = args => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 15000 });
  const migration = run(["state-lock", "migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace]);
  assert.equal(migration.status, 0, migration.stderr);
  return { root, stateDir, workspace, env, run, marker: path.join(stateDir, "state.lock", "protocol.json") };
}

test("Darwin CLI publishes v4 and the real mutex grants only a live capability", darwin, t => {
  const f = setup(t);
  assert.equal(JSON.parse(fs.readFileSync(f.marker, "utf8")).protocol, "posix-local-v4");
  assert.equal(typeof state.assertDarwinPruneContext, "function");
  let expired;
  state.withStateSnapshot(f.workspace, (_snapshot, context) => {
    expired = context;
    assert.equal(context.protocol, "posix-local-v4");
    state.assertDarwinPruneContext(context);
    assert.throws(() => state.assertDarwinPruneContext({ ...context, check() {} }));
    assert.throws(() => state.assertDarwinPruneContext({ ...context, protocol: "posix-local-v3" }));
    const script = `import { withStateSnapshot } from ${JSON.stringify(stateModule)}; withStateSnapshot(${JSON.stringify(f.workspace)}, () => {}, { timeoutMs: 100 });`;
    const competing = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 10000 });
    assert.notEqual(competing.status, 0, "another process entered the same state mutex");
    assert.match(competing.stderr, /lock|timed?\s*out/i);
  });
  assert.throws(() => state.assertDarwinPruneContext(expired));
  assert.equal(f.run(["status", "--cwd", f.workspace, "--json"]).status, 0);
});

test("Darwin CLI preserves and rejects the unpublished v3 marker", darwin, t => {
  const f = setup(t), marker = JSON.parse(fs.readFileSync(f.marker, "utf8"));
  marker.protocol = "posix-local-v3";
  fs.writeFileSync(f.marker, JSON.stringify(marker), { mode: 0o600 });
  const before = fs.readFileSync(f.marker, "utf8");
  const result = f.run(["status", "--cwd", f.workspace, "--json"]);
  assert.notEqual(result.status, 0, "normal runtime accepted an old v3 state");
  assert.equal(fs.readFileSync(f.marker, "utf8"), before);
});

test("Darwin CLI preserves and rejects an unverified migration transition", darwin, t => {
  const f = setup(t), dir = path.join(f.stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(dir, { mode: 0o700 });
  const transition = path.join(dir, "transition.json");
  fs.writeFileSync(transition, "unverified transition\n", { flag: "wx", mode: 0o600 });
  const before = fs.readFileSync(f.marker, "utf8");
  const result = f.run(["status", "--cwd", f.workspace, "--json"]);
  assert.notEqual(result.status, 0, "normal runtime entered while migration evidence was unverified");
  assert.equal(fs.readFileSync(f.marker, "utf8"), before);
  assert.equal(fs.readFileSync(transition, "utf8"), "unverified transition\n");
});

// state API 境界を直接確認する。実 CLI の起動・停止操作は同じ state mutex を
// 使用し、この境界だけでは CLI の外部入力からの到達性を主張しない。
test("Darwin job writes require the real state mutex and a bounded job identifier", darwin, t => {
  const f = setup(t), detail = path.join(f.stateDir, "jobs", "safe-job.json");
  const escaped = path.join(f.stateDir, "outside.json");
  assert.throws(() => state.resolveJobFile(f.workspace, "../outside"));
  assert.throws(() => state.writeJobFile(f.workspace, "../outside", { id: "../outside" }));
  assert.equal(fs.existsSync(escaped), false);
  assert.throws(() => state.writeJobFile(f.workspace, "safe-job", { id: "safe-job" }));
  assert.equal(fs.existsSync(detail), false);
  state.withStateSnapshot(f.workspace, (_snapshot, context) => {
    state.assertDarwinPruneContext(context);
    assert.throws(() => state.writeJobFile(f.workspace, "../outside", { id: "../outside" }));
    state.writeJobFile(f.workspace, "safe-job", { id: "safe-job" });
    const script = `import { writeJobFile } from ${JSON.stringify(stateModule)}; writeJobFile(${JSON.stringify(f.workspace)}, "other-job", { id: "other-job" });`;
    const other = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 10000 });
    assert.notEqual(other.status, 0, "another process wrote a job without holding the mutex");
    assert.equal(fs.existsSync(path.join(f.stateDir, "jobs", "other-job.json")), false);
  });
  assert.equal(JSON.parse(fs.readFileSync(detail, "utf8")).id, "safe-job");
  assert.throws(() => state.writeJobFile(f.workspace, "safe-job", { id: "safe-job" }));
});

test("Darwin aroundCommit reports a committed update when a callback returns a promise afterwards", darwin, t => {
  const f = setup(t), afterSave = path.join(f.root, "after-save");
  let caught;
  try {
    state.updateState(f.workspace, current => { current.config.stopReviewGate = true; }, {
      afterSave: () => fs.writeFileSync(afterSave, "committed", { flag: "wx", mode: 0o600 }),
      aroundCommit: (_current, _context, commit) => { commit(); return Promise.resolve(); }
    });
  } catch (error) { caught = error; }
  assert.ok(caught, "an asynchronous aroundCommit return must be rejected");
  assert.equal(caught.stateCommitted, true, "the error must expose the committed state");
  assert.match(caught.message, /committed/i);
  assert.equal(state.loadState(f.workspace).config.stopReviewGate, true);
  assert.equal(fs.readFileSync(afterSave, "utf8"), "committed");
});

for (const explicitFlags of [false, true]) test(`Darwin low-level migration rejects an untrusted preparation callback (flags ${explicitFlags})`, darwin, t => {
  const root = fs.realpathSync(makeTempDir("grok-darwin-untrusted-migration-"));
  const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  let invoked = false;
  t.after(() => t.diagnostic(`Darwin untrusted migration fixture retained: ${root}`));
  assert.throws(() => migratePosixStateLock(stateDir, { expectedStateDir: stateDir,
    ...(explicitFlags ? { offlineConfirmed: true, localOnly: true } : {}),
    prepareDarwinGeneration: () => { invoked = true; }
  }));
  assert.equal(invoked, false, "untrusted generation callback ran");
  assert.equal(fs.existsSync(path.join(stateDir, "state.lock")), false, "untrusted caller created a v4 barrier");
});

// 防御的な再照合の検査。稼働中の非協調 namespace 変更は DESIGN の保証外で、
// この fixture は同一 UID の敵対者に対する sandbox を主張しない。
test("Darwin mutex rejects replacement of its barrier with the same epoch", darwin, t => {
  const f = setup(t), barrier = path.join(f.stateDir, "state.lock"), original = path.join(f.stateDir, "preserved-original-lock");
  const marker = JSON.parse(fs.readFileSync(f.marker, "utf8"));
  const identity = name => { const stat = fs.lstatSync(name, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; };
  state.withStateSnapshot(f.workspace, (_snapshot, context) => {
    state.assertDarwinPruneContext(context);
    fs.renameSync(barrier, original);
    fs.mkdirSync(barrier, { mode: 0o700 });
    const lock = path.join(barrier, "native.lock"), replacement = path.join(barrier, "protocol.json");
    fs.writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(replacement, "{}", { flag: "wx", mode: 0o600 });
    marker.barrierIdentity = identity(barrier); marker.lockIdentity = identity(lock); marker.markerIdentity = identity(replacement);
    fs.writeFileSync(replacement, JSON.stringify(marker), { mode: 0o600 });
    assert.throws(() => context.check(), /changed|replaced|identity/i);
  });
  assert.ok(fs.existsSync(path.join(original, "native.lock")), "the original locked inode was not preserved");
});
