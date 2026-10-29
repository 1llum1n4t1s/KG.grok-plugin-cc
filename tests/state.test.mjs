import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { loadState, migrateStateLock, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { LINUX_LEASE_SLOT_COUNT } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";

function setStateDataForTest(t, dataDir) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(name => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  if (dataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = dataDir;
  delete process.env.PLUGIN_DATA;
}

// この fixture は state API の同期呼出しだけを行い、worker・broker・agent を起動しない。
function migrateStateFixture(t, workspace, dataDir, options) {
  if (process.platform !== "linux") return migrateStateLock(workspace, options);
  const identity = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Fixture directory is not verified: ${file}`);
    return { dev: stat.dev, ino: stat.ino };
  };
  const readJson = file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Fixture file is not verified: ${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const workspaceIdentity = identity(workspace), dataIdentity = identity(dataDir);
  let stateDir, stateIdentity, epoch, complete = false;
  t.after(() => {
    try {
      if (!complete || !stateDir || !epoch || !stateIdentity) throw new Error("state migration was not confirmed complete");
      assert.deepEqual(identity(workspace), workspaceIdentity);
      assert.deepEqual(identity(dataDir), dataIdentity);
      assert.deepEqual(identity(stateDir), stateIdentity);
      const lockDir = path.join(stateDir, "state.lock");
      const lockIdentity = identity(lockDir);
      const prepared = fs.readdirSync(lockDir).filter(name => name.startsWith("prepared-"));
      assert.equal(prepared.length, 1);
      assert.match(prepared[0], /^prepared-[0-9a-f-]{36}\.json$/i);
      const markerFile = path.join(lockDir, "protocol.json"), preparedFile = path.join(lockDir, prepared[0]);
      const markerStat = fs.lstatSync(markerFile, { bigint: true }), preparedStat = fs.lstatSync(preparedFile, { bigint: true });
      for (const stat of [markerStat, preparedStat]) {
        assert.ok(stat.isFile() && !stat.isSymbolicLink());
        assert.equal(stat.uid, BigInt(process.getuid()));
        assert.equal(stat.mode & 0o7777n, 0o600n);
        assert.equal(stat.nlink, 2n);
      }
      assert.equal(markerStat.dev, preparedStat.dev);
      assert.equal(markerStat.ino, preparedStat.ino);
      const markerBytes = fs.readFileSync(markerFile), preparedBytes = fs.readFileSync(preparedFile);
      assert.deepEqual(markerBytes, preparedBytes);
      for (const file of [markerFile, preparedFile]) {
        const current = fs.lstatSync(file, { bigint: true });
        assert.equal(current.dev, markerStat.dev);
        assert.equal(current.ino, markerStat.ino);
        assert.equal(current.nlink, 2n);
        assert.equal(current.mode, markerStat.mode);
      }
      assert.deepEqual(identity(lockDir), lockIdentity);
      const marker = JSON.parse(markerBytes.toString("utf8"));
      assert.equal(marker.epoch, epoch);
      const leaseDir = path.join(stateDir, "worker-leases-v1", epoch);
      identity(path.dirname(leaseDir));
      identity(leaseDir);
      assert.deepEqual(fs.readdirSync(path.dirname(leaseDir)).sort(), [epoch]);
      assert.deepEqual(fs.readdirSync(leaseDir).sort(), ["ledger.json"]);
      const ledger = readJson(path.join(leaseDir, "ledger.json"));
      assert.equal(ledger.protocol, "linux-lease-ledger-v1");
      assert.equal(ledger.epoch, epoch);
      assert.ok(Array.isArray(ledger.slots) && ledger.slots.length === LINUX_LEASE_SLOT_COUNT &&
        ledger.slots.every((slot, index) => slot.slot === index && slot.state === "free"));
      for (const namespace of ["broker-v3", "direct-start-v2"]) {
        const dir = path.join(stateDir, namespace);
        identity(dir);
        identity(path.join(dir, epoch));
        assert.deepEqual(fs.readdirSync(dir).sort(), [epoch]);
        assert.deepEqual(fs.readdirSync(path.join(dir, epoch)), []);
      }
      assert.equal(fs.existsSync(path.join(stateDir, "broker.json")), false);
      assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
      const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.stateDir, stateDir);
      assert.equal(stopped.epoch, epoch);
      assert.deepEqual(identity(dataDir), dataIdentity);
      assert.deepEqual(identity(workspace), workspaceIdentity);
      removeTempFixture(dataDir, { recursive: true, force: true });
      removeTempFixture(workspace, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Fixture cleanup failed or migration/process termination was not confirmed: ${dataDir}; ${workspace}`, { cause: error });
    }
  });
  stateDir = resolveStateDir(workspace);
  const migrated = migrateStateLock(workspace, { ...options, expectedStateDir: stateDir });
  assert.equal(migrated.stateDir, stateDir);
  assert.match(migrated.epoch, /^[0-9a-f-]{36}$/i);
  epoch = migrated.epoch;
  stateIdentity = identity(stateDir);
  complete = true;
  return migrated;
}

test("FG-2 Windows pruning commits its index before cleanup and tolerates cleanup failure", () => {
  const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function validJobLogReference("), source.indexOf("const DARWIN_JOB_EVIDENCE")) +
    source.slice(source.indexOf("function saveStateWithPreviousJobs("), source.indexOf("function resolveStateLockFile("));
  const logFile = path.resolve("jobs", "old.log");
  for (const failCommit of [true, false]) {
    const events = [];
    const context = {
      STATE_VERSION: 1,
      process: { platform: "win32", stderr: { write() {} } }, path,
      ensureStateDir() {}, pruneJobs: () => [], defaultState: () => ({ config: {} }),
      pruneReviewGateSessions: () => [], resolveStateFile: () => "state", resolveJobFile: () => "job",
      resolveJobsDir: () => "jobs", readJobFile: () => ({ id: "old", epoch: "epoch" }),
      writeJsonAtomic() { events.push("commit"); if (failCommit) throw new Error("disk full"); },
      removeJobFile() { events.push("cleanup-job"); throw new Error("locked artifact"); },
      removeFileIfExists() { events.push("cleanup-log"); }
    };
    const save = vm.runInNewContext(`${body}; saveStateWithPreviousJobs`, context);
    if (failCommit) {
      assert.throws(() => save("workspace", { jobs: [] }, [{ id: "old", logFile, epoch: "epoch" }], undefined, "epoch"), /disk full/);
      assert.deepEqual(events, ["commit"]);
    } else {
      assert.doesNotThrow(() => save("workspace", { jobs: [] }, [{ id: "old", logFile, epoch: "epoch" }], undefined, "epoch"));
      assert.deepEqual(events, ["commit", "cleanup-job", "cleanup-log"]);
    }
  }
});

test("resolveStateDir uses a temp-backed per-workspace directory", t => {
  setStateDataForTest(t);
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("corrupt state is reported and never silently replaced", t => {
  const dataDir = makeTempDir("grok-state-data-");
  setStateDataForTest(t, dataDir);
  const workspace = makeTempDir();
  migrateStateFixture(t, workspace, dataDir, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace) });
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{broken", "utf8");

  assert.throws(() => loadState(workspace), (error) => {
    assert.match(error.message, /state is corrupt/i);
    assert.ok(error.cause instanceof SyntaxError, "the deliberately malformed JSON must be the cause");
    return true;
  });
  assert.equal(fs.readFileSync(stateFile, "utf8"), "{broken");
});

test("state and job JSON writes leave no temporary files", t => {
  const dataDir = makeTempDir("grok-state-data-");
  setStateDataForTest(t, dataDir);
  const workspace = makeTempDir();
  migrateStateFixture(t, workspace, dataDir, { offlineConfirmed: true, localOnly: true });
  saveState(workspace, { version: 1, config: {}, jobs: [] });
  updateState(workspace, (_state, context) => {
    writeJobFile(workspace, "job-atomic", { id: "job-atomic", status: "queued" }, context);
  });

  const stateDir = resolveStateDir(workspace);
  const files = fs.readdirSync(stateDir, { recursive: true }).map(String);
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(resolveJobFile(workspace, "job-atomic"), "utf8")), {
    id: "job-atomic",
    status: "queued"
  });
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState preserves platform-specific history and matching artifacts", t => {
  const dataDir = makeTempDir("grok-state-data-");
  setStateDataForTest(t, dataDir);
  const workspace = makeTempDir();
  const { epoch } = migrateStateFixture(t, workspace, dataDir, { offlineConfirmed: true, localOnly: true });
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  let jobs;
  updateState(workspace, (_state, context) => {
    jobs = Array.from({ length: 51 }, (_, index) => {
      const jobId = `job-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      const job = {
        id: jobId,
        status: "completed",
        logFile,
        updatedAt,
        createdAt: updatedAt,
        ...(epoch ? { epoch } : {}),
        terminationPending: false,
        grokPromptState: "terminal"
      };
      writeJobFile(workspace, jobId, job, context);
      return job;
    });
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const posix = process.platform === "linux" || process.platform === "darwin";
  const expectedJobs = posix ? jobs.map((job) => job.id) : Array.from({ length: 50 }, (_, index) => "job-" + (50 - index));
  const expectedArtifactIds = posix ? jobs.map((job) => job.id) : Array.from({ length: 50 }, (_, index) => "job-" + (index + 1));
  assert.equal(savedState.jobs.length, expectedJobs.length);
  assert.deepEqual(savedState.jobs.map((job) => job.id), expectedJobs);
  assert.equal(fs.existsSync(prunedJobFile), posix);
  assert.equal(fs.existsSync(prunedLogFile), posix);
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    expectedArtifactIds.flatMap((jobId) => [jobId + ".json", jobId + ".log"]).sort()
  );
});
