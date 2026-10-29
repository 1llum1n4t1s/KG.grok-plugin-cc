import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { getReviewGateSession, listJobs, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, saveState, updateState, withStateSnapshot, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "../plugins/grok/scripts/lib/linux-lease-ledger.mjs";
import { hasGenerationIdentity, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { copyTestDirectory, initGitRepo, makeTempDir, run } from "./helpers.mjs";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

const linuxFixtures = new Map();
function registerLinuxFixture(workspace, data, stateDir, sentinelScript, stop, api = { withStateSnapshot, resolveJobFile, readJobFile, withAvailableLinuxLease, verifyPublishedLinuxLeaseRecords }) {
  if (process.platform !== "linux") return null;
  assert.ok(path.isAbsolute(stateDir) && path.isAbsolute(workspace) && path.isAbsolute(data) && path.isAbsolute(sentinelScript));
  const existing = linuxFixtures.get(stateDir);
  if (existing) {
    assert.equal(existing.workspace, workspace);
    assert.equal(existing.data, data);
    assert.equal(existing.sentinelScript, sentinelScript);
    return existing;
  }
  const entry = { workspace, data, stateDir, sentinelScript, stop, api, epoch: null, sentinel: null,
    groups: [], workers: [], syntheticJobs: new Set(), incomplete: false };
  linuxFixtures.set(stateDir, entry);
  return entry;
}
function completeLinuxMigration(entry, migration) {
  if (!entry) return;
  assert.ok(migration?.epoch);
  const markerFile = path.join(entry.stateDir, "state.lock", "protocol.json"), stat = fs.lstatSync(markerFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  assert.equal(marker.epoch, migration.epoch);
  assert.ok(marker.sentinel && Number.isSafeInteger(marker.sentinel.pid) && marker.sentinel.pid > 0 && marker.sentinel.startTick);
  if (entry.epoch) assert.equal(entry.epoch, marker.epoch);
  entry.epoch = marker.epoch;
  entry.sentinel = { pid: marker.sentinel.pid, startTick: marker.sentinel.startTick };
}
function recordOwnedGroup(entry, result) {
  if (!entry) return;
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0 || result.status === null || result.signal || result.error) entry.incomplete = true;
  else entry.groups.push(result.pid);
}
function runFixtureCommand(entry, executable, args, options) {
  if (process.platform !== "linux" || !entry) return run(executable, args, options);
  const result = spawnSync(executable, args, { cwd: options.cwd, env: options.env, input: options.input,
    encoding: "utf8", shell: false, windowsHide: true, detached: true });
  recordOwnedGroup(entry, result);
  return result;
}
function verifyGroupExited(group) {
  try { process.kill(-group, 0); }
  catch (error) { if (error.code === "ESRCH") return; throw error; }
  throw new Error(`Owned fixture process group remains present: ${group}`);
}
function verifyEmptyAdmission(entry) {
  const legacy = new Set(["broker.json", "broker.lock", "broker-v2", "direct-start-v1"]);
  for (const name of fs.readdirSync(entry.stateDir)) {
    if (legacy.has(name) || /^broker\.json\..*\.tmp$/.test(name)) throw new Error(`Fixture has unconfirmed legacy admission: ${name}`);
  }
  for (const namespace of ["broker-v3", "direct-start-v2"]) {
    const root = path.join(entry.stateDir, namespace);
    let stat;
    try { stat = fs.lstatSync(root); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid fixture admission namespace: ${root}`);
    for (const name of fs.readdirSync(root)) {
      if (name !== entry.epoch) throw new Error(`Fixture has unconfirmed old admission epoch: ${root}`);
      const directory = path.join(root, name), current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(`Invalid fixture admission directory: ${directory}`);
      if (fs.readdirSync(directory).length) throw new Error(`Fixture admission contains unconfirmed owner evidence: ${directory}`);
    }
  }
}
function verifyFixtureLeases(entry) {
  const { withStateSnapshot, resolveJobFile, readJobFile, withAvailableLinuxLease, verifyPublishedLinuxLeaseRecords } = entry.api;
  return withHostFixtureEnvironment({ CLAUDE_PLUGIN_DATA: entry.data, PLUGIN_DATA: entry.data }, () =>
    withStateSnapshot(entry.workspace, (state, context) => {
      assert.equal(context.epoch, entry.epoch);
      for (const indexed of state.jobs) {
        const file = resolveJobFile(entry.workspace, indexed.id), stored = fs.existsSync(file) ? readJobFile(file) : null;
        if (!indexed.workerLease && !stored?.workerLease) {
          if (!entry.syntheticJobs.has(indexed.id) && (indexed.pid != null || indexed.processStartKey || indexed.grokTransport)) {
            throw new Error(`Fixture job ${indexed.id} has unverified process ownership`);
          }
          continue;
        }
        if (!stored || indexed.epoch !== context.epoch || stored.epoch !== context.epoch || !indexed.workerLease || !stored.workerLease) {
          throw new Error(`Fixture job ${indexed.id} has incomplete lease evidence`);
        }
        verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
        if (withAvailableLinuxLease(indexed.workerLease, context, () => true).status !== "available") {
          throw new Error(`Fixture job ${indexed.id} worker lease was not released`);
        }
        if (indexed.grokTransport === "direct" || indexed.grokDirectGeneration) {
          if (typeof indexed.grokDirectGeneration !== "string" || !indexed.grokDirectGeneration ||
              indexed.grokDirectGeneration !== stored.grokDirectGeneration ||
              !Number.isInteger(indexed.grokDirectOwnerPid) || indexed.grokDirectOwnerPid <= 0 ||
              typeof indexed.grokDirectOwnerStartKey !== "string" || !indexed.grokDirectOwnerStartKey ||
              typeof indexed.grokDirectStopConfirmedAt !== "string" || !indexed.grokDirectStopConfirmedAt ||
              indexed.grokDirectStopKind !== stored.grokDirectStopKind ||
              ![indexed, stored].every(job => job.grokDirectStopGeneration === indexed.grokDirectGeneration &&
                ["never-started", "posix-group-empty"].includes(job.grokDirectStopKind) &&
                job.grokDirectOwnerPid === indexed.grokDirectOwnerPid && job.grokDirectOwnerStartKey === indexed.grokDirectOwnerStartKey &&
                job.grokDirectOwnerStartKey === job.processStartKey && job.grokDirectStopConfirmedAt === indexed.grokDirectStopConfirmedAt)) {
            throw new Error(`Fixture job ${indexed.id} direct agent stop is unconfirmed`);
          }
        }
      }
    }));
}
test.after(() => {
  const failures = [];
  for (const entry of linuxFixtures.values()) {
    try {
      if (!entry.epoch || !entry.sentinel || entry.incomplete) throw new Error("migration or child termination was not confirmed");
      for (const child of entry.workers) {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode !== 0 || child.signalCode) throw new Error("owned worker exit was not confirmed");
        verifyGroupExited(child.pid);
      }
      for (const group of entry.groups) verifyGroupExited(group);
      verifyEmptyAdmission(entry);
      verifyFixtureLeases(entry);
      const marker = JSON.parse(fs.readFileSync(path.join(entry.stateDir, "state.lock", "protocol.json"), "utf8"));
      if (marker.epoch !== entry.epoch || marker.sentinel?.pid !== entry.sentinel.pid || marker.sentinel?.startTick !== entry.sentinel.startTick) {
        throw new Error("fixture sentinel identity changed");
      }
      const command = fs.readFileSync(`/proc/${entry.sentinel.pid}/cmdline`, "utf8").split("\0");
      if (command[1] !== entry.sentinelScript || command[2] !== "sentinel") throw new Error("fixture sentinel installation differs");
      const result = entry.stop(entry.stateDir, { offlineConfirmed: true, expectedStateDir: entry.stateDir });
      assert.equal(result.stopped, true); assert.equal(result.epoch, entry.epoch);
    } catch (error) {
      failures.push(new Error(`Fixture retained: ${entry.stateDir}: ${error.message}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, `Hook fixture sentinel cleanup was not confirmed: ${failures.map(error => error.message).join("; ")}`);
});


test("FG-1 SessionEnd continues stopping jobs when a retained job log is unwritable", async () => {
  const source = fs.readFileSync(SESSION_HOOK, "utf8");
  const body = source.slice(source.indexOf("async function cleanupOwnedSessionJobs("), source.indexOf("function handleSessionStart("));
  for (const failure of ["unavailable", "stop-failed"]) {
    const jobs = [1, 2].map((pid) => ({ id: String(pid), pid, processStartKey: `start-${pid}`,
      status: "running", sessionId: "session", logFile: "unwritable", grokPromptState: "not-sent" }));
    const files = new Map(jobs.map(job => [job.id, { ...job }]));
    const stopped = [];
    let failedLogWrites = 0;
    const state = { jobs, reviewGateSessions: [] };
    const cleanup = vm.runInNewContext(`${body}; cleanupSessionJobs`, {
      hasGenerationIdentity, sameTurnEvidence,
      fs: { existsSync: () => true }, resolveWorkspaceRoot: (cwd) => cwd, resolveStateFile: () => "state",
      performance, process: { platform: "win32", stderr: { write() {} } },
      nowIso: () => "2026-10-27T00:00:00.000Z", resolveJobFile: (_cwd, id) => id,
      readJobFile: file => files.get(file), writeJobFile: (_cwd, id, job) => files.set(id, { ...job }),
      createProcessLookupDiagnostics: () => ({}),
      inspectTrackedJobProcess: (pid) => pid === 1 && failure === "unavailable" ? "unavailable" : "match",
      stopTrackedJobProcess(pid) { if (pid === 1) throw new Error("stop failed"); stopped.push(pid); },
      isActiveJob: job => ["queued", "running"].includes(job.status),
      appendLogLine() { failedLogWrites++; throw new Error("log denied"); },
      withStateSnapshot: (_cwd, inspect) => inspect(state),
      updateState: (_cwd, mutate) => mutate(state)
    });
    await assert.doesNotReject(() => cleanup("workspace", "session"));
    assert.deepEqual(stopped, [2]);
    if (failure === "stop-failed") assert.equal(failedLogWrites, 1, "the unwritable log path must be exercised");
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "1");
  }
});

function withPluginData(pluginData, callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return callback();
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function prepareFixtureMigration(workspace) {
  if (["win32", "linux", "darwin"].includes(process.platform)) {
    const stateDir = resolveStateDir(workspace);
    const entry = process.platform === "linux" ? registerLinuxFixture(workspace,
      process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA, stateDir,
      path.join(PLUGIN_ROOT, "scripts/lib/linux-state-sentinel.mjs"), shutdownPosixStateLockSentinel) : null;
    const migration = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    completeLinuxMigration(entry, migration);
  }
}

function saveFixtureState(workspace, state) {
  prepareFixtureMigration(workspace);
  const entry = process.platform === "linux" ? linuxFixtures.get(resolveStateDir(workspace)) : null;
  for (const job of state.jobs ?? []) entry?.syntheticJobs.add(job.id);
  return saveState(workspace, state);
}

function withHostFixtureEnvironment(env, callback) {
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) {
      if (env[key] == null) delete process.env[key];
      else process.env[key] = env[key];
    }
    return callback();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] == null) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

function runHook(script, args, input, env = {}) {
  const childEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env };
  const data = childEnv.CLAUDE_PLUGIN_DATA || childEnv.PLUGIN_DATA;
  const entry = process.platform === "linux" ? [...linuxFixtures.values()].find(item => item.workspace === input.cwd && item.data === data) : null;
  return runFixtureCommand(entry, process.execPath, [script, ...args], { env: childEnv, input: JSON.stringify(input) });
}

function makeReviewWorkspace() {
  const workspace = makeTempDir("grok-stop-hook-git-workspace-");
  initGitRepo(workspace);
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('v1');\n", "utf8");
  run("git", ["add", "app.js"], { cwd: workspace });
  run("git", ["commit", "-m", "init"], { cwd: workspace });
  return workspace;
}

function assertUnsupportedGate(result, workspace, pluginData) {
  if (process.platform === "win32") return false;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /incomplete/i);
  assert.equal(JSON.parse(result.stdout).decision, "block");
  assert.deepEqual(withPluginData(pluginData, () => listJobs(workspace)), []);
  return true;
}

test("SessionStart exports shared session and plugin-data variables for Claude Code", () => {
  const temp = makeTempDir("grok-session-start-hook-");
  const envFile = path.join(temp, "hook-env.sh");
  const pluginData = path.join(temp, "plugin-data");
  const result = runHook(
    SESSION_HOOK,
    ["SessionStart"],
    { session_id: "session-a", cwd: temp, hook_event_name: "SessionStart" },
    { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export GROK_COMPANION_SESSION_ID='session-a'/);
  assert.ok(exported.includes(`export CLAUDE_PLUGIN_DATA='${pluginData}'`));
});

test("Stop reports a running job from the current session without running the disabled review gate", () => {
  const workspace = makeTempDir("grok-stop-hook-workspace-");
  const pluginData = makeTempDir("grok-stop-hook-data-");
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        { id: "mine", status: "running", sessionId: "session-a", updatedAt: "2026-01-01T00:00:01.000Z" },
        { id: "theirs", status: "running", sessionId: "session-b", updatedAt: "2026-01-01T00:00:02.000Z" }
      ]
    });
  });

  const result = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Done"
    },
    { CLAUDE_PLUGIN_DATA: pluginData }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Grok task mine is still running/);
  assert.doesNotMatch(result.stderr, /theirs/);
});

test("Stop runs the enabled review gate with the normalized fallback session environment", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-enabled-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: no blockers" }] });
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, {
      version: 1,
      config: { stopReviewGate: true },
      jobs: []
    });
  });

  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData, GROK_COMPANION_SESSION_ID: "environment-session" };
  runHook(STOP_HOOK, [], { session_id: "   ", cwd: workspace, hook_event_name: "UserPromptSubmit" }, env);
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('updated');\n", "utf8");

  const result = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "   ",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Done"
    },
    {
      ...fake.env,
      CLAUDE_PLUGIN_DATA: pluginData,
      GROK_COMPANION_SESSION_ID: "environment-session"
    }
  );

  if (assertUnsupportedGate(result, workspace, pluginData)) return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /could not snapshot the working tree/i);
  const jobs = withPluginData(pluginData, () => listJobs(workspace));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sessionId, "environment-session");
});

for (const stopReason of ["cancelled", "unknown_reason"]) {
  test(`Stop does not accept ALLOW from an unfinished ${stopReason} review`, () => {
    const workspace = makeReviewWorkspace();
    const pluginData = makeTempDir("grok-stop-hook-unfinished-data-");
    const fake = installFakeGrok({ replies: [{ text: "ALLOW: partial review", stopReason }] });
    withPluginData(pluginData, () => saveFixtureState(workspace, {
      version: 1, config: { stopReviewGate: true }, jobs: []
    }));
    runHook(STOP_HOOK, [], { session_id: "unfinished-session", cwd: workspace, hook_event_name: "UserPromptSubmit" }, { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData });
    fs.writeFileSync(path.join(workspace, "app.js"), "console.log('updated');\n", "utf8");
    const result = runHook(STOP_HOOK, [], {
      session_id: "unfinished-session", cwd: workspace, hook_event_name: "Stop",
      stop_hook_active: false, last_assistant_message: "Done"
    }, { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData });
    if (assertUnsupportedGate(result, workspace, pluginData)) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /incomplete|failed/i);
    const [job] = withPluginData(pluginData, () => listJobs(workspace));
    assert.equal(job.status, "failed");
    const stored = withPluginData(pluginData, () => readJobFile(resolveJobFile(workspace, job.id)));
    assert.match(stored.rendered, /Review incomplete/i);
    assert.match(stored.rendered, new RegExp(stopReason));
  });
}

test("Stop preserves an ACP failure alongside a partial review", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-error-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: partial review", rpcError: "Review connection failed" }] });
  withPluginData(pluginData, () => saveFixtureState(workspace, {
    version: 1, config: { stopReviewGate: true }, jobs: []
  }));
  runHook(STOP_HOOK, [], { session_id: "error-session", cwd: workspace, hook_event_name: "UserPromptSubmit" }, { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData });
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('updated');\n", "utf8");
  const result = runHook(STOP_HOOK, [], {
    session_id: "error-session", cwd: workspace, hook_event_name: "Stop",
    stop_hook_active: false, last_assistant_message: "Done"
  }, { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData });
  if (assertUnsupportedGate(result, workspace, pluginData)) return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Review connection failed/);
  const [job] = withPluginData(pluginData, () => listJobs(workspace));
  assert.equal(job.status, "failed");
  const stored = withPluginData(pluginData, () => readJobFile(resolveJobFile(workspace, job.id)));
  assert.equal(stored.result.error, "Review connection failed");
  assert.match(stored.rendered, /Review connection failed/);
});

test("Stop skips Grok when UserPromptSubmit proves the turn made no repository changes", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-baseline-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: no blockers" }] });
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData };
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  });

  const baseline = runHook(
    STOP_HOOK,
    [],
    { session_id: "session-a", turn_id: "turn-a", cwd: workspace, hook_event_name: "UserPromptSubmit" },
    env
  );
  const stop = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      turn_id: "turn-a",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "No files changed"
    },
    env
  );

  if (assertUnsupportedGate(stop, workspace, pluginData)) return;

  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "");
  assert.equal(fake.readState(), null);
  assert.deepEqual(withPluginData(pluginData, () => listJobs(workspace)), []);
});

test("Stop reviews edits from a continuation even when another Stop hook caused it", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-foreign-continuation-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: continuation edit is safe" }] });
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData };
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  });

  runHook(
    STOP_HOOK,
    [],
    { session_id: "session-a", turn_id: "turn-b", cwd: workspace, hook_event_name: "UserPromptSubmit" },
    env
  );
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('v2');\n", "utf8");
  const stop = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      turn_id: "turn-b",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "Updated by another Stop continuation"
    },
    env
  );

  if (assertUnsupportedGate(stop, workspace, pluginData)) return;
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "");
  assert.equal(withPluginData(pluginData, () => listJobs(workspace)).length, 1);
});

test("Stop sends long assistant responses through stdin instead of the Windows command line", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-long-prompt-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: long response reviewed" }] });
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData };
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  });

  runHook(
    STOP_HOOK,
    [],
    { session_id: "session-a", turn_id: "turn-long", cwd: workspace, hook_event_name: "UserPromptSubmit" },
    env
  );
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('long');\n", "utf8");
  const stop = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      turn_id: "turn-long",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "x".repeat(64 * 1024)
    },
    env
  );

  if (assertUnsupportedGate(stop, workspace, pluginData)) return;
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "");
  assert.match(fake.readState().prompts[0], /Previous assistant response:\nx{1024}/);
  const [job] = withPluginData(pluginData, () => listJobs(workspace));
  assert.equal(job.kind, "stop-gate-review");
  assert.equal(job.jobClass, "review");
});

test("Stop reuses an unresolved Grok blocker until edits are made, then re-reviews it", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-pending-data-");
  const blockingFake = installFakeGrok({ replies: [{ text: "BLOCK: retry still drops messages" }] });
  const blockingEnv = { ...blockingFake.env, CLAUDE_PLUGIN_DATA: pluginData };
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
  });

  runHook(
    STOP_HOOK,
    [],
    { session_id: "session-a", turn_id: "turn-c", cwd: workspace, hook_event_name: "UserPromptSubmit" },
    blockingEnv
  );
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('broken');\n", "utf8");
  const blocked = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      turn_id: "turn-c",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Implemented retry changes"
    },
    blockingEnv
  );
  if (assertUnsupportedGate(blocked, workspace, pluginData)) return;
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.stdout, /retry still drops messages/);
  assert.equal(withPluginData(pluginData, () => listJobs(workspace)).length, 1);

  const unusedFake = installFakeGrok({ replies: [{ text: "ALLOW: should not run" }] });
  const unusedEnv = { ...unusedFake.env, CLAUDE_PLUGIN_DATA: pluginData };
  runHook(
    STOP_HOOK,
    [],
    { session_id: "session-a", turn_id: "turn-d", cwd: workspace, hook_event_name: "UserPromptSubmit" },
    unusedEnv
  );
  const unchanged = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      turn_id: "turn-d",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "Reported status only"
    },
    unusedEnv
  );
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /retry still drops messages/);
  assert.equal(unusedFake.readState(), null);
  assert.equal(withPluginData(pluginData, () => listJobs(workspace)).length, 1);

  const allowingFake = installFakeGrok({ replies: [{ text: "ALLOW: blocker resolved" }] });
  const allowingEnv = { ...allowingFake.env, CLAUDE_PLUGIN_DATA: pluginData };
  runHook(
    STOP_HOOK,
    [],
    { session_id: "session-a", turn_id: "turn-e", cwd: workspace, hook_event_name: "UserPromptSubmit" },
    allowingEnv
  );
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('fixed');\n", "utf8");
  const allowed = runHook(
    STOP_HOOK,
    [],
    {
      session_id: "session-a",
      turn_id: "turn-e",
      cwd: workspace,
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "Fixed the retry path"
    },
    allowingEnv
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");
  assert.equal(withPluginData(pluginData, () => listJobs(workspace)).length, 2);
  assert.match(allowingFake.readState().prompts[0], /Outstanding blocker/);
  assert.match(allowingFake.readState().prompts[0], /retry still drops messages/);
  assert.equal(withPluginData(pluginData, () => getReviewGateSession(workspace, "session-a")), null);
});

test("SessionEnd respects the normalized fallback session and preserves unverified jobs", () => {
  const workspace = makeTempDir("grok-session-end-hook-workspace-");
  const pluginData = makeTempDir("grok-session-end-hook-data-");
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      reviewGateSessions: [
        { sessionId: "environment-session", pendingReason: "mine", updatedAt: "2026-01-01T00:00:01.000Z" },
        { sessionId: "session-b", pendingReason: "theirs", updatedAt: "2026-01-01T00:00:02.000Z" }
      ],
      jobs: [
        // POSIX では lease のない終了済み record を保全する。
        {
          id: "mine",
          status: "completed",
          sessionId: "environment-session",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z"
        },
        {
          id: "unknown-generation",
          status: "completed",
          sessionId: "environment-session",
          updatedAt: "2026-01-01T00:00:01.000Z"
        },
        { id: "theirs", status: "running", sessionId: "session-b", updatedAt: "2026-01-01T00:00:02.000Z" }
      ]
    });
    if (process.platform === "linux") updateState(workspace, (state, context) => {
      for (const entry of state.reviewGateSessions) entry.epoch = context.epoch;
    });
  });

  const result = runHook(
    SESSION_HOOK,
    ["SessionEnd"],
    { session_id: "   ", cwd: workspace, hook_event_name: "SessionEnd", reason: "other" },
    {
      CLAUDE_PLUGIN_DATA: pluginData,
      GROK_COMPANION_SESSION_ID: "environment-session"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const remaining = withPluginData(pluginData, () => listJobs(workspace));
  assert.deepEqual(remaining.map((job) => job.id).sort(),
    ["linux", "darwin"].includes(process.platform) ? ["mine", "theirs", "unknown-generation"] : ["theirs", "unknown-generation"]);
  if (["linux", "darwin"].includes(process.platform)) {
    const unverified = remaining.find((job) => job.id === "mine");
    assert.equal(unverified.status, "completed");
    assert.equal(unverified.workerLease, undefined);
  }
  const unknownGeneration = remaining.find((job) => job.id === "unknown-generation");
  assert.equal(unknownGeneration.status, "completed");
  assert.equal(unknownGeneration.createdAt, undefined);
  assert.equal(withPluginData(pluginData, () => fs.existsSync(resolveJobFile(workspace, "unknown-generation"))), false);
  assert.equal(withPluginData(pluginData, () => getReviewGateSession(workspace, "environment-session")), null);
  assert.equal(
    withPluginData(pluginData, () => getReviewGateSession(workspace, "session-b"))?.pendingReason,
    "theirs"
  );
});

test("Stop reports a cancellation that still needs process termination", () => {
  const workspace = makeTempDir("grok-stop-hook-pending-workspace-");
  const pluginData = makeTempDir("grok-stop-hook-pending-data-");
  withPluginData(pluginData, () => saveFixtureState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: "pending", status: "cancelled", terminationPending: true, sessionId: "session-a" }]
  }));
  const result = runHook(STOP_HOOK, [], {
    session_id: "session-a", cwd: workspace, hook_event_name: "Stop", last_assistant_message: "Done"
  }, { CLAUDE_PLUGIN_DATA: pluginData });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Retry \/grok:cancel pending/);
});

test("SessionEnd cancels a leased queued job and retains unverified records", { timeout: 30000 }, async (t) => {
  const workspace = makeTempDir("grok-session-end-queued-workspace-");
  const pluginData = makeTempDir("grok-session-end-queued-data-");
  const posix = ["linux", "darwin"].includes(process.platform);
  const job = { id: "queued", status: "queued", sessionId: "ending-session", workspaceRoot: workspace };
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, { version: 1, config: {}, jobs: [] });
    updateState(workspace, (state, context) => {
      const unverified = { id: "unverified", status: "queued", sessionId: "ending-session", workspaceRoot: workspace,
        ...(process.platform === "linux" ? { epoch: context.epoch } : {}) };
      if (posix) {
        writeJobFile(workspace, unverified.id, unverified); state.jobs.push(unverified);
        if (process.platform === "linux") linuxFixtures.get(context.stateDir).syntheticJobs.add(unverified.id);
      }
      if (!posix) { writeJobFile(workspace, job.id, job); state.jobs.push(job); }
    });
  });
  let worker, exited;
  try {
    if (posix) {
      const moduleUrl = pathToFileURL(path.join(PLUGIN_ROOT, "scripts/lib/tracked-jobs.mjs")).href;
      const source = `import * as jobs from ${JSON.stringify(moduleUrl)};
        jobs[process.platform === 'linux' ? 'reserveLinuxTrackedJob' : 'reserveDarwinTrackedJob'](${JSON.stringify(job)});
        console.log('LEASE_READY'); process.stdin.once('data', () => process.exit(0));`;
      worker = spawn(process.execPath, ["--input-type=module", "-e", source], {
        cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, PLUGIN_DATA: pluginData },
        detached: process.platform === "linux", stdio: ["pipe", "pipe", "pipe"]
      });
      if (process.platform === "linux") withPluginData(pluginData, () => linuxFixtures.get(resolveStateDir(workspace)).workers.push(worker));
      let stdout = "", stderr = "";
      worker.stdin.on("error", () => {});
      worker.stdout.on("data", chunk => { stdout += chunk; });
      worker.stderr.on("data", chunk => { stderr += chunk; });
      exited = new Promise(resolve => {
        worker.once("error", error => resolve({ code: null, error }));
        worker.once("close", (code, signal) => resolve({ code, signal }));
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Lease worker did not become ready: ${stderr}`)), 10000);
        const check = () => { if (stdout.includes("LEASE_READY")) { clearTimeout(timer); resolve(); } };
        worker.stdout.on("data", check);
        exited.then(result => { clearTimeout(timer); reject(new Error(`Lease worker exited before readiness: ${JSON.stringify(result)} ${stderr}`)); });
        check();
      });
    }
    const result = runHook(SESSION_HOOK, ["SessionEnd"],
      { cwd: workspace, session_id: "ending-session", hook_event_name: "SessionEnd" }, { CLAUDE_PLUGIN_DATA: pluginData });
    assert.equal(result.status, 0, result.stderr);
    const remaining = withPluginData(pluginData, () => listJobs(workspace));
    assert.deepEqual(remaining.map(entry => entry.id).sort(), posix ? ["queued", "unverified"] : ["queued"]);
    const queued = remaining.find(entry => entry.id === "queued");
    assert.equal(queued.status, "cancelled");
    if (posix) { assert.equal(queued.terminationPending, true); assert.ok(queued.claimToken && queued.workerLease); }
    const stored = withPluginData(pluginData, () => readJobFile(resolveJobFile(workspace, "queued")));
    assert.equal(stored.status, "cancelled");
    if (posix) assert.equal(stored.claimToken, queued.claimToken);
    if (posix) {
      const unverified = remaining.find(entry => entry.id === "unverified");
      assert.equal(unverified.status, "queued");
      assert.equal(withPluginData(pluginData, () => readJobFile(resolveJobFile(workspace, "unverified"))).status, "queued");
    }
  } finally {
    if (worker) {
      worker.stdin.end("stop\n");
      let timer;
      const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
      clearTimeout(timer);
      if (!result || result.code !== 0) {
        if (!result) worker.kill("SIGKILL");
        t.diagnostic(`Fixture retained because lease worker termination is unconfirmed: ${workspace}`);
        throw new Error(`Lease worker did not exit cleanly: ${JSON.stringify(result)}`);
      }
    }
  }
});

test("SessionEnd retains a running job when process identity cannot be verified", () => {
  const workspace = makeTempDir("grok-session-end-unverifiable-workspace-");
  const pluginData = makeTempDir("grok-session-end-unverifiable-data-");
  withPluginData(pluginData, () => {
    saveFixtureState(workspace, {
      version: 1,
      config: {},
      jobs: [{ id: "unverifiable", status: "running", sessionId: "ending-session", pid: process.pid }]
    });
  });

  const result = runHook(
    SESSION_HOOK,
    ["SessionEnd"],
    { cwd: workspace, session_id: "ending-session", hook_event_name: "SessionEnd" },
    { CLAUDE_PLUGIN_DATA: pluginData }
  );

  assert.equal(result.status, 0, result.stderr);
  const remaining = withPluginData(pluginData, () => listJobs(workspace));
  assert.deepEqual(remaining.map((job) => job.id), ["unverifiable"]);
});

// 登録されたコマンドそのものをシェルで実行し、空白を含むプラグインパスも検証する。
for (const flavor of ['codex', 'claude']) {
  test(`standard hook commands work through the shell (${flavor})`, async (t) => {
    const temp = makeTempDir('grok hooks 日本語 space-');
    const root = path.join(temp, 'plugin with spaces');
    copyTestDirectory(PLUGIN_ROOT, root);
    const data = path.join(temp, 'data');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: '', PLUGIN_ROOT: '', CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '', CLAUDE_ENV_FILE: '' };
    env[flavor === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT'] = root;
    env[flavor === 'codex' ? 'PLUGIN_DATA' : 'CLAUDE_PLUGIN_DATA'] = data;
    const copiedState = await import(pathToFileURL(path.join(root, 'scripts/lib/state.mjs')).href);
    const copiedLock = process.platform === 'linux'
      ? await import(pathToFileURL(path.join(root, 'scripts/lib/posix-state-lock.mjs')).href) : null;
    const copiedLease = process.platform === 'linux' ? await import(pathToFileURL(path.join(root, 'scripts/lib/linux-worker-lease.mjs')).href) : null;
    const copiedLedger = process.platform === 'linux' ? await import(pathToFileURL(path.join(root, 'scripts/lib/linux-lease-ledger.mjs')).href) : null;
    let entry;
    withHostFixtureEnvironment(env, () => {
      const dir = copiedState.resolveStateDir(temp);
      if (process.platform === 'linux') entry = registerLinuxFixture(temp, data, dir,
        path.join(root, 'scripts/lib/linux-state-sentinel.mjs'), copiedLock.shutdownPosixStateLockSentinel,
        { withStateSnapshot: copiedState.withStateSnapshot, resolveJobFile: copiedState.resolveJobFile, readJobFile: copiedState.readJobFile,
          withAvailableLinuxLease: copiedLease.withAvailableLinuxLease, verifyPublishedLinuxLeaseRecords: copiedLedger.verifyPublishedLinuxLeaseRecords });
      if (["win32", "linux", "darwin"].includes(process.platform)) {
        const migration = copiedState.migrateStateLock(temp, { offlineConfirmed: true, localOnly: true, expectedStateDir: dir });
        completeLinuxMigration(entry, migration);
      }
    });
    for (const [event, groups] of Object.entries(manifest.hooks)) {
      const command = groups[0].hooks[0].command;
      const executable = process.platform === 'win32' ? 'pwsh' : '/bin/sh';
      const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
      const result = runFixtureCommand(entry, executable, args, { shell: false, env, cwd: temp,
        input: JSON.stringify({ cwd: temp, session_id: 'shell-test', hook_event_name: event }) });
      assert.equal(result.status, 0, `${event}: ${result.stderr}`);
      assert.equal(result.stderr, '', event);
    }
  });
}
