import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
function read(relativePath) {
    return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}
test("conversation language precedes focus in both host entrypoints", () => {
    for (const name of ["review", "adversarial-review", "audit"]) {
        const claude = read(`commands/${name}.md`);
        assert.match(claude, /prepend `--language <BCP 47 tag>`/);
        assert.match(claude, /before.*focus/i);
        assert.doesNotMatch(claude, /append `--language/);
        assert.match(read(`codex-skills/source-command-${name}/SKILL.md`), /before the focus text/);
        assert.match(claude, /In Bash[\s\S]*In PowerShell/);
        assert.match(claude, /do not use `eval`/);
        assert.doesNotMatch(claude, /grok-companion\.mjs[^\r\n]*"\$ARGUMENTS"/);
        assert.match(claude, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/grok-companion\.mjs/);
        assert.match(claude, /first standalone `--`[\s\S]*option value remains a value/);
        assert.match(claude, /Known value flags[\s\S]*aliases `-m`[\s\S]*`-C`/);
    }
});
function listCommands() {
    return fs
        .readdirSync(path.join(PLUGIN_ROOT, "commands"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.replace(/\.md$/, ""))
        .sort();
}
function listSkills(relativePath) {
    return fs
        .readdirSync(path.join(PLUGIN_ROOT, relativePath), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => fs.existsSync(path.join(PLUGIN_ROOT, relativePath, entry.name, "SKILL.md")))
        .map((entry) => entry.name)
        .sort();
}
const PUBLIC_WORKFLOWS = [
    "adversarial-review",
    "audit",
    "imagine",
    "rescue",
    "review",
    "setup",
    "x"
];
test("the plugin exposes exactly the supported commands", () => {
    assert.deepEqual(listCommands(), PUBLIC_WORKFLOWS);
});
test("both hosts permit Bun and Node on Windows macOS and Linux", () => {
    for (const name of PUBLIC_WORKFLOWS) {
        const command = read(`commands/${name}.md`);
        assert.match(command, /Bash\(bun:\*\)/);
        assert.match(command, /Bash\(node:\*\)/);
        assert.match(command, /Bun 1\.4\.4 or later/i);
        assert.match(command, /`bun --no-env-file`/i);
        assert.match(command, /Windows, macOS, and Linux/i);
        assert.match(command, /Node\.js 22 or later/i);
        assert.match(read(`codex-skills/source-command-${name}/SKILL.md`), /shared runtime contract/i);
    }
    for (const name of ["references/codex-runtime.md", "claude-skills/grok-cli-runtime/SKILL.md", "claude-skills/grok-imagine-runtime/SKILL.md", "codex-skills/grok-imagine-runtime/SKILL.md"]) {
        const runtime = read(name);
        assert.match(runtime, /Windows.*`bun --no-env-file` instead of `node`/i);
        assert.match(runtime, /Windows, macOS, and Linux.*Bun 1\.4\.4 or later.*Node\.js 22 or later/i);
    }
});
test("Codex exposes the same workflows as native skills", () => {
    const nativeSkillNames = PUBLIC_WORKFLOWS.map((name) => `source-command-${name}`);
    assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "skills")), false);
    // grok-imagine-runtime is the only model-invoked Codex skill (see the imagine helper test).
    assert.deepEqual(listSkills("codex-skills"), ["grok-imagine-runtime", ...nativeSkillNames]);
    const runtime = read("references/codex-runtime.md");
    assert.match(runtime, /once in the foreground with a new direct ACP connection/i);
    assert.match(runtime, /Do not detach or poll a separate job/i);
    assert.match(runtime, /Reject --background/i);
    assert.match(runtime, /reviews return reviewText and tasks return finalMessage/i);
    assert.match(runtime, /does not resume tasks or retrieve stored jobs/i);
    for (const name of nativeSkillNames) {
        const source = read(`codex-skills/${name}/SKILL.md`);
        assert.match(source, /^---\r?\n/, `${name} is missing skill frontmatter`);
        assert.match(source, new RegExp(`^name: ${name}$`, "m"), `${name} has the wrong skill name`);
        assert.match(source, /^description: .+$/m, `${name} is missing a skill description`);
        // Claude Code scans a plugin's default skills/ directory in addition to the manifest
        // path, and ignores disable-model-invocation on plugin skills
        // (anthropics/claude-code#22345). These files stay out of that scan. Codex still
        // honors the flag, so automatic invocation stays off there while user selection works.
        assert.match(source, /^disable-model-invocation: true$/m, `${name} must stay user-invoked in Codex`);
        assert.match(source, /references\/codex-runtime\.md/, `${name} does not load the shared runtime contract`);
        if (name === "source-command-x")
            assert.match(source, /one foreground task --json without --write/i);
        else
            assert.match(source, /grok-companion\.mjs/, `${name} does not call the companion script`);
        assert.doesNotMatch(source, /AskUserQuestion|run_in_background|CLAUDE_PLUGIN_ROOT|source-command-(?:status|result)/);
    }
    const audit = read("codex-skills/source-command-audit/SKILL.md");
    assert.match(audit, /subcommand.*`audit`|`audit`\s*subcommand/i);
    assert.match(audit, /review-only/i);
});
test("Claude-only helpers stay outside Codex skill discovery", () => {
    const helperNames = ["grok-cli-runtime", "grok-imagine-runtime", "grok-prompting"];
    const claudeManifest = JSON.parse(read(".claude-plugin/plugin.json"));
    assert.equal(claudeManifest.skills, "./claude-skills/");
    assert.deepEqual(listSkills("claude-skills"), helperNames);
    // Codex has its own grok-imagine-runtime with Codex-specific instructions; the other helpers stay Claude-only.
    assert.ok(["grok-cli-runtime", "grok-prompting"].every((name) => !listSkills("codex-skills").includes(name)));
    for (const name of helperNames) {
        const source = read(`claude-skills/${name}/SKILL.md`);
        assert.match(source, new RegExp(`^name: ${name}$`, "m"), `${name} has the wrong skill name`);
        assert.match(source, /^description: .+$/m, `${name} is missing a description`);
        assert.match(source, /^user-invocable: false$/m, `${name} is not marked as an internal helper`);
    }
    const rescueAgent = read("agents/grok-rescue.md");
    for (const name of ["grok-cli-runtime", "grok-prompting"]) {
        assert.match(rescueAgent, new RegExp(`^\\s+- ${name}$`, "m"), `${name} is not wired to the Claude rescue agent`);
    }
    assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "claude-skills/grok-result-handling")), false);
    for (const reference of ["prompt-blocks.md", "grok-prompt-recipes.md", "grok-prompt-antipatterns.md"]) {
        assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "claude-skills", "grok-prompting", "references", reference)), `${reference} did not move with the Claude prompting helper`);
    }
});
test("Claude workflows return the foreground output rather than retrieving a job", () => {
    for (const name of ["review", "adversarial-review", "audit", "rescue", "x", "imagine"]) {
        const source = read(`commands/${name}.md`);
        assert.match(source, /return completed stdout faithfully/i, `${name} must return its own output`);
        assert.doesNotMatch(source, /grok-companion\.mjs" (?:status|result|cancel)/i);
    }
});
test("every command declares frontmatter and routes through a foreground workflow", () => {
    for (const name of listCommands()) {
        const source = read(`commands/${name}.md`);
        // 改行は環境によって CRLF になるので、行末の \r を許容して照合する。
        assert.match(source, /^---\r?\n/, `${name} is missing frontmatter`);
        assert.match(source, /^description: .+$/m, `${name} is missing a description`);
        if (name === "x")
            assert.match(source, /one foreground task without --write/i);
        else
            assert.match(source, /grok-companion\.mjs/, `${name} does not call the companion script`);
    }
});
// review / adversarial-review / audit の入口は同じ配線契約を持つ。前景実行の文言だけが
// review と audit で異なり、audit だけは差分を無視することを明言する。
for (const [name, workflow] of [["review", "review"], ["adversarial-review", "review"], ["audit", "audit"]]) {
    test(`${name} entrypoint wires to its own companion subcommand in the foreground`, () => {
        const source = read(`commands/${name}.md`);
        // name は英小文字とハイフンだけなので RegExp へそのまま埋め込める。
        assert.match(source, new RegExp(`grok-companion\\.mjs> ${name} <safely-quoted-known-flag-argv> -- <safely-quoted-focus1argv>`));
        assert.match(source, new RegExp(`Always run the ${workflow} in the foreground`, "i"));
        assert.match(source, /`--background`[\s\S]*runs only in the foreground/i);
        assert.doesNotMatch(source, /run_in_background:\s*true/);
        assert.doesNotMatch(source, /AskUserQuestion/);
        // 監査は差分レビューではないことを利用者向けに明言していること。
        if (name === "audit")
            assert.match(source, /ignores the current git diff/i);
    });
}
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
        assert.match(source, /argument-hint:.*--language/, `${name} does not advertise --language`);
    }
    // テンプレート側: 言語ルールの差し込み口があること。
    for (const name of ["review", "adversarial-review", "audit"]) {
        const template = read(`prompts/${name}.md`);
        assert.match(template, /\{\{RESPONSE_LANGUAGE_RULE\}\}/, `prompts/${name}.md is missing the language rule slot`);
    }
    // rescue 経路: 依頼文を英訳せず元の言語のまま転送する指示があること。
    assert.match(read("agents/grok-rescue.md"), /preserving its language/i);
    assert.match(read("codex-skills/source-command-rescue/SKILL.md"), /preserve the task language/i);
});
test("imagine copies images only and requires an explicit API billing opt-in", () => {
    const claude = read("commands/imagine.md");
    const codex = read("codex-skills/source-command-imagine/SKILL.md");
    assert.match(claude, /grok-companion\.mjs" imagine once in the foreground/);
    assert.match(claude, /do not pass `--write`/i);
    assert.match(claude, /do not add `--allow-api-billing`/i);
    assert.match(claude, /grok-imagine\//);
    assert.match(codex, /grok-companion\.mjs imagine --json/);
    assert.match(codex, /do not pass --write/i);
    assert.match(codex, /do not add `--allow-api-billing`/i);
    assert.match(codex, /image-entitlement-missing/);
    assert.match(codex, /usage-balance-exhausted/);
    // The image model options are forwarded only when the user names a model, and the generation ID is never reused for edits.
    assert.match(claude, /argument-hint:.*--image-model <id>.*--image-edit-model <id>/);
    assert.match(claude, /only when the user names an image model[\s\S]*never reuse the generation ID for edits/i);
    assert.match(codex, /--image-model, and --image-edit-model[\s\S]*never invent an image model ID/i);
    for (const name of ["claude-skills", "codex-skills"]) {
        assert.match(read(`${name}/grok-imagine-runtime/SKILL.md`), /`--image-model <id>`[\s\S]*`--image-edit-model <id>`[\s\S]*only when the user or the workflow specifies an image model[\s\S]*requestedImageModel/);
    }
});
test("the Claude imagine helper keeps the command contract for model-driven callers", () => {
    const helper = read("claude-skills/grok-imagine-runtime/SKILL.md");
    assert.match(helper, /grok-companion\.mjs" imagine once in the foreground/i);
    assert.match(helper, /at least 600000 ms/i);
    assert.match(helper, /options before the description, then `--`/i);
    assert.match(helper, /multiline text.*--prompt-file/i);
    assert.match(helper, /prefer `--json`.*`images\[\]\.saved`/i);
    assert.match(helper, /do not pass `--write`/i);
    assert.match(helper, /do not add `--allow-api-billing` unless the user explicitly accepted/i);
    for (const classification of ["usage-balance-exhausted", "image-entitlement-missing", "api-billing-required"]) {
        assert.match(helper, new RegExp(classification));
    }
    assert.match(helper, /do not claim an image was saved/i);
    assert.match(helper, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});
test("the Codex imagine helper is model-invoked and keeps the command contract", () => {
    const codexManifest = JSON.parse(read(".codex-plugin/plugin.json"));
    const helper = read("codex-skills/grok-imagine-runtime/SKILL.md");
    assert.equal(codexManifest.skills, "./codex-skills/");
    assert.match(helper, /^---\r?\n/);
    assert.match(helper, /^name: grok-imagine-runtime$/m);
    assert.match(helper, /^description: .+$/m);
    // Unlike source-command-*, Codex must be able to call this from another workflow.
    assert.doesNotMatch(helper, /disable-model-invocation|user-invocable/);
    assert.match(helper, /\(\.\.\/\.\.\/references\/codex-runtime\.md\)/);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "references", "codex-runtime.md")));
    assert.match(helper, /grok-companion\.mjs imagine --json once in the foreground/i);
    assert.match(helper, /at least 600 seconds/i);
    assert.match(helper, /options before the description, then `--`/i);
    assert.match(helper, /multiline text.*--prompt-file/i);
    assert.match(helper, /`images\[\]\.saved`/);
    assert.match(helper, /do not pass `--write`/i);
    assert.match(helper, /do not add `--allow-api-billing` unless the user explicitly accepted/i);
    for (const classification of ["usage-balance-exhausted", "image-entitlement-missing", "api-billing-required"]) {
        assert.match(helper, new RegExp(classification));
    }
    assert.match(helper, /do not claim an image was saved/i);
    assert.doesNotMatch(helper, /AskUserQuestion|run_in_background|CLAUDE_PLUGIN_ROOT/);
});
test("Claude task entries return stderr diagnostics such as the unapplied effort notice", () => {
    for (const file of ["commands/rescue.md", "agents/grok-rescue.md", "claude-skills/grok-cli-runtime/SKILL.md"]) {
        assert.match(read(file), /diagnostic lines from stderr/i, `${file} must return stderr diagnostics`);
    }
    // Codex は常に --json で呼ぶため stderr の通知は対象外。
    assert.match(read("codex-skills/source-command-rescue/SKILL.md"), /grok-companion\.mjs task --json/);
});
test("rescue forwards one concrete task and grants write access only on request", () => {
    const rescue = read("commands/rescue.md");
    assert.match(rescue, /require a concrete task/i);
    assert.match(rescue, /grok-companion\.mjs" task once in the foreground/i);
    assert.match(rescue, /use --write for requested edits; omit it for read-only work/i);
    // Codex 実行契約と同じく、複数行の依頼は --prompt-file で渡す（AGENTS.md）。
    for (const entry of [rescue, read("claude-skills/grok-cli-runtime/SKILL.md"), read("commands/x.md")]) {
        assert.match(entry, /options before the task, then `--`/i);
        assert.match(entry, /multiline text.*--prompt-file/i);
    }
});
test("setup entries run the helper and follow its guidance without installing automatically", () => {
    const claude = read("commands/setup.md");
    const codex = read("codex-skills/source-command-setup/SKILL.md");
    assert.match(claude, /node .*scripts\/grok-companion\.mjs" setup/);
    assert.match(claude, /follow the helper.s install and login guidance/i);
    assert.match(claude, /do not install or authenticate automatically/i);
    assert.match(codex, /node <plugin-root>\/scripts\/grok-companion\.mjs setup --json/);
    assert.match(codex, /install guidance from the helper/i);
    assert.match(codex, /preserve its login guidance/i);
    assert.match(codex, /do not install or authenticate automatically/i);
});
test("automatic lifecycle and review-gate hooks are absent", () => {
    const hooks = JSON.parse(read("hooks/hooks.json"));
    assert.deepEqual(hooks.hooks, {});
});
test("plugin and marketplace manifests agree on name and version", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
    const codexPlugin = JSON.parse(read(".codex-plugin/plugin.json"));
    const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(plugin.name, "grok");
    assert.equal(codexPlugin.name, plugin.name);
    assert.equal(codexPlugin.version, plugin.version);
    assert.equal(codexPlugin.skills, "./codex-skills/");
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
    assert.match(readme, /Claude Code or Codex/);
    assert.match(readme, /codex plugin add grok@kagayoi-grok/);
    assert.match(readme, /grok:source-command-<name>/);
});
