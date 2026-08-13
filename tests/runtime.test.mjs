/**
 * 偽の `grok agent stdio` を相手に、companion スクリプトの各コマンドを
 * 実プロセスとして走らせる統合テスト。実際の xAI API は叩かない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok", "scripts", "grok-companion.mjs");

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
  return { fake, repo, env: { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir } };
}

function companion(args, { repo, env }) {
  return run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
}

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
    availableModels: ["grok-fake-nonreasoning", "grok-4.6"],
    replies: [{ text: REVIEW_JSON, tools: ["read_file"], thoughts: ["Looking", " at", " the", " diff."] }]
  });

  const result = companion(["review", "--wait"], { repo, env });

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
  assert.deepEqual(state.models, ["grok-4.6"]);
});

test("review joins streamed thought chunks into readable sentences", () => {
  // 思考ストリームは診断目的でパース失敗時にだけ描画されるので、失敗経路で確認する。
  const { repo, env } = setupWorkspace({
    replies: [
      { text: "not json at all", thoughts: ["Check", "ing ", "the ", "diff ", "care", "fully."] },
      { text: "still not json" }
    ]
  });

  const result = companion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Checking the diff carefully\./);
  // 断片が 1 行ずつに分解されていないこと。
  assert.doesNotMatch(result.stdout, /^- Check$/m);
});

test("review omits the thought stream when the structured result parsed", () => {
  // 思考ストリームは応答言語指定が効かず英語のまま出るので、成功時は出さない。
  const { repo, env } = setupWorkspace({
    replies: [{ text: REVIEW_JSON, thoughts: ["Let me dig deeper into the diff."] }]
  });

  const result = companion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.doesNotMatch(result.stdout, /^Reasoning:$/m);
  assert.doesNotMatch(result.stdout, /Let me dig deeper/);
});

test("review asks Grok to re-emit when the first reply is not valid JSON", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: 'Here you go: {"verdict":"approve","summary":"broken " quote"}' }, { text: REVIEW_JSON }]
  });

  const result = companion(["review", "--wait"], { repo, env });

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

  const result = companion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /did not return valid structured JSON|unexpected review shape/i);
  assert.match(result.stdout, /Raw final message:/);
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
  const deniedResult = companion(["review", "--wait"], denied);
  assert.match(deniedResult.stdout, /blocked/);

  const allowed = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Execute `git diff auth.js`", rawInput: { command: "git diff auth.js" } },
        text: REVIEW_JSON,
        onDenied: { text: '{"verdict":"approve","summary":"blocked","findings":[],"next_steps":[]}' }
      }
    ]
  });
  const allowedResult = companion(["review", "--wait"], allowed);
  assert.match(allowedResult.stdout, /Verdict: needs-attention/);
});

test("adversarial review uses its own prompt template", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["adversarial-review", "--wait", "focus on retries"], { repo, env });

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

  companion(["review", "--wait", "focus on the retry logic"], { repo, env });

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /focus on the retry logic/);
  assert.match(prompt, /read-only review/i);
});

test("review writes findings in the language requested via --language", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  companion(["review", "--wait", "--language", "ja", "リトライ処理を重点的に"], { repo, env });

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /BCP 47 tag "ja"/);
  assert.match(prompt, /リトライ処理を重点的に/);
});

test("review falls back to the focus language, then English, when --language is absent", () => {
  const withFocus = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  companion(["review", "--wait", "focus on retries"], withFocus);
  assert.match(withFocus.fake.readState().prompts[0], /same language as the user focus/);

  const bare = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  companion(["review", "--wait"], bare);
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
  assert.match(prompt, /## Tracked Files/);
  // setupWorkspace は auth.js を書き換えて working tree を汚しているが、
  // 監査プロンプトにその差分が混入しないこと。
  assert.doesNotMatch(prompt, /Unstaged Diff/);
  assert.doesNotMatch(prompt, /export const a = 2;/);
});

test("audit can detach through the companion without a host-specific background API", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const launched = companion(["audit", "--background", "--json", "focus on auth"], { repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const queued = JSON.parse(launched.stdout);
  assert.equal(queued.status, "queued");
  assert.match(queued.jobId, /^review-/);

  const waited = companion(
    ["status", queued.jobId, "--wait", "--timeout-ms", "10000", "--json"],
    { repo, env }
  );
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed");
  assert.equal(snapshot.job.kind, "audit");

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /full-repository audit/i);
  assert.match(prompt, /focus on auth/);
});

test("status tracks a finished review as completed, not failed", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  companion(["review", "--wait"], { repo, env });
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

  companion(["review", "--wait"], { repo, env });
  const payload = JSON.parse(companion(["status", "--json", "--all"], { repo, env }).stdout);

  assert.equal(payload.latestFinished.status, "failed");
});

test("result replays the stored rendering of a finished job", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  companion(["review", "--wait"], { repo, env });
  const result = companion(["result"], { repo, env });

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

test("task asks for grok-4.6 when the model is omitted", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.6"]);
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

test("resuming a task reloads the previous session and reapplies --effort", () => {
  // 偽 grok はコマンドごとに新しいプロセスとして起動するので、応答は
  // 1 種類にしておき、検証は記録された RPC 側で行う。
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "carrying on" }],
    configOptions: [THOUGHT_LEVEL_OPTION]
  });

  const first = companion(["task", "start the work"], { repo, env });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(fake.readState().loads, []);

  const resumed = companion(["task", "--resume-last", "--effort", "medium", "keep going"], { repo, env });
  assert.equal(resumed.status, 0, `stdout:
${resumed.stdout}
stderr:
${resumed.stderr}`);
  assert.match(resumed.stdout, /carrying on/);

  const state = fake.readState();
  // 新しいセッションを作らず、前回のセッションを読み直している。
  assert.equal(state.sessions, 0);
  assert.deepEqual(state.loads, ["fake-session-1"]);
  assert.deepEqual(state.prompts, ["keep going"]);
  // 再開でも --effort が当たる（以前は startSession を通らず無視されていた）。
  assert.deepEqual(state.configs, [{ configId: "thought-level", value: "medium" }]);
});
