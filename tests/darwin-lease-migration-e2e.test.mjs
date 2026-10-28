import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { loadState, migrateStateLock, readJobFile, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { migratePosixStateLock as migrateV1 } from "./fixtures/darwin-v1-posix-state-lock.mjs";
import { migratePosixStateLock as migrateV2 } from "./fixtures/darwin-v2-posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

const darwin = { skip: process.platform !== "darwin", timeout: 45000 };

function fixture(t) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(makeTempDir("grok-migrate-state-"));
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-migrate-workspace-"));
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return { workspace, stateDir, lockDir: path.join(stateDir, "state.lock") };
}

function migrate(workspace, stateDir) {
  return migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
}

test("explicit offline migration initializes a unique v3 generation that the v1 writer rejects", darwin, async t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v3");
  assert.match(migrated.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const marker = JSON.parse(fs.readFileSync(path.join(lockDir, "protocol.json"), "utf8"));
  assert.equal(marker.protocol, migrated.protocol);
  assert.equal(marker.epoch, migrated.epoch);
  const entered = path.join(workspace, "v1-writer-entered");
  const child = fork(new URL("./fixtures/darwin-v1-state-writer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ stateDir, entered });
  const [answer] = await once(child, "message");
  assert.equal(answer.accepted, false);
  assert.equal(fs.existsSync(entered), false);
  assert.equal(migrate(workspace, stateDir).epoch, migrated.epoch);
});

test("the experimental v2 runtime refuses a v3 state generation", darwin, async t => {
  const { workspace, stateDir } = fixture(t);
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v3");
  const entered = path.join(workspace, "v2-writer-entered");
  const child = fork(new URL("./fixtures/darwin-v2-state-writer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ stateDir, entered });
  const [answer] = await once(child, "message");
  assert.equal(answer.accepted, false);
  assert.equal(fs.existsSync(entered), false);
});

test("an experimental v2 marker is preserved and rejected by v3 migration and state writer", darwin, t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  migrateV2(stateDir, { expectedStateDir: stateDir });
  const marker = path.join(lockDir, "protocol.json");
  const original = fs.readFileSync(marker, "utf8");
  assert.equal(JSON.parse(original).protocol, "posix-local-v2");
  assert.throws(() => migrate(workspace, stateDir));
  assert.throws(() => withStateSnapshot(workspace, () => {}));
  assert.equal(fs.readFileSync(marker, "utf8"), original);
});

test("an experimental v1 marker is preserved and rejected by the v2 migration and state writer", darwin, t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  migrateV1(stateDir, { expectedStateDir: stateDir });
  const marker = path.join(lockDir, "protocol.json");
  const original = fs.readFileSync(marker, "utf8");
  assert.equal(JSON.parse(original).protocol, "posix-local-v1");
  assert.throws(() => migrate(workspace, stateDir));
  assert.throws(() => withStateSnapshot(workspace, () => {}));
  assert.equal(fs.readFileSync(marker, "utf8"), original);
});

test("an old file lock is preserved and prevents migration", darwin, t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  fs.writeFileSync(lockDir, "legacy owner\n", { mode: 0o600, flag: "wx" });
  assert.throws(() => migrate(workspace, stateDir));
  assert.equal(fs.readFileSync(lockDir, "utf8"), "legacy owner\n");
});

for (const kind of ["unknown root entry", "broker admission", "direct admission", "orphan detail", "missing detail", "old lease"]) {
  test(`offline v3 migration preserves and refuses ${kind}`, darwin, t => {
    const { workspace, stateDir } = fixture(t);
    const stateFile = path.join(stateDir, "state.json");
    const jobsDir = path.join(stateDir, "jobs");
    let protectedPath;
    if (kind === "unknown root entry") {
      protectedPath = path.join(stateDir, "unknown-data");
      fs.writeFileSync(protectedPath, "keep");
    } else if (kind === "broker admission" || kind === "direct admission") {
      const dir = path.join(stateDir, kind === "broker admission" ? "broker-v2" : "direct-start-v1");
      fs.mkdirSync(dir, { mode: 0o700 });
      protectedPath = path.join(dir, "admission.jsonl");
      fs.writeFileSync(protectedPath, "keep");
    } else {
      fs.mkdirSync(jobsDir, { mode: 0o700 });
      const job = { id: "old-job", status: "completed", createdAt: "2024-01-01T00:00:00.000Z",
        ...(kind === "old lease" ? { workerLease: { id: "old-unverified-lease" } } : {}) };
      fs.writeFileSync(stateFile, JSON.stringify({ jobs: kind === "orphan detail" ? [] : [job] }), { mode: 0o600 });
      protectedPath = kind === "missing detail" ? stateFile : path.join(jobsDir, "old-job.json");
      if (kind !== "missing detail") fs.writeFileSync(protectedPath, JSON.stringify(job), { mode: 0o600 });
    }
    const original = fs.readFileSync(protectedPath, "utf8");
    assert.throws(() => migrate(workspace, stateDir));
    assert.equal(fs.readFileSync(protectedPath, "utf8"), original);
    assert.equal(fs.existsSync(path.join(stateDir, "darwin-lease-ledger.json")), false);
  });
}

test("offline v3 migration preserves a consistent legacy terminal result and log", darwin, t => {
  const { workspace, stateDir } = fixture(t);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { mode: 0o700 });
  const indexed = { id: "legacy-terminal", status: "completed", createdAt: "2024-01-01T00:00:00.000Z", title: "Legacy" };
  const detail = { ...indexed, rendered: "preserved legacy result" };
  const stateFile = path.join(stateDir, "state.json");
  const detailFile = path.join(jobsDir, `${indexed.id}.json`);
  const logFile = path.join(jobsDir, `${indexed.id}.log`);
  const originalState = `${JSON.stringify({ jobs: [indexed] })}\n`;
  const originalDetail = `${JSON.stringify(detail)}\n`;
  const originalLog = "legacy log contents\n";
  fs.writeFileSync(stateFile, originalState, { mode: 0o600 });
  fs.writeFileSync(detailFile, originalDetail, { mode: 0o600 });
  fs.writeFileSync(logFile, originalLog, { mode: 0o600 });
  assert.equal(migrate(workspace, stateDir).protocol, "posix-local-v3");
  assert.equal(fs.readFileSync(stateFile, "utf8"), originalState);
  assert.equal(fs.readFileSync(detailFile, "utf8"), originalDetail);
  assert.equal(fs.readFileSync(logFile, "utf8"), originalLog);
  assert.equal(loadState(workspace).jobs[0].id, indexed.id);
  assert.equal(readJobFile(detailFile).rendered, detail.rendered);
});

test("the legacy file-lock stale cleanup cannot remove a v3 state-lock directory", darwin, async t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v3");
  const marker = path.join(lockDir, "protocol.json");
  const before = fs.readFileSync(marker, "utf8");
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(lockDir, old, old);
  const child = fork(new URL("./fixtures/darwin-legacy-file-lock-writer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ stateDir, expectedParent: path.dirname(stateDir) });
  const [result] = await once(child, "message");
  assert.equal(result.writeCode, "EEXIST");
  assert.ok(["EISDIR", "ERR_FS_EISDIR", "EPERM"].includes(result.cleanupCode), JSON.stringify(result));
  assert.equal(fs.lstatSync(lockDir).isDirectory(), true);
  assert.equal(fs.readFileSync(marker, "utf8"), before);
});

for (const step of ["barrier-created", "lock-file-synced", "marker-prepared", "marker-published"]) {
  test(`migration interruption at ${step} preserves a verifiable or explicitly incomplete state`, darwin, async t => {
    const { workspace, stateDir, lockDir } = fixture(t);
    const ready = path.join(workspace, "migration-paused");
    const child = fork(new URL("./fixtures/darwin-migration-interrupt.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    child.send({ workspace, stateDir, ready, step });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(ready), `migration did not pause at ${step}`);
    child.kill("SIGKILL");
    await closed;
    const entries = fs.readdirSync(lockDir).sort();
    const marker = path.join(lockDir, "protocol.json");
    if (!fs.existsSync(marker)) {
      assert.throws(() => withStateSnapshot(workspace, () => {}));
      assert.throws(() => migrate(workspace, stateDir));
      assert.deepEqual(fs.readdirSync(lockDir).sort(), entries);
    } else {
      const before = fs.readFileSync(marker, "utf8");
      const parsed = JSON.parse(before);
      assert.equal(parsed.protocol, "posix-local-v3");
      assert.ok(parsed.epoch);
      // 公開済み marker は改めて耐久化・検証できるか、明示的に拒否する。
      try { withStateSnapshot(workspace, () => {}); } catch { /* incomplete remains unavailable */ }
      assert.equal(fs.readFileSync(marker, "utf8"), before);
    }
  });
}
