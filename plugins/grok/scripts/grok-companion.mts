#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { getGrokAuthStatus, parseStructuredOutput, readOutputSchema, runGrokReview, runGrokTurn } from "./lib/grok.mjs";
import { normalizeLanguageTag } from "./lib/language.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { renderReviewResult, validateReviewResultShape } from "./lib/render.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const aliases = { fast: "grok-4.20-0309-non-reasoning", reasoning: "grok-4.20-0309-reasoning", multi: "grok-4.20-multi-agent-0309", build: "grok-build-0.1", latest: "grok-4.7" };
const usage = `Usage: grok-companion.mjs <setup|review|adversarial-review|audit|task> [options] [prompt]
Review: --base <ref> --scope <auto|working-tree|branch> --language <tag> --model <model> --cwd <path> --json
Review scopes auto and working-tree require Windows and fail if a complete safe snapshot cannot be collected.
On macOS/Linux, use --scope branch or --base <ref> for committed changes; uncommitted changes are excluded from the comparison diff, but surrounding files may still be read from the working tree. Use audit for the whole repository.
Task: --model <model> --effort <low|medium|high> --cwd <path> --prompt-file <path> --write --json
Each command runs a new foreground Grok session. For resuming, use Grok's own resume command.`;
// 短いオプションの別名。parseArgs の aliasMap と、互換分割で既知とみなす `-C` / `-m` の
// 両方をこの 1 つの定義から導出し、片方だけ更新される食い違いを防ぐ。
const shortAliases = { C: "cwd", m: "model" };
function parse<V extends string, B extends string>(argv: string[], values: V[], booleans: B[]) {
  // 旧ホストは `--language ja --wait "focus"` のような生の引数列を 1 引数で渡すため、
  // 先頭語がこのコマンドの既知オプションである単一引数だけ互換分割する。
  // 通常の依頼文・focus（`- [ ] 箇条書き` など `-` で始まる文も含む）を 1 引数で受けた場合は
  // 第二のシェル解析をせず、引用符・連続空白・改行を原文のまま保持する（codex-runtime 契約）。
  const known = new Set<string>([...values, ...booleans].map(name => `--${name}`).concat(Object.keys(shortAliases).map(name => `-${name}`)));
  const firstWord = argv.length === 1 ? (argv[0].trimStart().split(/\s/, 1)[0] ?? "").replace(/=.*$/s, "") : "";
  const args = argv.length === 1 && known.has(firstWord) ? splitRawArgumentString(argv[0]) : argv;
  return parseArgs(args, { valueOptions: values, booleanOptions: booleans, aliasMap: shortAliases, stopAtFirstPositional: true });
}
function disabled(name) { throw new Error(`${name} is no longer supported. Use Grok's own commands to resume or manage sessions.`); }
function model(value) { return aliases[value] ?? value; }
function setupGuidance(status) {
  if (status.reason === "grok-missing") {
    if (status.availability?.reason === "missing-agent-stdio") return "Update Grok Build with `grok update`, then run setup again.";
    if (status.availability?.reason === "not-installed") {
      const install = process.platform === "win32" ? "irm https://x.ai/cli/install.ps1 | iex" : "curl -fsSL https://x.ai/cli/install.sh | bash";
      return `Install Grok Build with \`${install}\`, then run setup again.`;
    }
  }
  if (status.reason === "not-authenticated") return "Authenticate with `grok login` (or `grok login --device-auth`), or configure XAI_API_KEY, then run setup again.";
  return null;
}
function errorDiagnostic(error) {
  if (!error) return null;
  const data = error.data?.data ?? null;
  const usageExhausted = data?.http_status === 402 && typeof data.message === "string" && /usage balance exhausted/i.test(data.message);
  return { message: error.message, rpcCode: error.rpcCode ?? null, data,
    ...(usageExhausted ? { classification: "usage-balance-exhausted", guidance: "Grokの利用枠が不足しています（HTTP 402）。利用枠の回復後に再実行してください。" } : {}) };
}
// review / task 共通のターン未完了判定。
// permissionDenials は意図的に `?.` を付けない（未定義なら例外になる従来の挙動を保つ）。
// review 側は parseError を先に短絡評価するため、この関数を呼ぶ位置も変えないこと。
function turnIncomplete(result) {
  return result.status !== "completed" || result.stopReason !== "end_turn" || result.turnStopUnconfirmed || result.permissionDenials.length;
}
// 非 JSON 出力時の stderr 診断。順序（RPC コード、利用枠案内、停止未確認）は表示契約なので保つ。
// stdout の本文を出した後に呼ぶ。main().catch 側の停止未確認表示は別経路なのでここへ統合しない。
function reportTurnDiagnostics(diagnostic, result) {
  if (diagnostic?.rpcCode != null) console.error(`Grok session/prompt RPC error code: ${diagnostic.rpcCode}`);
  if (diagnostic?.guidance) console.error(diagnostic.guidance);
  if (result.turnStopUnconfirmed) console.error("Grok agent stop could not be confirmed.");
}
function languageRule(language, focus) {
  const fields = "every human-readable field (summary, finding titles and bodies, recommendations, next steps)";
  if (language) {
    return `Write ${fields} in the language identified by the BCP 47 tag "${normalizeLanguageTag(language)}".`;
  }
  return focus ? `Write ${fields} in the same language as the user focus above.` : `Write ${fields} in English.`;
}
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) { console.log(usage); return; }
  if (["status", "result", "cancel", "state-lock", "task-resume-candidate"].includes(command)) disabled(command);
  if (command === "setup") {
    const { options, positionals } = parse(argv, ["cwd"], ["json", "enable-review-gate", "disable-review-gate"]);
    if (options["enable-review-gate"] || options["disable-review-gate"]) disabled("automatic review gate");
    if (positionals.length) throw new Error(`Unknown setup argument: ${positionals[0]}`);
    const status = await getGrokAuthStatus(path.resolve(options.cwd ?? process.cwd()));
    const guidance = setupGuidance(status);
    const report = { ...status, ...(guidance ? { guidance } : {}) };
    const message = status.authenticated && !status.turnStopUnconfirmed ? `Grok is authenticated (${status.method}).` : status.authenticated ? "Grok setup check incomplete." : `Grok setup check failed: ${status.detail ?? status.reason}.`;
    console.log(options.json ? JSON.stringify(report, null, 2) : [message, ...(status.turnStopUnconfirmed ? ["Grok agent stop could not be confirmed."] : []), ...(guidance ? [guidance] : [])].join("\n"));
    if (!status.authenticated || status.turnStopUnconfirmed) process.exitCode = 1;
    return;
  }
  if (["review", "adversarial-review", "audit"].includes(command)) {
    const { options, positionals } = parse(argv, ["base", "scope", "model", "cwd", "language"], ["json", "background", "wait"]);
    if (options.background) disabled("--background");
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const focus = positionals.join(" ");
    const target = resolveReviewTarget(cwd, { base: options.base, scope: command === "audit" ? "repo" : options.scope });
    const context = collectReviewContext(cwd, target);
    const reviewName = command === "audit" ? "Audit" : command === "adversarial-review" ? "Adversarial Review" : "Review";
    const prompt = interpolateTemplate(loadPromptTemplate(root, command), { REVIEW_KIND: reviewName, TARGET_LABEL: target.label,
      USER_FOCUS: focus.trim() ? focus : (command === "audit" ? "Map the architecture and trace the highest-risk execution paths, trust boundaries, failure paths, concurrency, and tests." : "No extra focus provided."),
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance, RESPONSE_LANGUAGE_RULE: languageRule(options.language, focus.trim()), REVIEW_INPUT: context.content });
    const result = await runGrokReview(context.repoRoot, { instructions: prompt, model: model(options.model), outputSchema: readOutputSchema(path.join(root, "schemas", "review-output.schema.json")) });

    const parsed: ReturnType<typeof parseStructuredOutput> & { permissionDenials?: string[] } = parseStructuredOutput(result.reviewText, { status: result.status, stopReason: result.stopReason, error: result.error?.message ?? null, failureMessage: result.error?.message ?? result.stderr });
    if (!parsed.parseError) parsed.parseError = validateReviewResultShape(parsed.parsed);
    parsed.permissionDenials = result.permissionDenials;
    const incomplete = parsed.parseError || turnIncomplete(result) || parsed.parsed?.verdict === "incomplete";
    if (incomplete && parsed.parsed && !parsed.parseError) parsed.parsed.verdict = "incomplete";
    const diagnostic = errorDiagnostic(result.error);
    console.log(options.json ? JSON.stringify({ ...result, error: diagnostic, result: parsed.parseError ? null : parsed.parsed, parseError: parsed.parseError }, null, 2) : renderReviewResult(parsed, { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }));
    if (!options.json) reportTurnDiagnostics(diagnostic, result);
    if (incomplete) process.exitCode = 1;
    return;
  }
  if (command === "task") {
    const { options, positionals } = parse(argv, ["model", "effort", "cwd", "prompt-file"], ["json", "write", "resume", "resume-last", "fresh", "stop-gate", "background", "wait"]);
    for (const flag of ["resume", "resume-last", "stop-gate", "background"]) if (options[flag]) disabled(`--${flag}`);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    if (options.effort && !["low", "medium", "high"].includes(options.effort)) throw new Error("Unsupported reasoning effort. Use low, medium, or high.");
    const prompt = options["prompt-file"] ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8") : positionals.length ? positionals.join(" ") : await readStdinIfPiped();
    if (!prompt.trim()) throw new Error("A prompt is required for this Grok run.");
    const result = await runGrokTurn(cwd, { prompt, model: model(options.model), effort: options.effort, readOnly: !options.write });
    const diagnostic = errorDiagnostic(result.error);
    console.log(options.json ? JSON.stringify({ ...result, error: diagnostic }, null, 2) : result.finalMessage || result.error?.message || result.stderr || "Grok returned no output.");
    if (!options.json) reportTurnDiagnostics(diagnostic, result);
    if (turnIncomplete(result)) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}
main().catch(error => {
  console.error(error?.message ?? String(error));
  if (error?.turnStopUnconfirmed) console.error("Grok agent stop could not be confirmed.");
  process.exitCode = 1;
});
