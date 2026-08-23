#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskSessionName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskSession,
    getGrokAuthStatus,
    getGrokAvailability,
    getSessionRuntimeStatus,
    interruptGrokTurn,
    parseStructuredOutput,
    readOutputSchema,
    runGrokReview,
    runGrokTurn
  } from "./lib/grok.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, processCommandContains, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForCurrentSession,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  resolveCurrentSessionId,
  runTrackedJob,
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  validateReviewResultShape,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// grok-4.6 の initialize が申告する reasoningEfforts（実測: high が既定）。
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
// 言語タグの形。`ja`, `en-US`, `zh-Hans-CN` などを想定した緩めの BCP 47。
// 打ちやすい別名。右辺は `grok models` / session/new が返す実 ID。
const MODEL_ALIASES = new Map([
  ["fast", "grok-4.20-0309-non-reasoning"],
  ["reasoning", "grok-4.20-0309-reasoning"],
  ["multi", "grok-4.20-multi-agent-0309"],
  ["build", "grok-build-0.1"],
  ["latest", "grok-4.6"]
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--language <bcp47>] [focus text]",
      "  node scripts/grok-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--language <bcp47>] [focus text]",
      "  node scripts/grok-companion.mjs audit [--language <bcp47>] [focus text]",
      "  node scripts/grok-companion.mjs task [--write] [--resume-last|--resume|--fresh] [--model <model|fast|reasoning|multi|build|latest>] [--effort <low|medium|high>] [prompt]",
      "  node scripts/grok-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/grok-companion.mjs result [job-id] [--json]",
      "  node scripts/grok-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  if (!normalized) {
    return "";
  }
  if (characters.length <= limit) {
    return normalized;
  }
  return `${characters.slice(0, limit - 3).join("")}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = await getGrokAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push(
      process.platform === "win32"
        ? "Install Grok Build with `irm https://x.ai/cli/install.ps1 | iex`."
        : "Install Grok Build with `curl -fsSL https://x.ai/cli/install.sh | bash`."
    );
  }
  if (grokStatus.available && grokStatus.reason === "missing-agent-stdio") {
    nextSteps.push("Update Grok Build with `!grok update` so that `grok agent stdio` is available.");
  }
  if (grokStatus.available && !authStatus.authenticated) {
    nextSteps.push("Run `!grok login` to sign in with your SuperGrok or X Premium+ account.");
    nextSteps.push("If browser login is blocked, retry with `!grok login --device-auth`.");
    nextSteps.push("For headless or metered use instead, set the `XAI_API_KEY` environment variable (it takes precedence over browser credentials).");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.authenticated,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

/**
 * レビュー用プロンプトを組み立てる。
 *
 * 本家では `/codex:review` が Codex 組み込みの `review/start` へ直結していたが、
 * Grok に相当 API が無いため、標準レビューもテンプレート経由の構造化レビューにした。
 * その結果、標準レビューでも focus text を受け付けられるようになっている。
 */
function reviewTemplateNameFor(reviewName) {
  if (reviewName === "Adversarial Review") {
    return "adversarial-review";
  }
  if (reviewName === "Audit") {
    return "audit";
  }
  return "review";
}

/**
 * findings など人間が読む欄の言語ルールを組み立てる。
 *
 * 送信元の言語に動的に合わせるのが狙い。slash コマンド側の Claude が会話言語を
 * `--language <BCP 47>` で渡してくるのが正、CLI 直叩きで無指定なら focus text の
 * 言語 → 英語の順でフォールバックする。
 */
function buildResponseLanguageRule(language, focusText) {
  const fields = "every human-readable field (summary, finding titles and bodies, recommendations, next steps)";
  // タグはそのまま命令文へ埋まるので、BCP 47 の形をしたものだけ通す。
  // 検証しないと、任意の文章を指示としてプロンプトへ差し込めてしまう。
  if (language) {
    try {
      const normalizedLanguage = new Intl.Locale(language).toString();
      return `Write ${fields} in the language identified by the BCP 47 tag "${normalizedLanguage}".`;
    } catch {
      throw new Error(`Invalid BCP 47 language tag "${language}".`);
    }
  }
  if (focusText) {
    return `Write ${fields} in the same language as the user focus above.`;
  }
  return `Write ${fields} in English.`;
}

function buildUserFocus(reviewName, focusText) {
  if (focusText) {
    return focusText;
  }
  if (reviewName === "Audit") {
    return [
      "No extra focus was supplied. Apply the default deep-audit focus:",
      "map the architecture, select the highest-risk execution paths proportional to the repository's size,",
      "and trace each selected path end to end through its callers, callees, state transitions, trust boundaries,",
      "persistence or external-service boundaries, failure and cleanup paths, concurrency behavior,",
      "and relevant tests or documented contracts."
    ].join(" ");
  }
  return "No extra focus provided.";
}

function buildReviewPromptFor(reviewName, context, focusText, language) {
  const template = loadPromptTemplate(ROOT_DIR, reviewTemplateNameFor(reviewName));
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: buildUserFocus(reviewName, focusText),
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    RESPONSE_LANGUAGE_RULE: buildResponseLanguageRule(language, focusText),
    REVIEW_INPUT: context.content
  });
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.grokSessionId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = resolveCurrentSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /grok:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.grokSessionId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskSession(workspaceRoot);
}

async function executeReviewRun(request) {
  const target = request.target ?? resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPromptFor(reviewName, context, focusText, request.language);
  const result = await runGrokReview(context.repoRoot, {
    instructions: prompt,
    model: request.model,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.reviewText, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const validationError = parsed.parsed ? validateReviewResultShape(parsed.parsed) : null;
  if (validationError) {
    parsed.parseError = validationError;
  }
  const payload = {
    review: reviewName,
    target,
    // ランタイムは ACP の用語で sessionId を返す。ジョブ側では Claude の
    // セッション ID と紛れないよう grokSessionId という名前で持つ。
    grokSessionId: result.sessionId,
    model: result.model,
    usage: result.usage,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.reviewText,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    // 構造化出力を読めなかったレビューは、走り切っていても成果物として
    // 使えないので失敗扱いにする。呼び出し側のゲートがすり抜けないように。
    exitStatus: parsed.parseError ? "failed" : result.status,
    grokSessionId: result.sessionId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Grok ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    stopGate: request.stopGate
  });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Grok task thread was found for this repository.");
    }
    resumeSessionId = latestThread.id;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // キー名は runGrokTurn が読む名前と必ずそろえる。
  // ここがずれると読み取り専用の判定とセッション再開が黙って無効になる。
  const result = await runGrokTurn(workspaceRoot, {
    resumeSessionId,
    prompt: request.prompt,
    defaultPrompt: resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    readOnly: !request.write,
    onProgress: request.onProgress,
    persistThread: !request.stopGate,
    sessionTitle: resumeSessionId ? null : buildPersistentTaskSessionName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    grokSessionId: result.sessionId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    grokSessionId: result.sessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: request.stopGate ? "review" : "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewTemplateNameFor(reviewName),
    title: reviewName === "Review" ? "Grok Review" : `Grok ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, stopGate = false }) {
  if (stopGate) {
    return {
      title: "Grok Stop Gate Review",
      summary: "Stop-gate review of previous assistant turn",
      kind: "stop-gate-review",
      jobClass: "review"
    };
  }

  const title = resumeLast ? "Grok Resume" : "Grok Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary),
    kind: "task",
    jobClass: "task"
  };
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review" || kind === "audit") {
    return kind;
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: taskMetadata.kind,
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: taskMetadata.jobClass,
    summary: taskMetadata.summary,
    write
  });
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

/**
 * ランタイムの status 文字列をプロセス終了コードへ写す。
 *
 * 本家 Codex 版は数値の終了コードをそのまま流していたが、ACP 版の status は
 * "completed" などの文字列なので、そのまま代入すると Node が
 * 「code must be of type number」で落ちる。
 */
function exitCodeForStatus(status) {
  return status === "completed" ? 0 : 1;
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  if (!options.json) {
    process.stderr.write(`[grok] Job ID: ${job.id}\n`);
  }
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? { ...execution.payload, jobId: job.id } : execution.rendered, options.json);
  process.exitCode = exitCodeForStatus(execution.exitStatus);
  return execution;
}

async function handleReviewCommand(argv, config) {
  // フラグは自由記述より前に置く契約（commands/*.md にもそう書いてある）。
  // 本文に紛れた `--...` をフラグとして拾わないよう、最初の非オプションで打ち切る。
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "language"],
    booleanOptions: ["json", "background", "wait"],
    stopAtFirstPositional: true,
    aliasMap: {
      m: "model"
    }
  });

  if (options.background) {
    throw new Error("`--background` is no longer supported. Grok commands always run in the foreground.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  // audit のようにサブコマンド側で scope が決まっているときは、それを優先する。
  const scope = config.scope ?? options.scope;
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    cwd,
    target,
    base: options.base,
    scope,
    model: options.model,
    language: options.language,
    focusText,
    reviewName: config.reviewName
  };

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        ...request,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  // Grok には Codex の `review/start` に相当する組み込みレビュアーが無く、
  // 標準レビューもテンプレート経由の構造化レビューで実行する。
  // そのため本家にあった「focus text を渡せない」制約は無くなっている。
  return handleReviewCommand(argv, { reviewName: "Review" });
}

async function handleTask(argv) {
  // プロンプト本文に `--write` などが現れてもフラグとして解釈しない。
  // ここを緩めると、読み取り専用のつもりの依頼が書き込み許可で走る。
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "stop-gate", "background", "wait"],
    stopAtFirstPositional: true,
    aliasMap: {
      m: "model"
    }
  });

  if (options.background) {
    throw new Error("`--background` is no longer supported. Grok commands always run in the foreground.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  const stopGate = Boolean(options["stop-gate"]);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (stopGate && (resumeLast || options.write)) {
    throw new Error("`--stop-gate` is an internal read-only mode and cannot resume or write.");
  }
  requireTaskRequest(prompt, resumeLast);

  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    stopGate
  });

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        stopGate,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job, snapshot), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = resolveCurrentSessionId();
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            grokSessionId: candidate.grokSessionId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const grokSessionId = existing.grokSessionId ?? job.grokSessionId ?? null;
  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // 最初に terminal state を確定する。割り込み待ちの間に worker が完了しても、
  // runTrackedJob は cancelled を completed で上書きしない。
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  // キャンセルは安全弁なので、割り込みが何で失敗しても
  // この下のプロセス停止とジョブ状態の確定までは必ず通す。
  let interrupt;
  try {
    interrupt = await Promise.race([
      interruptGrokTurn(cwd, { sessionId: grokSessionId }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({
          attempted: true,
          interrupted: false,
          detail: "interrupt timed out after 750ms",
          sessionId: grokSessionId
        }), 750);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    interrupt = { attempted: true, interrupted: false, detail: error?.message ?? String(error), sessionId: grokSessionId };
  }

  appendLogLine(
    job.logFile,
    interrupt.interrupted
      ? `Requested Grok turn interrupt on ${grokSessionId}.`
      : `Grok turn interrupt skipped${interrupt.detail ? `: ${interrupt.detail}` : "."}`
  );

  try {
    if (processCommandContains(job.pid, job.id)) {
      terminateProcessTree(job.pid);
    } else if (Number.isFinite(job.pid)) {
      appendLogLine(job.logFile, "Skipped process termination because the PID no longer identifies this job.");
    }
  } catch (error) {
    appendLogLine(job.logFile, `Process termination failed: ${error?.message ?? String(error)}`);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "audit":
      // 差分ではなく、いま存在するソース全体を監査する。scope は常に repo。
      await handleReviewCommand(argv, {
        reviewName: "Audit",
        scope: "repo"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
