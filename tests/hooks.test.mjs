import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getReviewGateSession, listJobs, saveState } from "../plugins/grok/scripts/lib/state.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { copyTestDirectory, initGitRepo, makeTempDir, run } from "./helpers.mjs";


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

function makeReviewWorkspace() {
  const workspace = makeTempDir("grok-stop-hook-git-workspace-");
  initGitRepo(workspace);
  fs.writeFileSync(path.join(workspace, "app.js"), "console.log('v1');\n", "utf8");
  run("git", ["add", "app.js"], { cwd: workspace });
  run("git", ["commit", "-m", "init"], { cwd: workspace });
  return workspace;
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
  assert.match(result.stderr, /could not snapshot the working tree[\s\S]*Git repository/i);
  const jobs = withPluginData(pluginData, () => listJobs(workspace));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sessionId, "environment-session");
});

test("Stop skips Grok when UserPromptSubmit proves the turn made no repository changes", () => {
  const workspace = makeReviewWorkspace();
  const pluginData = makeTempDir("grok-stop-hook-baseline-data-");
  const fake = installFakeGrok({ replies: [{ text: "ALLOW: no blockers" }] });
  const env = { ...fake.env, CLAUDE_PLUGIN_DATA: pluginData };
  withPluginData(pluginData, () => {
    saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
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
    saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
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
    saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
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
    saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
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

test("SessionEnd removes only jobs owned by the normalized fallback session", () => {
  const workspace = makeTempDir("grok-session-end-hook-workspace-");
  const pluginData = makeTempDir("grok-session-end-hook-data-");
  withPluginData(pluginData, () => {
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      reviewGateSessions: [
        { sessionId: "environment-session", pendingReason: "mine", updatedAt: "2026-01-01T00:00:01.000Z" },
        { sessionId: "session-b", pendingReason: "theirs", updatedAt: "2026-01-01T00:00:02.000Z" }
      ],
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
  assert.equal(withPluginData(pluginData, () => getReviewGateSession(workspace, "environment-session")), null);
  assert.equal(
    withPluginData(pluginData, () => getReviewGateSession(workspace, "session-b"))?.pendingReason,
    "theirs"
  );
});

// 登録されたコマンドそのものをシェルで実行し、空白を含むプラグインパスも検証する。
for (const flavor of ['codex', 'claude']) {
  test(`standard hook commands work through the shell (${flavor})`, () => {
    const temp = makeTempDir('grok hooks 日本語 space-');
    const root = path.join(temp, 'plugin with spaces');
    copyTestDirectory(PLUGIN_ROOT, root);
    const data = path.join(temp, 'data');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: '', PLUGIN_ROOT: '', CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '', CLAUDE_ENV_FILE: '' };
    env[flavor === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT'] = root;
    env[flavor === 'codex' ? 'PLUGIN_DATA' : 'CLAUDE_PLUGIN_DATA'] = data;
    for (const [event, groups] of Object.entries(manifest.hooks)) {
      const command = groups[0].hooks[0].command;
      const executable = process.platform === 'win32' ? 'pwsh' : '/bin/sh';
      const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
      const result = run(executable, args, { shell: false, env, cwd: temp, input: JSON.stringify({ cwd: temp, session_id: 'shell-test', hook_event_name: event }) });
      assert.equal(result.status, 0, `${event}: ${result.stderr}`);
      assert.equal(result.stderr, '', event);
    }
  });
}
