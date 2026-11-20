#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { EFFORT_NOT_APPLIED, GROK_INSTALL_COMMANDS, getGrokAuthStatus, parseStructuredOutput, readOutputSchema, runGrokImagine, runGrokReview, runGrokTurn } from "./lib/grok.mjs";
import { assertImagineAspect, copySessionImages, imagineBilling, isMissingImageEntitlement, partitionSessionImages, resolveImagineOutput } from "./lib/imagine.mjs";
import { t } from "./lib/i18n.mjs";
import { normalizeLanguageTag } from "./lib/language.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { renderReviewResult, validateReviewResultShape } from "./lib/render.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const aliases = { fast: "grok-4.7-build-fast", reasoning: "grok-4.20-0309-reasoning", multi: "grok-4.20-multi-agent-0309", build: "grok-build-0.1", latest: "grok-4.7" };
// 人が読むヘルプは表示言語の辞書から引く（オプション名・識別子は全言語で同じ）。
const usage = () => t("cli.usage");
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
// task / imagine 共通の入力検査。呼ぶ順序（無効フラグ → cwd → effort → プロンプト）は挙動なので保つ。
function assertEffort(options) {
  if (options.effort && !["low", "medium", "high"].includes(options.effort)) throw new Error(t("cli.unsupported_effort"));
}
// --prompt-file（cwd 基準）→ 位置引数 → パイプ標準入力の順で選び、空なら失敗にする。
async function readRunPrompt(options, positionals, cwd) {
  const text = options["prompt-file"] ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8") : positionals.length ? positionals.join(" ") : await readStdinIfPiped();
  if (!text.trim()) throw new Error(t("cli.prompt_required"));
  return text;
}
function disabled(name) { throw new Error(t("cli.disabled", { name })); }
function model(value) { return aliases[value] ?? value; }
function setupGuidance(status) {
  if (status.reason === "grok-missing") {
    if (status.availability?.reason === "missing-agent-stdio") return t("setup.update_grok");
    if (status.availability?.reason === "not-installed") {
      const install = process.platform === "win32" ? GROK_INSTALL_COMMANDS.windows : GROK_INSTALL_COMMANDS.unix;
      return t("setup.install_grok", { command: install });
    }
  }
  if (status.reason === "not-authenticated") return t("setup.authenticate");
  return null;
}
function errorDiagnostic(error) {
  if (!error) return null;
  const data = error.data?.data ?? null;
  const usageExhausted = data?.http_status === 402 && typeof data.message === "string" && /usage balance exhausted/i.test(data.message);
  return { message: error.message, rpcCode: error.rpcCode ?? null, data,
    ...(usageExhausted ? { classification: "usage-balance-exhausted", guidance: t("diag.usage_exhausted") } : {}) };
}
// review / task 共通のターン未完了判定。
// permissionDenials は意図的に `?.` を付けない（未定義なら例外になる従来の挙動を保つ）。
// review 側は parseError を先に短絡評価するため、この関数を呼ぶ位置も変えないこと。
function turnIncomplete(result) {
  return result.status !== "completed" || result.stopReason !== "end_turn" || result.turnStopUnconfirmed || result.permissionDenials.length;
}
// 非 JSON 出力時の stderr 診断。順序（RPC コード、利用枠案内、停止未確認）は表示契約なので保つ。
// stdout の本文を出した後に呼ぶ。main().catch 側の停止未確認表示は別経路なのでここへ統合しない。
// explainIncomplete は review 以外で使う（review は render 側で状態と停止理由を表示する）。
// 未完了の理由は既存行の後ろに足し、--json なしでも終了コード 1 の原因を追えるようにする。
function reportTurnDiagnostics(diagnostic, result, { explainIncomplete = false, errorShown = false } = {}) {
  if (diagnostic?.rpcCode != null) console.error(t("diag.rpc_error", { code: diagnostic.rpcCode }));
  if (diagnostic?.guidance) console.error(diagnostic.guidance);
  if (result.turnStopUnconfirmed) console.error(t("diag.stop_unconfirmed"));
  if (!explainIncomplete || !turnIncomplete(result)) return;
  // 拒否のみ・停止未確認のみで状態が completed/end_turn のときは、矛盾する「完了しなかった」行を出さない。
  if (result.status !== "completed" || result.stopReason !== "end_turn") console.error(t("diag.turn_incomplete", { status: result.status ?? t("render.unknown"), stopReason: result.stopReason ?? t("render.unknown") }));
  if (result.error?.message && !errorShown) console.error(t("diag.turn_error", { message: result.error.message }));
  if (result.permissionDenials.length) console.error(t("diag.permission_denied", { count: result.permissionDenials.length }));
}
// 明示した --effort が適用できなかったときの理由だけを、非 JSON 時に stderr へ 1 行出す。
// 他の進捗は出さない。セッション開始時に出るため、本文や reportTurnDiagnostics より前になる。
function effortNoticeReporter(json) {
  if (json) return undefined;
  return (update) => { if (typeof update === "object" && update?.kind === EFFORT_NOT_APPLIED) console.error(update.message); };
}
// target.label は AI 向けプロンプト（英語固定）に入る。利用者向けの見出しは mode と baseRef から表示言語で作る。
function displayTargetLabel(target) {
  if (target.mode === "repo") return t("review.target.repo");
  if (target.mode === "branch") return t("review.target.branch", { base: target.baseRef });
  return t("review.target.working_tree");
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
  if (!command || ["help", "--help", "-h"].includes(command)) { console.log(usage()); return; }
  if (["status", "result", "cancel", "state-lock", "task-resume-candidate"].includes(command)) disabled(command);
  if (command === "setup") {
    const { options, positionals } = parse(argv, ["cwd"], ["json", "enable-review-gate", "disable-review-gate"]);
    if (options["enable-review-gate"] || options["disable-review-gate"]) disabled("automatic review gate");
    if (positionals.length) throw new Error(t("cli.unknown_setup_argument", { argument: positionals[0] }));
    const status = await getGrokAuthStatus(path.resolve(options.cwd ?? process.cwd()));
    const guidance = setupGuidance(status);
    const report = { ...status, ...(guidance ? { guidance } : {}) };
    const message = status.authenticated && !status.turnStopUnconfirmed ? t("setup.authenticated", { method: status.method }) : status.authenticated ? t("setup.incomplete") : t("setup.failed", { detail: status.detail ?? status.reason });
    console.log(options.json ? JSON.stringify(report, null, 2) : [message, ...(status.turnStopUnconfirmed ? [t("diag.stop_unconfirmed")] : []), ...(guidance ? [guidance] : [])].join("\n"));
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
    // reviewName は AI 向けプロンプト（英語固定）、reviewLabel は利用者向けの見出し（表示言語）。
    const reviewName = command === "audit" ? "Audit" : command === "adversarial-review" ? "Adversarial Review" : "Review";
    const reviewLabel = t(command === "audit" ? "review.kind.audit" : command === "adversarial-review" ? "review.kind.adversarial_review" : "review.kind.review");
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
    console.log(options.json ? JSON.stringify({ ...result, error: diagnostic, result: parsed.parseError ? null : parsed.parsed, parseError: parsed.parseError }, null, 2) : renderReviewResult(parsed, { reviewLabel, targetLabel: displayTargetLabel(target), reasoningSummary: result.reasoningSummary }));
    if (!options.json) reportTurnDiagnostics(diagnostic, result);
    if (incomplete) process.exitCode = 1;
    return;
  }
  if (command === "task") {
    const { options, positionals } = parse(argv, ["model", "effort", "cwd", "prompt-file"], ["json", "write", "resume", "resume-last", "fresh", "stop-gate", "background", "wait"]);
    for (const flag of ["resume", "resume-last", "stop-gate", "background"]) if (options[flag]) disabled(`--${flag}`);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    assertEffort(options);
    const prompt = await readRunPrompt(options, positionals, cwd);
    const result = await runGrokTurn(cwd, { prompt, model: model(options.model), effort: options.effort, readOnly: !options.write, onProgress: effortNoticeReporter(options.json) });
    const diagnostic = errorDiagnostic(result.error);
    console.log(options.json ? JSON.stringify({ ...result, error: diagnostic }, null, 2) : result.finalMessage || result.error?.message || result.stderr || t("cli.no_output"));
    if (!options.json) reportTurnDiagnostics(diagnostic, result, { explainIncomplete: true, errorShown: !result.finalMessage });
    if (turnIncomplete(result)) process.exitCode = 1;
    return;
  }
  if (command === "imagine") {
    const { options, positionals } = parse(argv, ["model", "effort", "cwd", "prompt-file", "output", "aspect"], ["json", "write", "allow-api-billing", "resume", "resume-last", "fresh", "stop-gate", "background", "wait"]);
    for (const flag of ["resume", "resume-last", "stop-gate", "background"]) if (options[flag]) disabled(`--${flag}`);
    if (options.write) throw new Error(t("imagine.no_repo_write"));
    const cwd = path.resolve(options.cwd ?? process.cwd());
    assertEffort(options);
    if (options.aspect) assertImagineAspect(options.aspect);
    const request = await readRunPrompt(options, positionals, cwd);
    const destination = resolveImagineOutput(cwd, options.output);
    const billing = imagineBilling(process.env, Boolean(options["allow-api-billing"]));
    if (!billing.allowed) {
      const refusal = { status: "failed", billing, images: [], error: { message: billing.notice, rpcCode: null, data: null, classification: "api-billing-required", guidance: billing.notice } };
      if (options.json) console.log(JSON.stringify(refusal, null, 2));
      else console.error(billing.notice);
      process.exitCode = 1;
      return;
    }
    const aspectInstruction = options.aspect
      ? `Set aspect_ratio to "${options.aspect}" on the image tool.`
      : "Set aspect_ratio only when the user request names one.";
    const prompt = interpolateTemplate(loadPromptTemplate(root, "imagine"), { USER_REQUEST: request, ASPECT_INSTRUCTION: aspectInstruction });
    const result = await runGrokImagine(cwd, { prompt, model: model(options.model), effort: options.effort, onProgress: effortNoticeReporter(options.json) });
    const entitlementText = [result.error?.message, result.toolFailureText].filter(Boolean).join("\n");
    const entitlement = isMissingImageEntitlement(entitlementText);
    let diagnostic = errorDiagnostic(result.error);
    if (!diagnostic?.classification && entitlement) {
      diagnostic = { message: result.error?.message ?? result.finalMessage ?? t("diag.image_entitlement"), rpcCode: result.error?.rpcCode ?? null, data: diagnostic?.data ?? null,
        classification: "image-entitlement-missing", guidance: t("diag.image_entitlement") };
    }
    const turnFailed = turnIncomplete(result);
    const partitioned = turnFailed || entitlement ? { accepted: [], rejected: [] } : partitionSessionImages(result.imagePaths ?? [], process.env, result.sessionId);
    // セッション外のパスはコピーしないが、同じ結果にあるセッション画像までは捨てない。
    const copied = !turnFailed && !entitlement && partitioned.accepted.length
      ? copySessionImages(partitioned.accepted, destination, cwd) : { saved: [], failure: null };
    const images = copied.saved;
    if (!images.length && partitioned.rejected.length && !diagnostic?.classification) {
      diagnostic = { ...(diagnostic ?? { message: t("imagine.untrusted_path"), rpcCode: null, data: null }), classification: "untrusted-image-path", guidance: t("imagine.untrusted_path") };
    }
    const succeeded = !turnFailed && !entitlement && images.length > 0;
    if (!succeeded && !diagnostic?.guidance && !result.error) {
      diagnostic = { ...(diagnostic ?? { message: t("imagine.no_image"), rpcCode: null, data: null }), guidance: images.length ? undefined : t("imagine.no_image") };
    }
    // 1 枚以上保存できていれば成功のまま、途中で打ち切った理由を診断に残す。
    if (succeeded && copied.failure && !diagnostic) {
      diagnostic = { message: copied.failure, rpcCode: null, data: null, classification: "image-copy-incomplete",
        guidance: t("imagine.partial_copy", { saved: images.length, detail: copied.failure }) };
    }
    const status = succeeded ? "completed" : "failed";
    const turn = { ...result };
    delete turn.imagePaths;
    delete turn.toolFailureText;
    if (options.json) console.log(JSON.stringify({ ...turn, status, error: diagnostic, billing, images, ...(partitioned.rejected.length ? { ignoredPaths: partitioned.rejected } : {}) }, null, 2));
    else {
      const lines = [billing.notice];
      if (images.length) lines.push(...images.map((image) => t("imagine.saved", { path: image.saved })));
      else lines.push(result.finalMessage || result.error?.message || t("imagine.no_image"));
      console.log(lines.join("\n"));
      reportTurnDiagnostics(diagnostic, result, { explainIncomplete: true, errorShown: !images.length && !result.finalMessage });
    }
    if (!succeeded) process.exitCode = 1;
    return;
  }
  throw new Error(`${t("cli.unknown_command", { command })}\n${usage()}`);
}
main().catch(error => {
  console.error(error?.message ?? String(error));
  if (error?.turnStopUnconfirmed) console.error(t("diag.stop_unconfirmed"));
  process.exitCode = 1;
});
