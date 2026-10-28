import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { makeTempDir } from "./helpers.mjs";
import { loadState, migrateStateLock, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";

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
  setStateDataForTest(t, makeTempDir("grok-state-data-"));
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{broken", "utf8");

  assert.throws(() => loadState(workspace), /state is corrupt/i);
  assert.equal(fs.readFileSync(stateFile, "utf8"), "{broken");
});

test("state and job JSON writes leave no temporary files", t => {
  setStateDataForTest(t, makeTempDir("grok-state-data-"));
  const workspace = makeTempDir();
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true });
  saveState(workspace, { version: 1, config: {}, jobs: [] });
  writeJobFile(workspace, "job-atomic", { id: "job-atomic", status: "queued" });

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

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", t => {
  setStateDataForTest(t, makeTempDir("grok-state-data-"));
  const workspace = makeTempDir();
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true });
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
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
    writeJobFile(workspace, jobId, job);
    return job;
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
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});
