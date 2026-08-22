import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listJobs, saveState } from "../plugins/grok/scripts/lib/state.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

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

function runHook(script, args, input, env = {}) {
  return run(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      ...env
    },
    input: JSON.stringify(input)
  });
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
    saveState(workspace, {
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
  const workspace = makeTempDir("grok-stop-hook-enabled-workspace-");
  const pluginData = makeTempDir("grok-stop-hook-enabled-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: no blockers" }] });
  withPluginData(pluginData, () => {
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: true },
      jobs: []
    });
  });

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

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const jobs = withPluginData(pluginData, () => listJobs(workspace));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sessionId, "environment-session");
});

test("SessionEnd removes only jobs owned by the normalized fallback session", () => {
  const workspace = makeTempDir("grok-session-end-hook-workspace-");
  const pluginData = makeTempDir("grok-session-end-hook-data-");
  withPluginData(pluginData, () => {
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "mine",
          status: "completed",
          sessionId: "environment-session",
          updatedAt: "2026-01-01T00:00:01.000Z"
        },
        { id: "theirs", status: "running", sessionId: "session-b", updatedAt: "2026-01-01T00:00:02.000Z" }
      ]
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
  assert.deepEqual(remaining.map((job) => job.id), ["theirs"]);
});
