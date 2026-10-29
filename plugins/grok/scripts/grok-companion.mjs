#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { getGrokAuthStatus, parseStructuredOutput, readOutputSchema, runGrokReview, runGrokTurn } from "./lib/grok.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { renderReviewResult, validateReviewResultShape } from "./lib/render.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const aliases = { fast: "grok-4.20-0309-non-reasoning", reasoning: "grok-4.20-0309-reasoning", multi: "grok-4.20-multi-agent-0309", build: "grok-build-0.1", latest: "grok-4.7" };
const usage = `Usage: grok-companion.mjs <setup|review|adversarial-review|audit|task> [options] [prompt]
Review: --base <ref> --scope <auto|working-tree|branch> --language <tag> --model <model> --cwd <path> --json
Task: --model <model> --effort <low|medium|high> --cwd <path> --prompt-file <path> --write --json
Each command runs a new foreground Grok session. For resuming, use Grok's own resume command.`;
function parse(argv, values, booleans) {
  const args = argv.length === 1 ? splitRawArgumentString(argv[0]) : argv;
  return parseArgs(args, { valueOptions: values, booleanOptions: booleans, aliasMap: { C: "cwd", m: "model" }, stopAtFirstPositional: true });
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
function normalizeLanguageTag(language) {
  if (/[^A-Za-z0-9-]/.test(String(language))) throw new Error(`Invalid BCP 47 language tag "${language}".`);
  const tag = String(language).toLowerCase();
  // RFC 5646 の祖父タグと、Intl が扱わない extlang・private-use を許容する。
  const grandfathered = new Set([
    "en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon",
    "i-lux", "i-mingo", "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu",
    "sgn-be-fr", "sgn-be-nl", "sgn-ch-de", "art-lojban", "cel-gaulish", "no-bok",
    "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang"
  ]);
  const langtag = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?<variants>(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)(?<extensions>(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)(?:-x(?:-[a-z0-9]{1,8})+)?$/;
  const match = langtag.exec(tag);
  if (!grandfathered.has(tag) && !/^x(?:-[a-z0-9]{1,8})+$/.test(tag)) {
    if (!match) throw new Error(`Invalid BCP 47 language tag "${language}".`);
    const variants = match.groups.variants.split("-").filter(Boolean);
    const singletons = Array.from(match.groups.extensions.matchAll(/-([0-9a-wy-z])(?:-[a-z0-9]{2,8})+/g), (item) => item[1]);
    if (new Set(variants).size !== variants.length || new Set(singletons).size !== singletons.length) {
      throw new Error(`Invalid BCP 47 language tag "${language}".`);
    }
  }
  try { return new Intl.Locale(language).toString(); } catch { return tag; }
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
    const status = await getGrokAuthStatus(path.resolve(options.cwd ?? process.cwd()), { foreground: true });
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
    const focus = positionals.join(" ").trim();
    const target = resolveReviewTarget(cwd, { base: options.base, scope: command === "audit" ? "repo" : options.scope });
    const context = collectReviewContext(cwd, target);
    const reviewName = command === "audit" ? "Audit" : command === "adversarial-review" ? "Adversarial Review" : "Review";
    const prompt = interpolateTemplate(loadPromptTemplate(root, command), { REVIEW_KIND: reviewName, TARGET_LABEL: target.label,
      USER_FOCUS: focus || (command === "audit" ? "Map the architecture and trace the highest-risk execution paths, trust boundaries, failure paths, concurrency, and tests." : "No extra focus provided."),
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance, RESPONSE_LANGUAGE_RULE: languageRule(options.language, focus), REVIEW_INPUT: context.content });
    const result = await runGrokReview(context.repoRoot, { foreground: true, instructions: prompt, model: model(options.model), outputSchema: readOutputSchema(path.join(root, "schemas", "review-output.schema.json")) });
    /** @type {ReturnType<typeof parseStructuredOutput> & { permissionDenials?: string[] }} */
    const parsed = parseStructuredOutput(result.reviewText, { status: result.status, stopReason: result.stopReason, error: result.error?.message ?? null, failureMessage: result.error?.message ?? result.stderr });
    if (!parsed.parseError) parsed.parseError = validateReviewResultShape(parsed.parsed);
    parsed.permissionDenials = result.permissionDenials;
    const incomplete = parsed.parseError || result.status !== "completed" || result.stopReason !== "end_turn" || result.turnStopUnconfirmed || result.permissionDenials.length || parsed.parsed?.verdict === "incomplete";
    if (incomplete && parsed.parsed && !parsed.parseError) parsed.parsed.verdict = "incomplete";
    const diagnostic = errorDiagnostic(result.error);
    console.log(options.json ? JSON.stringify({ ...result, error: diagnostic, result: parsed.parseError ? null : parsed.parsed, parseError: parsed.parseError }, null, 2) : renderReviewResult(parsed, { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }));
    if (!options.json && diagnostic?.rpcCode != null) console.error(`Grok session/prompt RPC error code: ${diagnostic.rpcCode}`);
    if (!options.json && diagnostic?.guidance) console.error(diagnostic.guidance);
    if (!options.json && result.turnStopUnconfirmed) console.error("Grok agent stop could not be confirmed.");
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
    const result = await runGrokTurn(cwd, { foreground: true, prompt, model: model(options.model), effort: options.effort, readOnly: !options.write });
    const diagnostic = errorDiagnostic(result.error);
    console.log(options.json ? JSON.stringify({ ...result, error: diagnostic }, null, 2) : result.finalMessage || result.error?.message || result.stderr || "Grok returned no output.");
    if (!options.json && diagnostic?.rpcCode != null) console.error(`Grok session/prompt RPC error code: ${diagnostic.rpcCode}`);
    if (!options.json && diagnostic?.guidance) console.error(diagnostic.guidance);
    if (!options.json && result.turnStopUnconfirmed) console.error("Grok agent stop could not be confirmed.");
    if (result.status !== "completed" || result.stopReason !== "end_turn" || result.turnStopUnconfirmed || result.permissionDenials.length) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}
main().catch(error => { console.error(error?.message ?? String(error)); process.exitCode = 1; });
