import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../plugins/grok/scripts/lib/args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function listCommands() {
  return fs
    .readdirSync(path.join(PLUGIN_ROOT, "commands"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

const PUBLIC_WORKFLOWS = [
  "adversarial-review",
  "audit",
  "cancel",
  "rescue",
  "result",
  "review",
  "setup",
  "status",
  "x"
];

test("the plugin exposes exactly the supported commands", () => {
  assert.deepEqual(listCommands(), PUBLIC_WORKFLOWS);
});

test("Codex exposes the same workflows as native skills", () => {
  const nativeSkillNames = PUBLIC_WORKFLOWS.map((name) => `source-command-${name}`);

  for (const name of nativeSkillNames) {
    const source = read(`skills/${name}/SKILL.md`);
    assert.match(source, /^---\r?\n/, `${name} is missing skill frontmatter`);
    assert.match(source, new RegExp(`^name: ${name}$`, "m"), `${name} has the wrong skill name`);
    assert.match(source, /^description: .+$/m, `${name} is missing a skill description`);
    assert.match(source, /references\/codex-runtime\.md/, `${name} does not load the shared runtime contract`);
    assert.match(source, /grok-companion\.mjs/, `${name} does not call the companion script`);
    assert.doesNotMatch(source, /AskUserQuestion|run_in_background|CLAUDE_PLUGIN_ROOT/);
  }

  const audit = read("skills/source-command-audit/SKILL.md");
  assert.match(audit, /subcommand.*`audit`|`audit`\s*subcommand/i);
  assert.match(audit, /--background/);
  assert.match(audit, /review-only/i);
});

test("Codex runs every Grok workflow in the foreground", () => {
  const runtime = read("references/codex-runtime.md");
  assert.match(runtime, /Foreground execution/i);
  assert.match(runtime, /Always invoke the companion in the foreground/i);
  assert.match(runtime, /Reject `--background`/i);
  assert.match(runtime, /\[grok\] Job ID: <job-id>/i);
  assert.match(runtime, /Never infer it from status ordering/i);
  assert.match(runtime, /result <job-id>/i);
  assert.match(runtime, /source-command-status --wait[\s\S]*synchronous status-polling/i);

  for (const name of ["review", "adversarial-review", "audit", "rescue", "x"]) {
    const source = read(`skills/source-command-${name}/SKILL.md`);
    assert.match(source, /shared foreground execution contract/i, `${name} ignores the foreground contract`);
    assert.match(source, /Reject `--background`/i, `${name} does not reject background execution`);
  }
});

test("cancel without a job id never guesses when multiple jobs are active", () => {
  for (const relativePath of ["commands/cancel.md", "skills/source-command-cancel/SKILL.md"]) {
    const source = read(relativePath);
    assert.match(source, /only active job[\s\S]*current session/i, `${relativePath} does not document the safe default`);
    assert.match(source, /multiple[\s\S]*job id/i, `${relativePath} does not require disambiguation`);
    assert.doesNotMatch(source, /most recent active|latest active/i, `${relativePath} still promises arbitrary latest-job selection`);
  }
});

test("Claude workflows retrieve the exact job they launched", () => {
  for (const name of ["review", "adversarial-review", "audit", "x"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /result "<job-id>"/i, `${name} does not pass the captured job id`);
    assert.doesNotMatch(source, /grok-companion\.mjs" result\s*\n```/, `${name} still documents bare result`);
    assert.match(source, /exact job id|exact id/i, `${name} does not explain job identity`);
  }
});

test("transfer is gone because Grok has no Claude session import", () => {
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "commands", "transfer.md")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "scripts", "lib", "claude-session-transfer.mjs")), false);

  const companion = read("scripts/grok-companion.mjs");
  assert.doesNotMatch(companion, /handleTransfer|importExternalAgentSession/);
});

test("every command declares frontmatter and routes through the companion script", () => {
  for (const name of listCommands()) {
    const source = read(`commands/${name}.md`);
    // 改行は環境によって CRLF になるので、行末の \r を許容して照合する。
    assert.match(source, /^---\r?\n/, `${name} is missing frontmatter`);
    assert.match(source, /^description: .+$/m, `${name} is missing a description`);
    assert.match(source, /grok-companion\.mjs/, `${name} does not call the companion script`);
    assert.doesNotMatch(source, /codex/i, `${name} still mentions Codex`);
  }
});

test("review and adversarial-review wire to their own companion subcommands", () => {
  const review = read("commands/review.md");
  assert.match(review, /grok-companion\.mjs" review "\$ARGUMENTS"/);
  assert.match(review, /Always run the review in the foreground/i);
  assert.match(review, /`--background`[\s\S]*no longer supported/i);
  assert.doesNotMatch(review, /run_in_background:\s*true/);
  assert.doesNotMatch(review, /AskUserQuestion/);

  const adversarial = read("commands/adversarial-review.md");
  assert.match(adversarial, /grok-companion\.mjs" adversarial-review "\$ARGUMENTS"/);
  assert.match(adversarial, /Always run the review in the foreground/i);
  assert.match(adversarial, /`--background`[\s\S]*no longer supported/i);
  assert.doesNotMatch(adversarial, /run_in_background:\s*true/);
  assert.doesNotMatch(adversarial, /AskUserQuestion/);
});

test("audit wires to its own subcommand, template, and repo scope", () => {
  const audit = read("commands/audit.md");
  assert.match(audit, /grok-companion\.mjs" audit "\$ARGUMENTS"/);
  assert.match(audit, /Always run the audit in the foreground/i);
  assert.match(audit, /`--background`[\s\S]*no longer supported/i);
  assert.doesNotMatch(audit, /run_in_background:\s*true/);
  assert.doesNotMatch(audit, /AskUserQuestion/);
  // 監査は差分レビューではないことを利用者向けに明言していること。
  assert.match(audit, /ignores the current git diff/i);

  const companion = read("scripts/grok-companion.mjs");
  assert.match(companion, /case "audit":/);
  assert.match(companion, /scope: "repo"/);
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "prompts", "audit.md")), "prompts/audit.md is missing");
});

test("the companion has no detached execution entry points", () => {
  const companion = read("scripts/grok-companion.mjs");
  assert.doesNotMatch(companion, /spawnDetachedWorker|enqueueBackgroundJob/);
  assert.doesNotMatch(companion, /case "(?:task|review)-worker"/);
  assert.match(companion, /`--background` is no longer supported/);
});

test("review commands stay review-only", () => {
  for (const name of ["review", "adversarial-review", "audit"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /review-only/i, `${name} does not declare itself review-only`);
    assert.match(source, /[Dd]o not fix/, `${name} does not forbid fixing issues`);
  }
});

test("review accepts focus text now that there is no built-in reviewer", () => {
  const review = read("commands/review.md");
  assert.match(review, /argument-hint:.*\[focus \.\.\.\]/);
  assert.match(review, /passed through as review focus/i);
  // 本家 Codex 版にあった「focus text は使えない」制約が消えていること。
  assert.doesNotMatch(review, /does not support .*extra focus text/i);
});

test("responses follow the sender's language dynamically", () => {
  // slash コマンド側: Claude が会話言語を --language で渡す指示があること。
  for (const name of ["review", "adversarial-review", "audit"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /--language <BCP 47 tag>/, `${name} does not forward the conversation language`);
    assert.match(source, /argument-hint:.*--language/, `${name} does not advertise --language`);
  }

  // テンプレート側: 言語ルールの差し込み口があること。
  for (const name of ["review", "adversarial-review", "audit"]) {
    const template = read(`prompts/${name}.md`);
    assert.match(template, /\{\{RESPONSE_LANGUAGE_RULE\}\}/, `prompts/${name}.md is missing the language rule slot`);
  }

  // rescue 経路: 依頼文を英訳せず元の言語のまま転送する指示があること。
  assert.match(read("agents/grok-rescue.md"), /original language/i);
  assert.match(read("skills/grok-cli-runtime/SKILL.md"), /original language/i);
});

test("rescue delegates to the subagent without recursing into itself", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /subagent_type: "grok:grok-rescue"/);
  assert.match(rescue, /do not call `Skill\(grok:grok-rescue\)`/i);
});

test("model guidance only names aliases the companion actually resolves", () => {
  const companion = read("scripts/grok-companion.mjs");
  for (const alias of ["fast", "reasoning", "multi", "build", "latest"]) {
    assert.match(companion, new RegExp(`\\["${alias}",`), `companion is missing the ${alias} alias`);
  }

  for (const file of ["commands/rescue.md", "agents/grok-rescue.md", "skills/grok-cli-runtime/SKILL.md"]) {
    const source = read(file);
    assert.doesNotMatch(source, /spark/i, `${file} still references the removed spark alias`);
    assert.doesNotMatch(source, /gpt-5/i, `${file} still references a GPT-5 model`);
  }
});

test("setup points at the x.ai installer rather than a package registry", () => {
  const setup = read("commands/setup.md");
  assert.match(setup, /x\.ai\/cli\/install\.ps1/);
  assert.match(setup, /x\.ai\/cli\/install\.sh/);
  assert.match(setup, /XAI_API_KEY/);
  assert.doesNotMatch(setup, /npm install/);
});

test("hooks keep session lifecycle cleanup and stop gating wired", () => {
  const hooks = JSON.parse(read("hooks/hooks.json"));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionEnd", "SessionStart", "Stop"]);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-lifecycle-hook\.mjs" SessionStart/);
  assert.match(hooks.hooks.SessionEnd[0].hooks[0].command, /session-lifecycle-hook\.mjs" SessionEnd/);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /stop-review-gate-hook\.mjs/);
});

test("plugin and marketplace manifests agree on name and version", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const codexPlugin = JSON.parse(read(".codex-plugin/plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  assert.equal(plugin.name, "grok");
  assert.equal(codexPlugin.name, plugin.name);
  assert.equal(codexPlugin.version, plugin.version);
  assert.equal(codexPlugin.skills, "./skills/");
  assert.equal(marketplace.plugins[0].name, "grok");
  assert.equal(marketplace.plugins[0].source, "./plugins/grok");
  assert.equal(marketplace.plugins[0].version, plugin.version);
  assert.equal(marketplace.metadata.version, plugin.version);
  assert.equal(pkg.version, plugin.version);
});

// コミュニティマーケットプレイスに出す以上、掲載カードに出る情報は
// 欠けたままリリースしたくない。bump-version は version しか触らないので、
// 他のフィールドが落ちても気づけるようにここで固定する。
test("all manifests carry the metadata a marketplace listing needs", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const codexPlugin = JSON.parse(read(".codex-plugin/plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = marketplace.plugins[0];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  for (const manifest of [plugin, codexPlugin, entry]) {
    assert.equal(manifest.license, "Apache-2.0");
    assert.match(manifest.homepage, /^https:\/\/github\.com\//);
    assert.match(manifest.repository, /^https:\/\/github\.com\//);
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
    assert.ok(manifest.description);
  }

  // 宣言したライセンスが実際のライセンスと食い違わないこと。
  assert.equal(pkg.license, plugin.license);
  assert.ok(fs.existsSync(path.join(ROOT, "LICENSE")));

  // owner はマーケットプレイスの必須フィールド。
  assert.ok(marketplace.owner?.name);

  // 表示名は Anthropic のプラグインディレクトリへ申請した名前と一致させる。
  // 技術名 `grok` は xAI のブランドそのものなので、掲載カードでは
  // 第三者クライアントと分かる名前を出す。
  assert.equal(entry.displayName, "Grok Build Companion");
  assert.equal(codexPlugin.interface.displayName, entry.displayName);
  assert.equal(codexPlugin.interface.developerName, "Kagayoi");
  assert.ok(codexPlugin.interface.defaultPrompt.length <= 3);
});

test("the marketplace name does not collide with the reserved Anthropic names", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));

  // https://code.claude.com/docs/en/plugin-marketplaces の予約名一覧。
  const reserved = new Set([
    "claude-code-marketplace",
    "claude-code-plugins",
    "claude-plugins-official",
    "claude-plugins-community",
    "claude-community",
    "anthropic-marketplace",
    "anthropic-plugins",
    "agent-skills",
    "anthropic-agent-skills",
    "knowledge-work-plugins",
    "life-sciences",
    "claude-for-legal",
    "claude-for-financial-services",
    "financial-services-plugins",
    "first-party-plugins",
    "healthcare"
  ]);

  assert.equal(reserved.has(marketplace.name), false);
  // 公式を騙る形の名前もブロックされる。
  assert.doesNotMatch(marketplace.name, /^(official|anthropic)-/);
  assert.match(marketplace.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "marketplace name must be kebab-case");
  assert.match(marketplace.plugins[0].name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "plugin name must be kebab-case");
});

test("the NOTICE records the upstream attribution and the modifications", () => {
  const notice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
  assert.match(notice, /Copyright 2026 OpenAI/);
  assert.match(notice, /openai\/codex-plugin-cc/);
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /Summary of modifications/);
  // プラグイン側にも同じ NOTICE が同梱されていること。
  assert.equal(notice, read("NOTICE"));
});

test("the README documents every exposed command", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const name of listCommands()) {
    assert.match(readme, new RegExp(`/grok:${name}`), `README does not document /grok:${name}`);
  }
  // 上流のクレジットは残す必要があるので Codex への言及自体は禁じない。
  // 禁じるのは、この plugin では動かない `/codex:` コマンドの案内。
  assert.doesNotMatch(readme, /\/codex:/);
  assert.match(readme, /openai\/codex-plugin-cc/, "README should credit the upstream project");
  assert.match(readme, /Claude Code and Codex/);
  assert.match(readme, /codex plugin add grok@kagayoi-grok/);
  assert.match(readme, /\/skills/);
});

test("自由記述より後ろのダッシュ付きトークンはフラグとして解釈しない", () => {
  const { options, positionals } = parseArgs(
    ["--wait", "explain the", "--write", "flag"],
    { booleanOptions: ["wait", "write"], stopAtFirstPositional: true }
  );

  assert.equal(options.wait, true);
  assert.equal(options.write, undefined);
  assert.deepEqual(positionals, ["explain the", "--write", "flag"]);
});

test("stopAtFirstPositional を付けなければ従来どおり後ろのフラグも拾う", () => {
  const { options } = parseArgs(["job-1", "--wait"], { booleanOptions: ["wait"] });

  assert.equal(options.wait, true);
});
