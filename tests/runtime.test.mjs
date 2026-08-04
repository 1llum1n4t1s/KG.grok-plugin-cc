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
    availableModels: ["grok-fake-nonreasoning", "grok-4.5"],
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

  // API キー認証時の既定は非推論モデルなので、明示的に差し替えていること。
  const state = fake.readState();
  assert.deepEqual(state.models, ["grok-4.5"]);
});

test("review joins streamed thought chunks into readable sentences", () => {
  const { repo, env } = setupWorkspace({
    replies: [{ text: REVIEW_JSON, thoughts: ["Check", "ing ", "the ", "diff ", "care", "fully."] }]
  });

  const result = companion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Checking the diff carefully\./);
  // 断片が 1 行ずつに分解されていないこと。
  assert.doesNotMatch(result.stdout, /^- Check$/m);
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
