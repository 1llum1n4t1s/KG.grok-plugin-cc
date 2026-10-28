/**
 * 偽の `grok agent stdio` を相手に、companion スクリプトの各コマンドを
 * 実プロセスとして走らせる統合テスト。実際の xAI API は叩かない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { listJobs, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, saveState, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { createBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";
import { reserveLinuxTrackedJob } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { sendBrokerShutdown } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok", "scripts", "grok-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "grok", "scripts", "session-lifecycle-hook.mjs");

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-attention",
  summary: "One real problem.",
  findings: [
    {
      severity: "high",
      title: "Unvalidated input",
      body: "The name argument reaches the query unescaped.",
      file: "auth.js",
      line_start: 2,
      line_end: 2,
      confidence: 0.9,
      recommendation: "Use a parameterized query."
    }
  ],
  next_steps: ["Parameterize the query."]
});

/** 偽 grok と使い捨ての git リポジトリを用意する。 */
function setupWorkspace(scenario) {
  const fake = installFakeGrok(scenario);
  const repo = makeTempDir("grok-plugin-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "auth.js"), "export const a = 1;\n", "utf8");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "初期化"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "auth.js"), "export const a = 2;\n", "utf8");

  // ジョブの状態を実ユーザーの領域へ書かないよう隔離する。
  const dataDir = makeTempDir("grok-plugin-data-");
  if (["win32", "linux", "darwin"].includes(process.platform)) {
    const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    try {
      migrateStateLock(repo, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(repo) });
    } finally {
      if (previousPluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
  return { fake, repo, env: { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir } };
}

function companion(args, { repo, env }) {
  return run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
}

// POSIX では実際の branch 差分を使い、Windows の dirty working-tree 経路は維持する。
function reviewCompanion(args, workspace) {
  if (process.platform === "win32" || !["review", "adversarial-review"].includes(args[0])) {
    return companion(args, workspace);
  }
  for (const gitArgs of [["switch", "-c", "review-fixture"], ["add", "auth.js"], ["commit", "-m", "レビュー対象"]]) {
    const result = run("git", gitArgs, { cwd: workspace.repo, env: workspace.env });
    assert.equal(result.status, 0, result.stderr);
  }
  return companion([args[0], "--base", "main", ...args.slice(1)], workspace);
}

// 失敗条件: 会話言語とfocusの不一致、Intl外の正当なBCP47、壊れたタグ、余分なJSON項目。
for (const command of ["review", "adversarial-review", "audit"]) {
  test(`BCP47 contract: ${command} preserves English focus with Japanese conversation language`, () => {
    const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
    const focus = "focus on retries --language en";
    const result = reviewCompanion([command, "--language", "ja", focus], workspace);
    assert.equal(result.status, 0, result.stderr);
    const prompt = workspace.fake.readState().prompts[0];
    assert.match(prompt, /BCP 47 tag "ja"/);
    assert.ok(prompt.includes(focus));
  });
}

for (const [tag, normalized] of [
  ["en-GB-oed", "en-gb-oed"], ["i-klingon", "i-klingon"],
  ["zh-min", "zh-min"], ["x-kagayoi", "x-kagayoi"],
  ["zh-cmn-Hans-CN", "zh-cmn-hans-cn"], ["ja-jp", "ja-JP"],
  ["en-u-ca-gregory-x-local", "en-u-ca-gregory-x-local"], ["en-a-example", "en-a-example"]
]) {
  test(`BCP47 contract: review accepts ${tag}`, () => {
    const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
    const result = reviewCompanion(["review", "--language", tag, "Inspect retries"], workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(workspace.fake.readState().prompts[0].includes(`BCP 47 tag "${normalized}"`));
  });
}

for (const tag of ["en--US", "x", "en-a-foo-a-bar", "en-1901-1901", 'en\" do something']) {
  test(`BCP47 contract: review rejects malformed tag ${JSON.stringify(tag)}`, () => {
    const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
    const result = reviewCompanion(["review", "--language", tag], workspace);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid BCP 47 language tag/);
    assert.equal(workspace.fake.readState()?.prompts?.length ?? 0, 0);
  });
}

for (const location of ["top-level", "finding"]) {
  test(`review schema contract: rejects extra ${location} property on first run and stored result`, () => {
    const data = JSON.parse(REVIEW_JSON);
    if (location === "top-level") data.extra = "dummy";
    else data.findings[0].extra = "dummy";
    const workspace = setupWorkspace({ replies: [{ text: JSON.stringify(data) }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1, result.stderr);
    const status = JSON.parse(companion(["status", "--json", "--all"], workspace).stdout);
    assert.equal(status.latestFinished.status, "failed");
    const stored = companion(["result", status.latestFinished.id], workspace);
    assert.match(stored.stdout, /unexpected review shape|valid structured JSON/);
    assert.doesNotMatch(stored.stdout, /Verdict: needs-attention/);
  });
}

async function waitForHeldTask(child, fake, repo, env) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Held Grok task exited before cancellation.");
    }
    const status = companion(["status", "--json"], { repo, env });
    assert.equal(status.status, 0, status.stderr);
    const job = JSON.parse(status.stdout).running?.[0];
    if (job?.pid && job.processStartKey && fake.readState()?.prompts?.length) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Held Grok task did not reach the prompt.");
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Grok task process stayed alive after cancellation.")), 6000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

for (const mode of ["cancel", "session-end"]) {
  test(`${mode} stops a held foreground Grok task`, async () => {
    const { fake, repo, env } = setupWorkspace({ holdPrompt: true });
    env.GROK_COMPANION_SESSION_ID = "held-session";
    const child = spawn(process.execPath, [SCRIPT, "task", "--json", "hold this turn"], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.resume();
    child.stderr.resume();
    try {
      const job = await waitForHeldTask(child, fake, repo, env);
      if (mode === "cancel") {
        const result = companion(["cancel", "--json", job.id], { repo, env });
        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).status, "cancelled");
      } else {
        const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
          cwd: repo,
          env,
          input: JSON.stringify({ cwd: repo, session_id: "held-session", hook_event_name: "SessionEnd" })
        });
        assert.equal(result.status, 0, result.stderr);
      }
      await waitForChildExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
}

test("cancel retains an unverifiable process as a retryable pending cancellation", () => {
  const { repo, env } = setupWorkspace({ replies: [] });
  env.GROK_COMPANION_SESSION_ID = "test-session";
  const job = {
    id: "unverifiable-cancel",
    status: "running",
    jobClass: "task",
    sessionId: "test-session",
    grokSessionId: "fake-session-pending",
    workspaceRoot: repo,
    createdAt: "2026-01-01T00:00:00.000Z",
    pid: process.pid
  };
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  try {
    // Linux は実際の lease と epoch がない旧レコードの取消を拒否する。
    if (process.platform === "linux") reserveLinuxTrackedJob(job);
    updateState(repo, state => {
      const indexed = state.jobs.find(candidate => candidate.id === job.id);
      const record = indexed ? { ...indexed, ...job, grokPromptState: "pending" } : job;
      writeJobFile(repo, job.id, record);
      if (indexed) Object.assign(indexed, record);
      else state.jobs.push(record);
    });
    const result = companion(["cancel", "--json", job.id], { repo, env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cancellation remains pending/i);
    const pending = listJobs(repo).find((candidate) => candidate.id === job.id);
    assert.equal(pending.status, "cancelled");
    assert.equal(pending.terminationPending, true);
    assert.equal(pending.pid, process.pid);
    const waited = companion(["status", "--json", "--wait", "--timeout-ms", "1", job.id], { repo, env });
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).waitTimedOut, true);
    const candidate = companion(["task-resume-candidate", "--json"], { repo, env });
    assert.notEqual(candidate.status, 0, `stdout:\n${candidate.stdout}\nstderr:\n${candidate.stderr}`);
    assert.match(candidate.stderr, /termination is pending; resume is unavailable/i);
    const resume = companion(["task", "--resume-last", "continue"], { repo, env });
    assert.notEqual(resume.status, 0);
    assert.match(resume.stderr, /needs process termination/i);
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("setup reports a ready runtime and the detected model", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: "ok" }] });
  const result = companion(["setup", "--json"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.match(payload.grok.version, /grok 9\.9\.9 \(fake\)/);
  assert.equal(payload.auth.authenticated, true);
  assert.equal(payload.auth.method, "api-key");
});

test("setup reports not-authenticated instead of crashing", () => {
  const { repo, env } = setupWorkspace({ authError: true });
  const result = companion(["setup", "--json"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.authenticated, false);
  assert.match(payload.nextSteps.join("\n"), /grok login/);
  assert.match(payload.nextSteps.join("\n"), /XAI_API_KEY/);
});

test("review renders structured findings and asks for the reasoning model", () => {
  const { fake, repo, env } = setupWorkspace({
    availableModels: ["grok-fake-nonreasoning", "grok-4.7"],
    replies: [{ text: REVIEW_JSON, tools: ["read_file"], thoughts: ["Looking", " at", " the", " diff."] }]
  });

  if (process.platform !== "win32") {
    const config = run("git", ["config", "core.filemode", "false"], { cwd: repo, env });
    assert.equal(config.status, 0, config.stderr);
    const unsupported = companion(["review", "--scope", "working-tree"], { repo, env });
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /Review incomplete: cannot safely read the working tree snapshot/i);
    assert.equal(fake.readState()?.prompts?.length ?? 0, 0);
    assert.doesNotMatch(unsupported.stdout, /Verdict: approve/i);
    const failed = JSON.parse(companion(["status", "--json", "--all"], { repo, env }).stdout);
    assert.equal(failed.latestFinished.status, "failed");
  }

  const result = reviewCompanion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[high\] Unvalidated input \(auth\.js:2\)/);
  assert.match(result.stdout, /Parameterize the query\./);

  const jobIdMatch = result.stderr.match(/^\[grok\] Job ID: (review-[a-z0-9-]+)$/m);
  assert.ok(jobIdMatch, `foreground review did not announce its job ID:\n${result.stderr}`);

  const stored = companion(["result", jobIdMatch[1]], { repo, env });
  assert.equal(stored.status, 0, `stdout:\n${stored.stdout}\nstderr:\n${stored.stderr}`);
  assert.match(stored.stdout, /# Grok Review/);
  assert.match(stored.stdout, /Verdict: needs-attention/);

  // API キー認証時の既定は非推論モデルなので、明示的に差し替えていること。
  const state = fake.readState();
  assert.deepEqual(state.models, ["grok-4.7"]);
});

test("review joins streamed thought chunks into readable sentences", () => {
  // 思考ストリームは診断目的でパース失敗時にだけ描画されるので、失敗経路で確認する。
  const { repo, env } = setupWorkspace({
    replies: [
      { text: "not json at all", thoughts: ["Check", "ing ", "the ", "diff ", "care", "fully."] },
      { text: "still not json" }
    ]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Checking the diff carefully\./);
  // 断片が 1 行ずつに分解されていないこと。
  assert.doesNotMatch(result.stdout, /^- Check$/m);
});

test("review omits the thought stream when the structured result parsed", () => {
  // 思考ストリームは応答言語指定が効かず英語のまま出るので、成功時は出さない。
  const { repo, env } = setupWorkspace({
    replies: [{ text: REVIEW_JSON, thoughts: ["Let me dig deeper into the diff."] }]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.doesNotMatch(result.stdout, /^Reasoning:$/m);
  assert.doesNotMatch(result.stdout, /Let me dig deeper/);
});

test("review asks Grok to re-emit when the first reply is not valid JSON", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: 'Here you go: {"verdict":"approve","summary":"broken " quote"}' }, { text: REVIEW_JSON }]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /Verdict: needs-attention/);

  const state = fake.readState();
  assert.equal(state.prompts.length, 2, "expected one repair round-trip");
  assert.match(state.prompts[1], /could not be parsed as JSON/);
});

test("review surfaces a parse failure when the repair round also fails", () => {
  const { repo, env } = setupWorkspace({
    replies: [{ text: "not json at all" }, { text: "still not json" }]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /did not return valid structured JSON|unexpected review shape/i);
  assert.match(result.stdout, /Raw final message:/);
  assert.match(result.stdout, /still not json/);
  assert.doesNotMatch(result.stdout, /not json at all/);
});

for (const replies of [[{ text: "" }], [{ text: "not json" }, { text: "" }]]) {
  test(`review fails when ${replies.length === 1 ? "the initial" : "the repair"} response is empty`, () => {
    const workspace = setupWorkspace({ replies });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.grok.status, "completed");
    assert.equal(payload.result, null);
    assert.match(payload.parseError, /did not return a final structured message/i);
    const stored = companion(["result", payload.jobId], workspace);
    assert.match(stored.stdout, /did not return a final structured message/i);
  });
}

const APPROVE_JSON = JSON.stringify({
  verdict: "approve",
  summary: "No material findings.",
  findings: [],
  next_steps: []
});

const INCOMPLETE_JSON = JSON.stringify({
  verdict: "incomplete",
  summary: "A required repository read could not be completed.",
  findings: [],
  next_steps: ["Retry the review with repository read access."]
});

for (const command of ["review", "audit", "adversarial-review"]) {
  test(`${command} preserves the latest malformed repair and completion state`, () => {
    const latestText = `${REVIEW_JSON}\n}`;
    const workspace = setupWorkspace({
      replies: [
        { text: "Starting the audit.", stopReason: "end_turn" },
        { text: latestText, stopReason: "end_turn" }
      ]
    });
    const result = reviewCompanion([command, "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.grok.status, "completed");
    assert.equal(payload.grok.stopReason, "end_turn");
    assert.equal(payload.rawOutput, latestText);
    assert.equal(payload.grok.stdout, latestText);
    assert.ok(payload.parseError);
    assert.equal(payload.result, null);
    assert.equal(workspace.fake.readState().prompts.length, 2);

    const stored = companion(["result", payload.jobId], workspace);
    assert.match(stored.stdout, /One real problem/);
    assert.doesNotMatch(stored.stdout, /Starting the audit/);
    const status = JSON.parse(companion(["status", "--json", "--all"], workspace).stdout);
    assert.equal(status.latestFinished.status, "failed");
  });
}

for (const command of ["review", "audit", "adversarial-review"]) {
  test(`${command} reports a denied, cancelled turn without repairing its progress text`, () => {
    const workspace = setupWorkspace({
      replies: [
        {
          requestPermissionFor: {
            title: "Execute `Get-ChildItem -Recurse src | Select-Object @{N='Lines';E={$_.FullName}}`",
            rawInput: { command: "Get-ChildItem -Recurse src | Select-Object @{N='Lines';E={$_.FullName}}" }
          },
          onDenied: { text: "Review in progress.", stopReason: "cancelled" }
        },
        { text: APPROVE_JSON }
      ]
    });

    const result = reviewCompanion([command, "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.grok.status, "cancelled");
    assert.equal(payload.grok.stopReason, "cancelled");
    assert.equal(payload.result, null);
    assert.equal(payload.rawOutput, "Review in progress.");
    assert.match(payload.permissionDenials.join("\n"), /unsupported shell control/i);
    assert.equal(workspace.fake.readState().prompts.length, 1);

    const stored = companion(["result", payload.jobId], workspace);
    assert.match(stored.stdout, /Review incomplete/i);
    assert.match(stored.stdout, /cancelled/i);
    assert.match(stored.stdout, /unsupported shell control/i);
    assert.match(stored.stdout, /Partial message:/);
    assert.doesNotMatch(stored.stdout, /Verdict: approve|Raw final message:/i);
  });
}

function assertPendingReviewResult(workspace, payload) {
  const status = companion(["status", "--json", payload.jobId], workspace);
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).job;
  assert.equal(job.terminationPending, true);
  assert.equal(job.grokPromptState, "pending");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = workspace.env.CLAUDE_PLUGIN_DATA;
  try {
    const detail = readJobFile(resolveJobFile(workspace.repo, payload.jobId));
    assert.equal(detail.terminationPending, true);
    assert.equal(detail.grokPromptState, "pending");
    assert.equal(detail.result.grok.stopReason, "unknown_reason");
    assert.equal(detail.result.result.verdict, "incomplete");
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const stored = companion(["result", payload.jobId], workspace);
  assert.notEqual(stored.status, 0, `stdout:\n${stored.stdout}\nstderr:\n${stored.stderr}`);
  assert.match(stored.stderr, /still needs process termination/i);
  assert.equal(stored.stdout, "");
}

for (const stopReason of ["cancelled", "refusal", "max_tokens", "max_turn_requests", "unknown_reason"]) {
  test(`review never approves structured output from an unfinished ${stopReason} turn`, () => {
    const workspace = setupWorkspace({ replies: [{ text: APPROVE_JSON, stopReason }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.notEqual(payload.grok.status, "completed");
    assert.equal(payload.grok.stopReason, stopReason);
    assert.equal(payload.result.verdict, "incomplete");
    assert.equal(payload.rawOutput, APPROVE_JSON);
    assert.equal(workspace.fake.readState().prompts.length, 1);
    if (stopReason === "unknown_reason") assertPendingReviewResult(workspace, payload);
    else {
      const stored = companion(["result", payload.jobId], workspace);
      assert.equal(stored.status, 0, stored.stderr);
      assert.match(stored.stdout, /Verdict: incomplete/);
      assert.doesNotMatch(stored.stdout, /Verdict: approve/);
    }
  });
}

test("review preserves an unknown reason from the latest repair without confirming its stop", () => {
  const workspace = setupWorkspace({
    replies: [{ text: "not json" }, { text: APPROVE_JSON, stopReason: "unknown_reason" }]
  });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.notEqual(payload.grok.status, "completed");
  assert.equal(payload.grok.stopReason, "unknown_reason");
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.rawOutput, APPROVE_JSON);
  assert.equal(workspace.fake.readState().prompts.length, 2);
  assertPendingReviewResult(workspace, payload);
});

test("review never approves a valid JSON repair from a cancelled turn", () => {
  const workspace = setupWorkspace({
    replies: [{ text: "not json" }, { text: APPROVE_JSON, stopReason: "cancelled" }]
  });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.grok.status, "cancelled");
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.rawOutput, APPROVE_JSON);
  assert.equal(workspace.fake.readState().prompts.length, 2);
});

for (const invalidJson of ["null", "false", "0", '""']) {
  test(`review rejects the invalid top-level JSON value ${invalidJson}`, () => {
    const workspace = setupWorkspace({ replies: [{ text: invalidJson }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result, null);
    assert.match(payload.parseError, /top-level JSON object/i);
    assert.equal(payload.rawOutput, invalidJson);
    const stored = companion(["result", payload.jobId], workspace);
    assert.match(stored.stdout, /top-level JSON object/i);
  });
}

test("review does not expose an invalid partial approval as a structured result", () => {
  const partial = JSON.stringify({ verdict: "approve", summary: "Partial review" });
  const workspace = setupWorkspace({ replies: [{ text: partial, stopReason: "cancelled" }] });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, null);
  assert.equal(payload.rawOutput, partial);
  assert.match(payload.parseError, /findings/i);
  const stored = companion(["result", payload.jobId], workspace);
  assert.match(stored.stdout, /Review incomplete/i);
  assert.match(stored.stdout, /Partial message:/);
});

for (const text of ["", "partial review", APPROVE_JSON]) {
  test(`review preserves ACP failures with ${text ? "partial" : "no"} text (${text.length})`, () => {
    const workspace = setupWorkspace({ replies: [{ text, rpcError: "Review connection failed" }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.grok.status, "failed");
    assert.equal(payload.grok.error, "Review connection failed");
    assert.equal(payload.rawOutput, text);
    assert.notEqual(payload.result?.verdict, "approve");
    const stored = companion(["result", payload.jobId], workspace);
    assert.match(stored.stdout, /Review connection failed/);
    assert.doesNotMatch(stored.stdout, /Verdict: approve/);
  });
}

test("review preserves an empty cancelled repair instead of the initial reply", () => {
  const workspace = setupWorkspace({
    replies: [{ text: "Initial malformed reply" }, { text: "", stopReason: "cancelled" }]
  });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.grok.status, "cancelled");
  assert.equal(payload.rawOutput, "");
  assert.equal(payload.result, null);
  assert.doesNotMatch(payload.parseError, /Initial malformed reply/);
});

test("review denies write-capable shell commands but allows read-only ones", () => {
  const denied = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Execute `rm -rf build`", rawInput: { command: "rm -rf build" } },
        text: REVIEW_JSON,
        onDenied: { text: '{"verdict":"approve","summary":"blocked","findings":[],"next_steps":[]}' }
      }
    ]
  });
  const deniedResult = reviewCompanion(["review", "--wait"], denied);
  assert.equal(deniedResult.status, 1);
  assert.match(deniedResult.stdout, /Verdict: incomplete/);
  assert.match(deniedResult.stdout, /rm -rf build/);
  assert.match(deniedResult.stdout, /must not be treated as approval/i);

  const deniedStatus = JSON.parse(companion(["status", "--json", "--all"], denied).stdout);
  assert.equal(deniedStatus.latestFinished.status, "failed");
  assert.match(deniedStatus.latestFinished.summary, /incomplete/i);

  const allowed = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Execute safe Git diff", rawInput: { command: "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c log.showSignature=false -c format.pretty=medium -c log.diffMerges=off -c diff.submodule=short diff --no-ext-diff --no-textconv --cached -- auth.js" } },
        text: REVIEW_JSON,
        onDenied: { text: '{"verdict":"approve","summary":"blocked","findings":[],"next_steps":[]}' }
      }
    ]
  });
  const allowedResult = reviewCompanion(["review", "--wait"], allowed);
  assert.equal(allowedResult.status, 0);
  assert.match(allowedResult.stdout, /Verdict: needs-attention/);
});

test("audit permits guided date-filtered history through the ACP permission path", () => {
  const command = 'git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c log.showSignature=false -c format.pretty=medium -c log.diffMerges=off -c diff.submodule=short log --no-ext-diff --no-textconv --since="2026-09-28" --oneline';
  const workspace = setupWorkspace({ replies: [{
    requestPermissionFor: { title: "Read recent Git history", rawInput: { command } },
    text: APPROVE_JSON,
    onDenied: { text: APPROVE_JSON }
  }] });
  const result = companion(["audit", "--json", "review the last month of commits"], workspace);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.permissionDenials, []);
  assert.equal(payload.result.verdict, "approve");
  const prompt = workspace.fake.readState().prompts[0];
  assert.match(prompt, /--since=YYYY-MM-DD/);
  assert.match(prompt, /--since=2026-09-28 --oneline/);
});

test("review marks a denied subagent request as incomplete even when Grok returns approve", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Delegate to subagent", rawInput: { agent: "explorer" } },
        text: REVIEW_JSON,
        onDenied: { text: APPROVE_JSON }
      }
    ]
  });

  const result = companion(["audit", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.rawOutput, APPROVE_JSON);
  assert.equal(payload.grok.stdout, APPROVE_JSON);
  assert.match(payload.permissionDenials.join("\n"), /Delegate to subagent/);

  const stored = companion(["result", payload.jobId], workspace);
  assert.match(stored.stdout, /Verdict: incomplete/);
  assert.match(stored.stdout, /Delegate to subagent/);
});

test("review keeps permission denials across JSON repair and cannot repair into approve", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Delegate to subagent", rawInput: { agent: "explorer" } },
        text: REVIEW_JSON,
        onDenied: { text: "not json" }
      },
      { text: APPROVE_JSON }
    ]
  });

  const result = companion(["audit", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.rawOutput, APPROVE_JSON);
  assert.match(payload.permissionDenials.join("\n"), /Delegate to subagent/);
  assert.equal(workspace.fake.readState().prompts.length, 2);
});

test("review rejects a read-only permission request when allow_once is unavailable", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: {
          title: "Execute `git diff auth.js`",
          rawInput: { command: "git diff auth.js" },
          options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }]
        },
        text: REVIEW_JSON,
        onDenied: { text: APPROVE_JSON }
      }
    ]
  });

  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.match(payload.permissionDenials.join("\n"), /no one-time read-only permission option|git diff/i);
});

test("review treats an explicit incomplete verdict as a failed review result", () => {
  const workspace = setupWorkspace({ replies: [{ text: INCOMPLETE_JSON }] });

  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.deepEqual(payload.permissionDenials, []);
  assert.equal(payload.grok.status, "completed");
  assert.equal(payload.grok.stopReason, "end_turn");

  const stored = companion(["result", payload.jobId], workspace);
  assert.match(stored.stdout, /Verdict: incomplete/);
  assert.match(stored.stdout, /must not be treated as approval/i);
});

test("review still completes for an approve verdict without permission denials", () => {
  const workspace = setupWorkspace({ replies: [{ text: APPROVE_JSON }] });

  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "approve");
  assert.deepEqual(payload.permissionDenials, []);

  const status = JSON.parse(companion(["status", "--json", "--all"], workspace).stdout);
  assert.equal(status.latestFinished.status, "completed");
});

test("review rejects an unsolicited ACP file write", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: REVIEW_JSON, requestClientFileWrite: { path: "unexpected.txt", content: "written" } }]
  });
  const result = reviewCompanion(["review", "--json"], { repo, env });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(path.join(repo, "unexpected.txt")), false);
  assert.equal(fake.readState().clientWriteResponse?.code, -32601);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.match(payload.permissionDenials.join(" "), /ACP file write request was denied/);
});

test("adversarial review uses its own prompt template", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = reviewCompanion(["adversarial-review", "--wait", "focus on retries"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Adversarial Review/);

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /adversarial software review/i);
  assert.match(prompt, /focus on retries/);
});

test("review passes focus text through to the standard review prompt", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  reviewCompanion(["review", "--wait", "focus on the retry logic"], { repo, env });

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /focus on the retry logic/);
  assert.match(prompt, /read-only review/i);
  assert.match(prompt, /prefer.*file.reading tools/i);
  assert.match(prompt, /PowerShell.*script blocks/i);
  assert.doesNotMatch(prompt, /Do not modify files, run commands, or write anything to disk/i);
});

test("review writes findings in the language requested via --language", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  reviewCompanion(["review", "--wait", "--language", "ja", "リトライ処理を重点的に"], { repo, env });

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /BCP 47 tag "ja"/);
  assert.match(prompt, /リトライ処理を重点的に/);
});

test("review falls back to the focus language, then English, when --language is absent", () => {
  const withFocus = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  reviewCompanion(["review", "--wait", "focus on retries"], withFocus);
  assert.match(withFocus.fake.readState().prompts[0], /same language as the user focus/);

  const bare = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  reviewCompanion(["review", "--wait"], bare);
  const prompt = bare.fake.readState().prompts[0];
  assert.match(prompt, /in English\./);
  assert.doesNotMatch(prompt, /BCP 47 tag/);
});

test("audit uses the repository-audit template and skips the diff", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["audit", "--wait", "focus on auth"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Audit/);
  assert.match(result.stdout, /Verdict: needs-attention/);

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /full-repository audit/i);
  assert.match(prompt, /ignore any uncommitted diff/i);
  assert.match(prompt, /focus on auth/);
  assert.doesNotMatch(prompt, /default deep-audit focus/i);
  assert.match(prompt, /## Tracked Files/);
  // setupWorkspace は auth.js を書き換えて working tree を汚しているが、
  // 監査プロンプトにその差分が混入しないこと。
  assert.doesNotMatch(prompt, /Unstaged Diff/);
  assert.doesNotMatch(prompt, /export const a = 2;/);
});

test("audit applies a risk-directed deep investigation when focus is omitted", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["audit", "--wait"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /default deep-audit focus/i);
  assert.match(prompt, /highest-risk execution paths/i);
  assert.match(prompt, /callers, callees, state transitions, trust boundaries/i);
  assert.match(prompt, /failure and cleanup paths, concurrency behavior/i);
  assert.match(prompt, /relevant tests or documented contracts/i);
  assert.match(prompt, /Perform all review perspectives yourself in this session/i);
  assert.match(prompt, /do not call spawn_subagent/i);
  assert.match(prompt, /<depth_gate>/);
  assert.doesNotMatch(prompt, /No extra focus provided\./);
});

test("JSON audit keeps progress silent and returns the exact tracked job id", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["audit", "--json"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.match(payload.jobId, /^review-[a-z0-9-]+$/);
  assert.equal(payload.review, "Audit");
  assert.equal(payload.result.verdict, "needs-attention");
  assert.equal(fake.readState().prompts.length, 1);
});

test("review and task commands reject background execution", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  for (const args of [
    ["audit", "--background", "focus on auth"],
    ["task", "--background", "investigate auth"]
  ]) {
    const result = companion(args, { repo, env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--background.*no longer supported.*foreground/i);
  }

  assert.equal(fake.readState(), null, "background rejection must happen before starting Grok");
});

test("task accepts legacy --wait as a foreground no-op", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "--wait", "investigate auth"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fake.readState().prompts[0], /investigate auth/);
  assert.doesNotMatch(fake.readState().prompts[0], /--wait/);
});

test("status tracks a finished review as completed, not failed", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  reviewCompanion(["review", "--wait"], { repo, env });
  const status = companion(["status", "--json", "--all"], { repo, env });
  assert.equal(status.status, 0, status.stderr);

  const payload = JSON.parse(status.stdout);
  // 直近の完了ジョブは recent とは別枠の latestFinished に入る。
  const job = payload.latestFinished;
  assert.ok(job, `status payload: ${JSON.stringify(payload).slice(0, 700)}`);
  assert.equal(job.jobClass, "review");
  assert.equal(job.status, "completed");
  assert.match(job.grokSessionId, /^fake-session-/);
});

test("status marks an unparseable review as failed", () => {
  const { repo, env } = setupWorkspace({
    replies: [{ text: "not json at all" }, { text: "still not json" }]
  });

  reviewCompanion(["review", "--wait"], { repo, env });
  const payload = JSON.parse(companion(["status", "--json", "--all"], { repo, env }).stdout);

  assert.equal(payload.latestFinished.status, "failed");
});

test("result replays the stored rendering of a finished job", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  reviewCompanion(["review", "--wait"], { repo, env });
  const status = JSON.parse(companion(["status", "--json", "--all"], { repo, env }).stdout);
  const result = companion(["result", status.latestFinished.id], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Review/);
  assert.match(result.stdout, /Grok session ID: fake-session-/);
  assert.match(result.stdout, /Resume in Grok: grok --resume fake-session-/);
});

// --- task（/grok:rescue の実体）---------------------------------------
// ここは書き込みを許しうる唯一の経路なので、権限分岐を実プロセスで確かめる。

test("task rejects an omitted rescue request without recording a failed job", () => {
  const workspace = setupWorkspace({ replies: [{ text: "should not run" }] });

  const result = companion(["task"], workspace);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Provide a prompt.*or use --resume-last/i);
  assert.equal(workspace.fake.readState(), null);

  const status = companion(["status", "--json", "--all"], workspace);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.deepEqual(payload.running, []);
  assert.equal(payload.latestFinished, null);
  assert.deepEqual(payload.recent, []);
});

test("status marks schema-invalid review JSON as failed", () => {
  const malformedShape = JSON.stringify({
    verdict: "approve",
    summary: "Looks fine.",
    findings: [{ severity: "urgent", title: "Bad enum" }],
    next_steps: []
  });
  const { repo, env } = setupWorkspace({ replies: [{ text: malformedShape }] });

  reviewCompanion(["review", "--wait"], { repo, env });
  const payload = JSON.parse(companion(["status", "--json", "--all"], { repo, env }).stdout);

  assert.equal(payload.latestFinished.status, "failed");
});

test("task without --write denies write permission requests", () => {
  const { repo, env } = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Write `notes.txt`", rawInput: { command: "echo hi > notes.txt" } },
        text: "wrote the file",
        onDenied: { text: "permission denied" }
      }
    ]
  });

  const result = companion(["task", "add a note"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /permission denied/);
});

test("read-only rescue permits built-in WebFetch but denies ambiguous or write-capable requests", () => {
  // 実障害と同じ ACP 要求を再生し、未知ツール・追加引数・非 HTTP URL の過剰許可も検出する。
  const url = "https://raw.githubusercontent.com/ip7z/7zip/26.03/C/LzmaEnc.c";
  const fetchCall = { title: `Fetch: ${url}`, kind: "fetch", rawInput: { variant: "WebFetch", url } };
  const cases = [
    { name: "builtin", call: fetchCall, allowed: true },
    { name: "http", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "http://example.com/" } }, allowed: true },
    { name: "title-only", call: { title: fetchCall.title, rawInput: fetchCall.rawInput } },
    { name: "other-variant", call: { ...fetchCall, rawInput: { variant: "Upload", url } } },
    { name: "post", call: { ...fetchCall, rawInput: { ...fetchCall.rawInput, method: "POST" } } },
    { name: "output-file", call: { ...fetchCall, rawInput: { ...fetchCall.rawInput, output: "notes.txt" } } },
    { name: "command", call: { ...fetchCall, rawInput: { ...fetchCall.rawInput, command: "echo hi > notes.txt" } } },
    { name: "file-url", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "file:///secret" } } },
    { name: "invalid-url", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "not a URL" } } },
    { name: "credentials", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "https://user:password@example.com/" } } },
    { name: "no-once-option", call: { ...fetchCall, options: [{ optionId: "always", kind: "allow_always" }] } }
  ];
  for (const scenario of cases) {
    const workspace = setupWorkspace({ replies: [{
      requestPermissionFor: scenario.call,
      text: "FETCH_OK",
      onDenied: { text: "FETCH_DENIED", stopReason: "cancelled" }
    }] });
    const result = companion(["task", "--json", "--fresh", "Read the public source without changing files."], workspace);
    const payload = JSON.parse(result.stdout);
    assert.equal(result.status, scenario.allowed ? 0 : 1, `${scenario.name}: ${result.stderr}`);
    assert.equal(payload.rawOutput, scenario.allowed ? "FETCH_OK" : "FETCH_DENIED", scenario.name);
    assert.equal(payload.permissionDenials.length, scenario.allowed ? 0 : 1, scenario.name);
    const stored = companion(["result", payload.jobId], workspace);
    assert.equal(stored.status, 0, stored.stderr);
    assert.match(stored.stdout, scenario.allowed ? /FETCH_OK/ : /FETCH_DENIED/);
    assert.equal(fs.existsSync(path.join(workspace.repo, "notes.txt")), false);
  }
});

test("read-only task confines Test-Path to its repository", () => {
  for (const scenario of ["inside", "outside", "linked-outside", "home-path", "ambiguous-segment", "alternate-stream", "command-suffix", "chained-command"]) {
    const workspace = setupWorkspace({});
    const outsideDir = workspace.fake.binDir;
    const linkPath = path.join(workspace.repo, "linked-outside");
    if (scenario === "linked-outside") {
      fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    }
    const target = scenario === "outside"
      ? path.join(outsideDir, "candidate")
      : scenario === "linked-outside"
        ? path.join(linkPath, "candidate")
        : scenario === "ambiguous-segment"
          ? path.join(workspace.repo, ".. ", "candidate")
          : scenario === "alternate-stream"
            ? `${path.join(workspace.repo, "auth.js")}:stream`
        : path.join(workspace.repo, "build", "candidate");
    const command = `${scenario === "command-suffix" ? "Test-Path.cmd" : "Test-Path"} -LiteralPath "${scenario === "home-path" ? "~/secret" : target}"${scenario === "chained-command" ? " && git checkout ." : ""}`;
    fs.writeFileSync(workspace.env.FAKE_GROK_SCENARIO, JSON.stringify({
      replies: [{
        requestPermissionFor: { title: command, rawInput: { command } },
        text: "permission allowed",
        onDenied: { text: "permission denied" }
      }]
    }), "utf8");

    const result = companion(["task", "--json", "check build directory"], workspace);
    const payload = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.match(payload.rawOutput, scenario === "inside" ? /permission allowed/ : /permission denied/);
    assert.equal(payload.permissionDenials.length, scenario === "inside" ? 0 : 1);
  }
});

test("stop-gate review fails when a denied operation is followed by ALLOW", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Delegate to subagent", rawInput: { agent: "reviewer" } },
        text: "BLOCK: should not be emitted",
        onDenied: { text: "ALLOW: no blockers found in the partial review" }
      }
    ]
  });

  const result = companion(["task", "--stop-gate", "review the previous turn"], workspace);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Review incomplete/i);
  assert.match(result.stdout, /must not be treated as approval/i);
  assert.match(result.stdout, /Delegate to subagent/);
  assert.match(result.stdout, /Raw final message:/);
  assert.match(result.stdout, /ALLOW: no blockers found in the partial review/);

  const jobIdMatch = result.stderr.match(/^\[grok\] Job ID: (task-[a-z0-9-]+)$/m);
  assert.ok(jobIdMatch, result.stderr);
  const stored = companion(["result", jobIdMatch[1]], workspace);
  assert.match(stored.stdout, /Review incomplete/i);
  assert.match(stored.stdout, /Delegate to subagent/);
  assert.match(stored.stdout, /Raw final message:/);

  const status = JSON.parse(companion(["status", "--json", "--all"], workspace).stdout);
  assert.equal(status.latestFinished.status, "failed");
  assert.match(status.latestFinished.summary, /incomplete/i);
});

test("task with --write allows write permission requests", () => {
  const { repo, env } = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Write `notes.txt`", rawInput: { command: "echo hi > notes.txt" } },
        text: "wrote the file",
        onDenied: { text: "permission denied" }
      }
    ]
  });

  const result = companion(["task", "--write", "add a note"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /wrote the file/);
});

test("task does not treat --write inside the prompt text as a flag", () => {
  const { repo, env } = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Write `notes.txt`", rawInput: { command: "echo hi > notes.txt" } },
        text: "wrote the file",
        onDenied: { text: "permission denied" }
      }
    ]
  });

  const result = companion(["task", "explain what the --write flag does"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /permission denied/);
});

test("task forwards the requested model to the session", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "--model", "grok-4.5", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.5"]);
});

test("task asks for grok-4.7 when the model is omitted", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.7"]);
});

test("task resolves the latest alias to grok-4.7", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "--model", "latest", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.7"]);
});

const THOUGHT_LEVEL_OPTION = {
  id: "thought-level",
  name: "Thought level",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" }
  ]
};

test("task leaves reasoning effort alone when --effort is absent", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "done" }],
    configOptions: [THOUGHT_LEVEL_OPTION]
  });

  const result = companion(["task", "do a thing"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fake.readState().configs, []);
});

test("task applies --effort through session/set_config_option", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "done" }],
    configOptions: [THOUGHT_LEVEL_OPTION]
  });

  const result = companion(["task", "--effort", "low", "do a thing"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fake.readState().configs, [{ configId: "thought-level", value: "low" }]);
});

test("task falls back to set_config_option when session/set_model is gone", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "done" }],
    setModelUnsupported: true,
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "grok-fake-nonreasoning",
        options: [{ value: "grok-fake-nonreasoning", name: "fast" }, { value: "grok-4.5", name: "4.5" }]
      }
    ]
  });

  const result = companion(["task", "--model", "grok-4.5", "do a thing"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  const state = fake.readState();
  assert.deepEqual(state.models, []);
  assert.deepEqual(state.configs, [{ configId: "model", value: "grok-4.5" }]);
});

test("resuming a task reloads the previous session and reapplies --effort", { timeout: 30000 }, async () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "carrying on" }],
    configOptions: [THOUGHT_LEVEL_OPTION]
  });
  // 再開には同じbroker世代が確認したterminal履歴が必要。直結の新規agentへ
  // session/loadを送る旧fixtureでは、安全な再開の経路を検証できない。
  const endpoint = createBrokerEndpoint(fake.binDir);
  const brokerEnv = { ...env, GROK_COMPANION_DISABLE_BROKER: "0",
    GROK_COMPANION_ACP_ENDPOINT: endpoint, TMPDIR: fake.binDir, TMP: fake.binDir, TEMP: fake.binDir };
  const { child: broker, exited, session } = await startFixtureBroker(repo, brokerEnv, endpoint);
  brokerEnv.GROK_COMPANION_BROKER_GENERATION = session.generation;
  const brokerStderr = () => fs.existsSync(session.logFile) ? fs.readFileSync(session.logFile, "utf8") : "";
  try {
    const first = companion(["task", "start the work"], { repo, env: brokerEnv });
    assert.equal(first.status, 0, first.stderr);
    const initialState = fake.readState();
    assert.deepEqual(initialState.loads, []);
    assert.equal(initialState.sessions, 1);

    const resumed = companion(["task", "--resume-last", "--effort", "medium", "keep going"], { repo, env: brokerEnv });
    assert.equal(resumed.status, 0, `stdout:
${resumed.stdout}
stderr:
${resumed.stderr}`);
    assert.match(resumed.stdout, /carrying on/);

    const state = fake.readState();
    // 同じagentで新しいセッションを作らず、前回のセッションを読み直している。
    assert.equal(state.pid, initialState.pid);
    assert.equal(state.sessions, 1);
    assert.deepEqual(state.loads, ["fake-session-1"]);
    assert.deepEqual(state.prompts, ["start the work", "keep going"]);
    // 再開でも --effort が当たる（以前は startSession を通らず無視されていた）。
    assert.deepEqual(state.configs, [{ configId: "thought-level", value: "medium" }]);
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) await sendBrokerShutdown(endpoint);
    const { code, signal } = await exited;
    assert.equal(code, 0, `Broker exit (${signal}): ${brokerStderr()}`);
  }
});

test("stop-gate reviews never replace the latest resumable rescue task", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const rescue = companion(["task", "--json", "start the rescue work"], { repo, env });
  assert.equal(rescue.status, 0, rescue.stderr);
  const rescuePayload = JSON.parse(rescue.stdout);

  const stopGate = companion(["task", "--json", "--stop-gate", "review the previous turn"], { repo, env });
  assert.equal(stopGate.status, 0, stopGate.stderr);
  const stopGatePayload = JSON.parse(stopGate.stdout);

  const candidate = companion(["task-resume-candidate", "--json"], { repo, env });
  assert.equal(candidate.status, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  assert.equal(candidatePayload.candidate.id, rescuePayload.jobId);
  assert.notEqual(candidatePayload.candidate.id, stopGatePayload.jobId);

  const status = companion(["status", "--json", "--all"], { repo, env });
  const stopGateJob = JSON.parse(status.stdout).latestFinished;
  assert.equal(stopGateJob.id, stopGatePayload.jobId);
  assert.equal(stopGateJob.jobClass, "review");
  assert.equal(stopGateJob.kind, "stop-gate-review");
});
