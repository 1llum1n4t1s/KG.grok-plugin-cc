import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, removeTempFixture, run } from "./helpers.mjs";
import { migrateStateLock, resolveStateDir, resolveStateFile, resolveJobFile, resolveJobLogFile } from "../plugins/grok/scripts/lib/state.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

function workspace(t, scenario = { replies: [{ text: "DONE" }] }, { stateful = false } = {}) {
  const root = makeTempDir("grok-maintenance-");
  const fake = installFakeGrok(scenario);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: path.join(root, "data") };
  const command = (args) => run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
  t.after(() => {
    removeTempFixture(root, { recursive: true, force: true });
    removeTempFixture(fake.binDir, { recursive: true, force: true });
  });
  if (stateful && ["win32", "linux", "darwin"].includes(process.platform)) {
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
    try {
      // このfixtureだけの未使用stateを、子CLIと同じdata環境で明示移行する。
      migrateStateLock(repo, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(repo) });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
  return { root, fake, repo, env, command };
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
      fs.writeFileSync(resolveJobFile(w.repo, job.id), JSON.stringify(job), "utf8");
      fs.writeFileSync(job.logFile, `${job.id}\n`, "utf8");
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
    assert.equal(state.jobs.filter((job) => job.status === "completed").length, 50);
    const status = w.command(["status", "--json", "--all"]);
    assert.equal(status.status, 0, status.stderr);
    assert.ok(JSON.parse(status.stdout).running.some((job) => job.id === "old-pending"));
    const cancelled = w.command(["cancel", "--json", "old-pending"]);
    assert.equal(cancelled.status, 1, cancelled.stderr);
    assert.match(cancelled.stderr, /cancellation remains pending/i);
    const retained = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === "old-pending");
    assert.equal(retained.status, "cancelled");
    assert.equal(retained.terminationPending, true);
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(w.repo, retained.id), "utf8"));
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.terminationPending, true);
    assert.equal(stored.phase, "termination-pending");
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
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = unconfirmed.env.CLAUDE_PLUGIN_DATA;
  try {
    const stateFile = resolveStateFile(unconfirmed.repo);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  for (const args of [["setup", "--json"], ["setup"]]) {
    const result = unconfirmed.command(args);
    assert.equal(result.status, 0, result.stderr);
    if (args.includes("--json")) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.ready, false);
      assert.equal(report.auth.reason, "connect-failed");
      assert.match(report.auth.detail, /explicit offline migration/);
      assert.doesNotMatch(report.nextSteps.join("\n"), /grok login/);
    } else {
      assert.match(result.stdout, /auth:.*could not be checked/i);
      assert.match(result.stdout, /explicit offline migration/);
      assert.doesNotMatch(result.stdout, /not signed in|grok login/i);
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
