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

function assertFreshLedger(stateDir, epoch) {
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, "darwin-lease-ledger.json"), "utf8"));
  assert.equal(ledger.protocol, "darwin-lease-ledger-v1");
  assert.equal(ledger.epoch, epoch);
  assert.equal(ledger.cursor, 0);
  assert.deepEqual(ledger.slots, Array.from({ length: 256 }, (_, slot) => ({ slot, state: "free" })));
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "worker-leases")), []);
}

test("explicit offline migration initializes a unique v4 generation that the v1 writer rejects", darwin, async t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v4");
  assert.match(migrated.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const marker = JSON.parse(fs.readFileSync(path.join(lockDir, "protocol.json"), "utf8"));
  assert.equal(marker.protocol, migrated.protocol);
  assert.equal(marker.epoch, migrated.epoch);
  assertFreshLedger(stateDir, migrated.epoch);
  const otherWorkspace = fs.realpathSync(makeTempDir("grok-migrate-workspace-other-"));
  const otherDir = resolveStateDir(otherWorkspace);
  fs.mkdirSync(otherDir, { recursive: true, mode: 0o700 });
  const other = migrate(otherWorkspace, otherDir);
  assert.equal(other.protocol, "posix-local-v4");
  assert.notEqual(other.epoch, migrated.epoch);
  assertFreshLedger(otherDir, other.epoch);
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

test("the experimental v2 runtime refuses a v4 state generation", darwin, async t => {
  const { workspace, stateDir } = fixture(t);
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v4");
  assertFreshLedger(stateDir, migrated.epoch);
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

test("an experimental v2 marker is preserved and rejected by v4 migration and state writer", darwin, t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  migrateV2(stateDir, { expectedStateDir: stateDir });
  const marker = path.join(lockDir, "protocol.json");
  const original = fs.readFileSync(marker, "utf8"), before = fs.lstatSync(marker, { bigint: true });
  assert.equal(JSON.parse(original).protocol, "posix-local-v2");
  assert.throws(() => migrate(workspace, stateDir));
  assert.throws(() => withStateSnapshot(workspace, () => {}));
  assert.equal(fs.readFileSync(marker, "utf8"), original);
  const after = fs.lstatSync(marker, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
});

test("v2 and current runtimes each refuse and preserve an experimental v1 marker", darwin, async t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  migrateV1(stateDir, { expectedStateDir: stateDir });
  const marker = path.join(lockDir, "protocol.json"), original = fs.readFileSync(marker);
  const before = fs.lstatSync(marker, { bigint: true });
  assert.equal(JSON.parse(original).protocol, "posix-local-v1");
  assert.throws(() => migrateV2(stateDir, { expectedStateDir: stateDir }));
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
  assert.throws(() => migrate(workspace, stateDir));
  assert.throws(() => withStateSnapshot(workspace, () => {}));
  const after = fs.lstatSync(marker, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(fs.readFileSync(marker), original);
});

test("a confirmed offline migration preserves and refuses an old file lock", darwin, t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  const lockBytes = Buffer.from("123456\n"), stateFile = path.join(stateDir, "state.json");
  const stateBytes = Buffer.from('{"version":1,"jobs":[],"reviewGateSessions":[]}\n');
  fs.writeFileSync(lockDir, lockBytes, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(stateFile, stateBytes, { mode: 0o600, flag: "wx" });
  const lockBefore = fs.lstatSync(lockDir, { bigint: true }), stateBefore = fs.lstatSync(stateFile, { bigint: true });
  assert.throws(() => migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true,
    allOldProcessesStopped: true, expectedStateDir: stateDir }), /completion evidence is unavailable/i);
  for (const [file, bytes, before] of [[lockDir, lockBytes, lockBefore], [stateFile, stateBytes, stateBefore]]) {
    const after = fs.lstatSync(file, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  assert.equal(fs.existsSync(path.join(stateDir, ".darwin-legacy-migration")), false);
  assert.equal(fs.existsSync(path.join(stateDir, "darwin-lease-ledger.json")), false);
});

for (const kind of ["unknown root entry", "broker admission", "direct admission", "orphan detail", "missing detail", "old lease"]) {
  test(`offline v4 migration preserves and refuses ${kind}`, darwin, t => {
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

test("offline v4 migration preserves a consistent legacy terminal result and log", darwin, t => {
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
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v4");
  assertFreshLedger(stateDir, migrated.epoch);
  assert.equal(fs.readFileSync(stateFile, "utf8"), originalState);
  assert.equal(fs.readFileSync(detailFile, "utf8"), originalDetail);
  assert.equal(fs.readFileSync(logFile, "utf8"), originalLog);
  assert.equal(loadState(workspace).jobs[0].id, indexed.id);
  assert.equal(readJobFile(detailFile).rendered, detail.rendered);
});

test("the legacy file-lock stale cleanup cannot remove a v4 state-lock directory", darwin, async t => {
  const { workspace, stateDir, lockDir } = fixture(t);
  const migrated = migrate(workspace, stateDir);
  assert.equal(migrated.protocol, "posix-local-v4");
  assertFreshLedger(stateDir, migrated.epoch);
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
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
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
    assert.equal((await closed).signal, "SIGKILL");
    const entries = fs.readdirSync(lockDir).sort();
    const rootEntries = fs.readdirSync(stateDir).sort();
    const files = [...entries.map(name => path.join(lockDir, name)), ...rootEntries.map(name => path.join(stateDir, name))]
      .filter(file => fs.lstatSync(file).isFile())
      .map(file => ({ file, bytes: fs.readFileSync(file), stat: fs.lstatSync(file, { bigint: true }) }));
    const marker = path.join(lockDir, "protocol.json");
    if (step !== "marker-published") {
      assert.equal(fs.existsSync(marker), false);
      assert.throws(() => withStateSnapshot(workspace, () => {}));
      assert.throws(() => migrate(workspace, stateDir));
    } else {
      assert.equal(fs.existsSync(marker), true);
      const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.equal(parsed.protocol, "posix-local-v4");
      assert.ok(parsed.epoch);
      assertFreshLedger(stateDir, parsed.epoch);
      withStateSnapshot(workspace, (_state, context) => {
        assert.equal(context.protocol, "posix-local-v4");
        assert.equal(context.epoch, parsed.epoch);
      });
    }
    assert.deepEqual(fs.readdirSync(lockDir).sort(), entries);
    // 正常 snapshot は既定の jobs directory を初めて作成する。
    const expectedRootEntries = step === "marker-published" && !rootEntries.includes("jobs")
      ? [...rootEntries, "jobs"].sort() : rootEntries;
    assert.deepEqual(fs.readdirSync(stateDir).sort(), expectedRootEntries);
    if (step === "marker-published") assert.deepEqual(fs.readdirSync(path.join(stateDir, "jobs")), []);
    for (const { file, bytes, stat } of files) {
      const after = fs.lstatSync(file, { bigint: true });
      assert.equal(after.dev, stat.dev);
      assert.equal(after.ino, stat.ino);
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
  });
}
