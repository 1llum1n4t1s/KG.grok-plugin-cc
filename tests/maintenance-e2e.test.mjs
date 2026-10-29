import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, removeTempFixture, run } from "./helpers.mjs";
import { migrateStateLock, resolveStateDir, resolveStateFile, resolveJobFile, resolveJobLogFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

function workspace(t, scenario = { replies: [{ text: "DONE" }] }, { stateful = false } = {}) {
  const root = makeTempDir("grok-maintenance-");
  const fake = installFakeGrok(scenario);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: path.join(root, "data") };
  const owners = [], trackingLog = path.join(root, "process-ownership.jsonl");
  if (process.platform === "linux") {
    const preload = path.join(root, "process-ownership.cjs");
    fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const log = record => fs.appendFileSync(process.env.MAINTENANCE_PROCESS_LOG, JSON.stringify(record) + "\n");
function identity(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}
log({ type: "ready", pid: process.pid, identity: identity(process.pid) });
const realSpawn = childProcess.spawn, realSpawnSync = childProcess.spawnSync;
childProcess.spawn = function(file, args, options) {
  const child = realSpawn.apply(this, arguments);
  const opts = Array.isArray(args) ? options : args;
  log({ type: "spawn", pid: child.pid ?? null, identity: child.pid ? identity(child.pid) : null, detached: opts?.detached === true });
  child.once("close", (code, signal) => log({ type: "close", pid: child.pid ?? null, code, signal }));
  return child;
};
childProcess.spawnSync = function(file) {
  const result = realSpawnSync.apply(this, arguments);
  if (file === process.env.MAINTENANCE_FAKE_BIN) {
    log({ type: "sync", pid: result.pid ?? null, status: result.status, signal: result.signal, error: Boolean(result.error) });
  }
  return result;
};
syncBuiltinESMExports();
`);
    env.MAINTENANCE_PROCESS_LOG = trackingLog;
    env.MAINTENANCE_FAKE_BIN = fake.env.GROK_BIN;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require="${preload}"`.trim();
  }
  const command = (args, options = {}) => {
    const result = run(process.execPath, [SCRIPT, ...args], { cwd: options.cwd ?? repo, env: options.env ?? env });
    if (process.platform === "linux") owners.push({ pid: result.pid, closed: result.status !== null || result.signal !== null, error: Boolean(result.error) });
    return result;
  };
  const trackOwner = (child) => {
    const record = { pid: child.pid, closed: false, error: false };
    owners.push(record);
    child.once("close", () => { record.closed = true; });
    child.once("error", () => { record.error = true; });
  };
  let stateDir, migrationStarted = false, migrationComplete = false, retain = false;
  t.after(async () => {
    if (retain) {
      t.diagnostic(`Fixture retained because ownership could not be confirmed: ${root}; ${fake.binDir}`);
      return;
    }
    if (process.platform === "linux") {
      if (migrationStarted && !migrationComplete) {
        t.diagnostic(`Fixture retained after incomplete migration: ${root}; ${fake.binDir}`);
        return;
      }
      try {
        const records = fs.existsSync(trackingLog)
          ? fs.readFileSync(trackingLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
        for (const owner of owners) {
          assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.closed && !owner.error, "fixture owner close was not confirmed");
          const ready = records.filter(record => record.type === "ready" && record.pid === owner.pid);
          assert.equal(ready.length, 1, "fixture owner tracking was not confirmed");
          assert.ok(ready[0].identity?.start, "fixture owner start identity is missing");
        }
        const identities = records.filter(record => record.type === "spawn");
        for (const record of records.filter(record => record.type === "sync")) {
          assert.ok(record.pid > 0 && !record.error && (record.status !== null || record.signal !== null), "synchronous fake process exit was not confirmed");
        }
        for (const record of identities) {
          assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && record.identity?.start, "fixture child start identity is missing");
          if (record.detached) assert.equal(record.identity.group, record.pid, "detached child group was not identified");
          else assert.equal(records.filter(entry => entry.type === "close" && entry.pid === record.pid).length, 1, "non-detached child close was not confirmed");
          const deadline = Date.now() + 15000;
          for (;;) {
            let live = false;
            try {
              const raw = fs.readFileSync(`/proc/${record.pid}/stat`, "utf8");
              const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
              live = fields[19] === record.identity.start && !["Z", "X", "x"].includes(fields[0]);
            } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
            let groupLive = false;
            if (record.detached) {
              try { process.kill(-record.pid, 0); groupLive = true; }
              catch (error) { if (error.code !== "ESRCH") throw error; }
            }
            if (!live && !groupLive) break;
            if (Date.now() >= deadline) throw new Error(`fixture child or owned group did not exit: ${record.pid}`);
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        if (migrationComplete) {
          const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
          assert.equal(stopped.stopped, true);
          assert.equal(stopped.stateDir, stateDir);
        }
      } catch (error) {
        throw new Error(`Fixture retained because process termination could not be confirmed: ${root}; ${fake.binDir}`, { cause: error });
      }
    }
    removeTempFixture(root, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  });
  if (stateful && ["win32", "linux", "darwin"].includes(process.platform)) {
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
    try {
      // このfixtureだけの未使用stateを、子CLIと同じdata環境で明示移行する。
      stateDir = resolveStateDir(repo);
      migrationStarted = true;
      migrateStateLock(repo, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
      migrationComplete = true;
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
  return { root, fake, repo, env, command, trackOwner, retainFixture: () => { retain = true; } };
}

test("task preserves equals signs in inline prompt-file paths and model values", (t) => {
  const model = "test=model==";
  const w = workspace(t, { availableModels: [model], replies: [{ text: "DONE" }] }, { stateful: true });
  const promptFile = path.join(w.repo, "request = original==.txt");
  const prompt = "Read the original request.\nKeep --write as text and preserve = signs.";
  fs.writeFileSync(promptFile, prompt, "utf8");
  const result = w.command(["task", "--json", "--fresh", `--model=${model}`, `--prompt-file=${promptFile}`]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "completed");
  assert.ok(w.fake.readState().prompts[0].includes(prompt));
  assert.deepEqual(w.fake.readState().models, [model]);
  const stored = w.command(["result", payload.jobId]);
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /DONE/);
});

test("completed history keeps queued, running and pending-cancellation jobs available", (t) => {
  const w = workspace(t, undefined, { stateful: true });
  w.env.GROK_COMPANION_SESSION_ID = "maintenance-history";
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = w.env.CLAUDE_PLUGIN_DATA;
  try {
    const now = Date.now();
    const jobs = [
      { id: "old-pending", status: "cancelled", terminationPending: true },
      { id: "old-running", status: "running", pid: process.pid },
      { id: "old-queued", status: "queued" },
      ...Array.from({ length: 50 }, (_, i) => ({ id: `finished-${i}`, status: "completed" }))
    ].map((job, i) => ({ ...job, sessionId: w.env.GROK_COMPANION_SESSION_ID, workspaceRoot: w.repo, jobClass: "task", title: job.id,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now + i).toISOString(),
      logFile: resolveJobLogFile(w.repo, job.id) }));
    const stateFile = resolveStateFile(w.repo);
    fs.mkdirSync(path.dirname(resolveJobFile(w.repo, "old-pending")), { recursive: true });
    for (const job of jobs) {
      fs.writeFileSync(resolveJobFile(w.repo, job.id), JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(job.logFile, `${job.id}\n`, { encoding: "utf8", mode: 0o600 });
    }
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs }), "utf8");
    const result = w.command(["task", "--json", "--fresh", "finish a new task"]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const id of ["old-pending", "old-running", "old-queued"]) {
      assert.ok(state.jobs.some((job) => job.id === id), `${id} must remain indexed`);
      assert.equal(fs.existsSync(resolveJobFile(w.repo, id)), true);
      assert.equal(fs.existsSync(resolveJobLogFile(w.repo, id)), true);
    }
    const posix = process.platform === "linux" || process.platform === "darwin";
    assert.equal(state.jobs.filter((job) => job.status === "completed").length, posix ? 51 : 50);
    if (posix) {
      for (const job of jobs.filter((entry) => entry.status === "completed")) {
        assert.ok(state.jobs.some((entry) => entry.id === job.id), job.id + " must remain indexed");
        assert.equal(fs.existsSync(resolveJobFile(w.repo, job.id)), true);
        assert.equal(fs.existsSync(job.logFile), true);
      }
    }
    const status = w.command(["status", "--json", "--all"]);
    assert.equal(status.status, 0, status.stderr);
    assert.ok(JSON.parse(status.stdout).running.some((job) => job.id === "old-pending"));
    const beforeCancellation = fs.readFileSync(stateFile, "utf8");
    const beforeDetail = fs.readFileSync(resolveJobFile(w.repo, "old-pending"), "utf8");
    const cancelled = w.command(["cancel", "--json", "old-pending"]);
    assert.equal(cancelled.status, 1, cancelled.stderr);
    if (process.platform === "linux") assert.match(cancelled.stderr, /generation is missing or changed; the cancellation request was not recorded/i);
    else if (process.platform === "darwin") assert.match(cancelled.stderr, /no verified current worker lease; cancellation remains pending/i);
    else assert.match(cancelled.stderr, /cancellation remains pending/i);
    if (posix) {
      assert.equal(fs.readFileSync(stateFile, "utf8"), beforeCancellation);
      assert.equal(fs.readFileSync(resolveJobFile(w.repo, "old-pending"), "utf8"), beforeDetail);
    }
    const retained = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === "old-pending");
    assert.equal(retained.status, "cancelled");
    assert.equal(retained.terminationPending, true);
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(w.repo, retained.id), "utf8"));
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.terminationPending, true);
    if (!posix) assert.equal(stored.phase, "termination-pending");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("cancel stops a held task even when its log path is a directory", async (t) => {
  const w = workspace(t, { holdPrompt: true }, { stateful: true });
  const child = spawn(process.execPath, [SCRIPT, "task", "--json", "--fresh", "hold this task"], {
    cwd: w.repo, env: w.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  w.trackOwner(child);
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once("close", resolve));
  let job;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = w.command(["status", "--json"]);
      assert.equal(status.status, 0, status.stderr);
      job = JSON.parse(status.stdout).running[0];
      if (job?.processStartKey && w.fake.readState()?.prompts.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(job?.processStartKey && w.fake.readState()?.prompts.length, "held task must have started");
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = w.env.CLAUDE_PLUGIN_DATA;
    let stateFile, jobFile;
    try {
      stateFile = resolveStateFile(w.repo);
      jobFile = resolveJobFile(w.repo, job.id);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    const badLog = path.join(w.root, "unwritable-log");
    fs.mkdirSync(badLog);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.jobs.find((entry) => entry.id === job.id).logFile = badLog;
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
    const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    fs.writeFileSync(jobFile, JSON.stringify({ ...stored, logFile: badLog }), "utf8");
    const cancelled = w.command(["cancel", "--json", job.id]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
    await Promise.race([exited, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("task remained alive after cancellation")), 6000);
      timer.unref();
    })]);
    const final = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    assert.equal(final.terminationPending, false);
    assert.equal(final.pid, null);
    assert.ok(JSON.parse(cancelled.stdout).logWarnings.length > 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});

test("setup performs each Grok availability probe only once", (t) => {
  const w = workspace(t, undefined, { stateful: true });
  const invocations = path.join(w.root, "invocations.jsonl");
  w.env.FAKE_GROK_INVOCATIONS = invocations;
  const result = w.command(["setup", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true, JSON.stringify(payload.auth));
  assert.deepEqual(payload.grok, payload.auth.availability);
  const calls = fs.readFileSync(invocations, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args[0] === "--version").length, 1);
  assert.equal(calls.filter((args) => args.join(" ") === "agent stdio --help").length, 1);
});

test("setup distinguishes unavailable authentication check from rejected credentials", (t) => {
  const unconfirmed = workspace(t);
  const posixStrictState = ["linux", "darwin"].includes(process.platform);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = unconfirmed.env.CLAUDE_PLUGIN_DATA;
  let stateFile;
  try {
    stateFile = resolveStateFile(unconfirmed.repo);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: posixStrictState ? 0o700 : 0o777 });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }), posixStrictState ? { mode: 0o600 } : undefined);
    if (posixStrictState) {
      fs.chmodSync(path.dirname(stateFile), 0o700);
      fs.chmodSync(stateFile, 0o600);
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const stateDir = path.dirname(stateFile);
  const beforeEntries = posixStrictState ? fs.readdirSync(stateDir, { recursive: true }).sort() : null;
  const beforeState = posixStrictState ? fs.readFileSync(stateFile) : null;
  const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); return { dev: stat.dev, ino: stat.ino, mode: stat.mode }; };
  const beforeIdentities = posixStrictState ? [stateDir, stateFile].map(identity) : null;
  for (const args of [["setup", "--json"], ["setup"]]) {
    const result = unconfirmed.command(args);
    assert.equal(result.status, 0, result.stderr);
    if (args.includes("--json")) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.ready, false);
      assert.equal(report.auth.reason, "connect-failed");
      assert.match(report.auth.detail, /explicit offline migration/);
      assert.doesNotMatch(report.nextSteps.join("\n"), /grok login/);
      if (posixStrictState) {
        assert.ok(report.auth.detail.includes(stateDir));
        assert.match(report.auth.detail, /state-lock migrate --offline-confirmed --local-only --expected-state-dir/);
        assert.equal(report.reviewGateEnabled, null);
        assert.equal(report.sessionRuntime, null);
        assert.doesNotMatch(result.stdout, /not signed in|grok login/i);
      }
    } else {
      assert.match(result.stdout, /auth:.*could not be checked/i);
      assert.match(result.stdout, /explicit offline migration/);
      assert.doesNotMatch(result.stdout, /not signed in|grok login/i);
      if (posixStrictState) {
        assert.match(result.stdout, /Status: needs attention/);
        assert.ok(result.stdout.includes(stateDir));
        assert.match(result.stdout, /state-lock migrate --offline-confirmed --local-only --expected-state-dir/);
        assert.match(result.stdout, /- review gate: unknown/);
        assert.match(result.stdout, /- shared broker: unknown/);
      }
    }
    if (posixStrictState) {
      assert.deepEqual(fs.readdirSync(stateDir, { recursive: true }).sort(), beforeEntries);
      assert.deepEqual(fs.readFileSync(stateFile), beforeState);
      assert.deepEqual([stateDir, stateFile].map(identity), beforeIdentities);
    }
  }

  for (const [scenario, reason] of [[{ authError: true }, "not-authenticated"], [{ sessionError: "Workspace unavailable" }, "check-failed"]]) {
    const w = workspace(t, scenario, { stateful: true });
    const json = w.command(["setup", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ready, false);
    assert.equal(report.auth.reason, reason);
    const text = w.command(["setup"]);
    assert.equal(text.status, 0, text.stderr);
    if (reason === "not-authenticated") {
      assert.match(report.nextSteps.join("\n"), /grok login/);
      assert.match(text.stdout, /not signed in/);
      assert.match(text.stdout, /grok login/);
    } else {
      assert.doesNotMatch(report.nextSteps.join("\n"), /grok login/);
      assert.match(text.stdout, /auth:.*could not be checked/i);
      assert.match(text.stdout, /Workspace unavailable/);
      assert.doesNotMatch(text.stdout, /not signed in|grok login/i);
    }
  }
});


// stateDir の検査後に FIFO へ交換されても、setup は block せず拒否する。
test("Darwin setup rejects a state directory replaced by a FIFO before open", { skip: process.platform !== "darwin", timeout: 20000 }, async t => {
  const w = workspace(t);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = w.env.CLAUDE_PLUGIN_DATA;
  let stateDir;
  try { stateDir = resolveStateDir(w.repo); }
  finally { if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous; }
  assert.ok(path.isAbsolute(stateDir) && stateDir.startsWith(w.env.CLAUDE_PLUGIN_DATA + path.sep));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const stateFile = path.join(stateDir, "state.json"), preserved = path.join(w.root, "preserved-race-state");
  const ready = path.join(w.root, "fifo-race.json"), preload = path.join(w.root, "fifo-race.cjs");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }), { mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
  const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode) }; };
  const originalDir = identity(stateDir), originalFile = identity(stateFile);
  const bytes = fs.readFileSync(stateFile), entries = fs.readdirSync(stateDir, { recursive: true }).sort();
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs"), cp = require("node:child_process"), { syncBuiltinESMExports } = require("node:module");
const lstat = fs.lstatSync, open = fs.openSync; let checked;
const target = process.env.GROK_TEST_RACE_DIR;
fs.lstatSync = function(file,...args) {
  const result = lstat.call(this,file,...args);
  if (file === target && new Error().stack.includes("assertStateLockBarrier")) checked = result;
  return result;
};
fs.openSync = function(file,...args) {
  if (file === target && new Error().stack.includes("assertStateLockBarrier")) {
    if (!checked || !checked.isDirectory() || checked.isSymbolicLink()) throw Error("fixture did not observe verified root lstat");
    const current = lstat.call(fs,target,{bigint:true});
    if (current.dev !== checked.dev || current.ino !== checked.ino) throw Error("fixture state identity changed before swap");
    fs.renameSync(target,process.env.GROK_TEST_RACE_PRESERVED);
    cp.execFileSync("/usr/bin/mkfifo",[target]);
    const fifo=lstat.call(fs,target,{bigint:true}), moved=lstat.call(fs,process.env.GROK_TEST_RACE_PRESERVED,{bigint:true});
    fs.writeFileSync(process.env.GROK_TEST_RACE_READY,JSON.stringify({fifoDev:String(fifo.dev),fifoIno:String(fifo.ino),movedDev:String(moved.dev),movedIno:String(moved.ino)}));
  }
  return open.call(this,file,...args);
};
syncBuiltinESMExports();`);
  const env = { ...w.env, GROK_TEST_RACE_DIR: stateDir, GROK_TEST_RACE_PRESERVED: preserved, GROK_TEST_RACE_READY: ready,
    NODE_OPTIONS: [w.env.NODE_OPTIONS, `--require="${preload}"`].filter(Boolean).join(" ") };
  let child, closed = false, timedOut = false, stdout = "", stderr = "";
  try {
    child = spawn(process.execPath, [SCRIPT, "setup", "--json"], { cwd: w.repo, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { closed = true; clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(timedOut, false, "setup blocked while opening the replacement FIFO");
    assert.equal(result.code, 1, stderr);
    assert.equal(stdout.trim(), "");
    assert.ok(fs.existsSync(ready), "race did not reach the intended lstat-to-open window");
    const swapped = JSON.parse(fs.readFileSync(ready, "utf8"));
    const fifo = fs.lstatSync(stateDir, { bigint: true });
    assert.ok(fifo.isFIFO());
    assert.equal(String(fifo.dev), swapped.fifoDev); assert.equal(String(fifo.ino), swapped.fifoIno);
    assert.equal(swapped.movedDev, originalDir.dev); assert.equal(swapped.movedIno, originalDir.ino);
    assert.deepEqual(identity(preserved), originalDir);
    assert.deepEqual(identity(path.join(preserved, "state.json")), originalFile);
    assert.deepEqual(fs.readdirSync(preserved, { recursive: true }).sort(), entries);
    assert.deepEqual(fs.readFileSync(path.join(preserved, "state.json")), bytes);
    assert.match(stderr, /ENOTDIR: not a directory|Darwin state directory (?:changed before migration inspection|identity or permissions are invalid)|Workspace state candidate is not a verified directory/i);
    assert.doesNotMatch(stderr, /explicit offline migration/i);
  } finally {
    if (child && !closed) { w.retainFixture(); throw new Error(`Race child exit unconfirmed; fixture retained: ${w.root}`); }
    if (fs.existsSync(preserved)) {
      try {
        const swapped = JSON.parse(fs.readFileSync(ready, "utf8"));
        const fifo = fs.lstatSync(stateDir, { bigint: true });
        assert.ok(fifo.isFIFO() && String(fifo.dev) === swapped.fifoDev && String(fifo.ino) === swapped.fifoIno);
        assert.deepEqual(identity(preserved), originalDir);
        fs.unlinkSync(stateDir);
        fs.renameSync(preserved, stateDir);
        assert.deepEqual(identity(stateDir), originalDir);
        assert.deepEqual(identity(stateFile), originalFile);
        assert.deepEqual(fs.readFileSync(stateFile), bytes);
      } catch (error) { w.retainFixture(); throw new Error(`Race fixture restoration unconfirmed; retained: ${w.root}`, { cause: error }); }
    } else if (fs.existsSync(ready)) { w.retainFixture(); throw new Error(`Race fixture changed unexpectedly; retained: ${w.root}`); }
  }
});

test("setup fails closed for an incomplete POSIX state lock", { skip: !["linux", "darwin"].includes(process.platform) ? "POSIX state lock only" : false }, (t) => {
  const w = workspace(t);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = w.env.CLAUDE_PLUGIN_DATA;
  let stateFile;
  try {
    stateFile = resolveStateFile(w.repo);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const stateDir = path.dirname(stateFile);
  const lockDir = path.join(stateDir, "state.lock");
  const marker = path.join(lockDir, "protocol.json");
  assert.ok(path.isAbsolute(stateDir));
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  fs.chmodSync(lockDir, 0o700);
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }), { mode: 0o600 });
  fs.writeFileSync(marker, "{", { mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
  fs.chmodSync(marker, 0o600);
  const entries = fs.readdirSync(stateDir, { recursive: true }).sort();
  const stateBytes = fs.readFileSync(stateFile);
  const markerBytes = fs.readFileSync(marker);
  const identity = (file) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
  };
  const identities = [stateDir, stateFile, lockDir, marker].map(identity);
  for (const args of [["setup", "--json"], ["setup"]]) {
    const result = w.command(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /state lock migration is incomplete or invalid.*offline recovery is required/i);
    assert.equal(result.stdout.trim(), "");
    assert.deepEqual(fs.readdirSync(stateDir, { recursive: true }).sort(), entries);
    assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
    assert.deepEqual(fs.readFileSync(marker), markerBytes);
    assert.deepEqual([stateDir, stateFile, lockDir, marker].map(identity), identities);
  }
});

for (const condition of ["symlink", "non-private"]) {
  test(`setup fails closed for an unsafe POSIX state directory: ${condition}`, { skip: !["linux", "darwin"].includes(process.platform) ? "POSIX state lock only" : false }, (t) => {
    const w = workspace(t);
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = w.env.CLAUDE_PLUGIN_DATA;
    let stateFile;
    try { stateFile = resolveStateFile(w.repo); }
    finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    const stateDir = path.dirname(stateFile);
    assert.ok(path.isAbsolute(stateDir));
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }), { mode: 0o600 });
    let preservedDir = stateDir, symlinkAttempted = false, linkIdentity, targetIdentity;
    const identity = (file) => {
      const stat = fs.lstatSync(file, { bigint: true });
      return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
    };
    try {
      if (condition === "symlink") {
        preservedDir = path.join(w.root, "preserved-state");
        fs.renameSync(stateDir, preservedDir);
        targetIdentity = identity(preservedDir);
        symlinkAttempted = true;
        fs.symlinkSync(preservedDir, stateDir, "dir");
        linkIdentity = identity(stateDir);
      } else fs.chmodSync(stateDir, 0o755);
      const paths = [stateDir, preservedDir, path.join(preservedDir, "state.json")];
      const identities = paths.map(identity);
      const entries = fs.readdirSync(preservedDir, { recursive: true }).sort();
      const stateBytes = fs.readFileSync(path.join(preservedDir, "state.json"));
      const linkTarget = condition === "symlink" ? fs.readlinkSync(stateDir) : null;
      for (const args of [["setup", "--json"], ["setup"]]) {
        const result = w.command(args);
        assert.equal(result.status, 1, result.stderr);
        assert.notEqual(result.stderr.trim(), "");
        assert.equal(result.stdout.trim(), "");
        assert.deepEqual(paths.map(identity), identities);
        assert.deepEqual(fs.readdirSync(preservedDir, { recursive: true }).sort(), entries);
        assert.deepEqual(fs.readFileSync(path.join(preservedDir, "state.json")), stateBytes);
        if (condition === "symlink") assert.equal(fs.readlinkSync(stateDir), linkTarget);
      }
    } finally {
      if (symlinkAttempted) {
        try {
          assert.ok(linkIdentity && targetIdentity, "created link ownership must be recorded");
          assert.ok(fs.lstatSync(stateDir).isSymbolicLink());
          assert.deepEqual(identity(stateDir), linkIdentity);
          assert.equal(fs.readlinkSync(stateDir), preservedDir);
          assert.deepEqual(identity(preservedDir), targetIdentity);
          const followed = fs.statSync(stateDir, { bigint: true });
          assert.ok(followed.isDirectory());
          assert.deepEqual({ dev: followed.dev, ino: followed.ino, mode: followed.mode }, targetIdentity);
          fs.unlinkSync(stateDir);
        } catch (error) {
          w.retainFixture();
          throw new Error(`Symlink ownership or removal could not be confirmed; fixture retained: ${w.root}`, { cause: error });
        }
      }
    }
  });
}

test("setup reports missing Grok as an unavailable authentication check", (t) => {
  const w = workspace(t, undefined, { stateful: true });
  w.env.GROK_BIN = path.join(w.root, "missing-grok");
  const json = w.command(["setup", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.grok.available, false);
  assert.equal(report.auth.authenticated, false);
  assert.equal(report.auth.reason, "grok-missing");
  assert.doesNotMatch(json.stdout, /not signed in|grok login/i);
  const text = w.command(["setup"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /auth: (?:could not be checked|unknown)/i);
  assert.doesNotMatch(text.stdout, /not signed in|grok login/i);
});

test("setup stops on Git lookup failure instead of migrating a subdirectory state", { skip: process.platform !== "linux" ? "Linux fake Git fixture" : false }, (t) => {
  const w = workspace(t);
  const subdir = path.join(w.repo, "nested");
  const binDir = path.join(w.root, "fake-git-bin");
  fs.mkdirSync(subdir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "git"), `#!/bin/sh
case " $* " in
  *" --version "*) printf 'git version 2.45.0\n'; exit 0 ;;
esac
printf 'fatal: injected git lookup failure\n' >&2
exit 128
`, { mode: 0o755 });
  fs.chmodSync(path.join(binDir, "git"), 0o755);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = w.env.CLAUDE_PLUGIN_DATA;
  let stateFile;
  try { stateFile = resolveStateFile(w.repo); }
  finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const stateDir = path.dirname(stateFile), stateRoot = path.dirname(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }), { mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
  const canonicalSubdir = fs.realpathSync.native(subdir);
  const hash = createHash("sha256").update(canonicalSubdir).digest("hex").slice(0, 16);
  const wrongStateDir = path.join(stateRoot, `nested-${hash}`);
  assert.notEqual(wrongStateDir, stateDir);
  const beforeEntries = fs.readdirSync(stateRoot, { recursive: true }).sort();
  const beforeState = fs.readFileSync(stateFile);
  const env = { ...w.env, PATH: `${binDir}${path.delimiter}${w.env.PATH ?? ""}` };
  for (const flag of [null, "--enable-review-gate", "--disable-review-gate"]) {
    for (const args of [["setup", "--json"], ["setup"]].map(command => flag ? [...command, flag] : command)) {
      const result = w.command(args, { cwd: subdir, env });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Git repository lookup failed.*injected git lookup failure/i);
      assert.equal(result.stdout.trim(), "");
      assert.ok(!`${result.stdout}\n${result.stderr}`.includes(wrongStateDir));
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /explicit offline migration/i);
      assert.deepEqual(fs.readdirSync(stateRoot, { recursive: true }).sort(), beforeEntries);
      assert.deepEqual(fs.readFileSync(stateFile), beforeState);
      assert.equal(fs.existsSync(wrongStateDir), false);
    }
  }
});
