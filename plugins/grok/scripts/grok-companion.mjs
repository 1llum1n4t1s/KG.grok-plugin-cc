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
    getSessionRuntimeStatus,
    interruptGrokTurn,
    parseStructuredOutput,
    readOutputSchema,
    runGrokReview,
    runGrokTurn
  } from "./lib/grok.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { shortenText } from "./lib/text.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, inspectTrackedJobProcess, stopTrackedJobProcess } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  migrateStateLock,
  resolveJobLogFile,
  resolveStateDir,
  setConfig,
  updateState,
  withStateSnapshot,
  writeJobFile
} from "./lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "./lib/posix-state-lock.mjs";
import { createLinuxEpochRecovery } from "./lib/linux-epoch-recovery.mjs";
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
  appendDarwinVerifiedLog,
  assertDarwinJobLogPath,
  createJobLogFile,
  createReservedDarwinJobLog,
  createReservedLinuxJobLog,
  createJobProgressUpdater,
  createJobRecord,
  createProcessLookupDiagnostics,
  createProgressReporter,
  darwinLeaseDirectory,
  nowIso,
  observeBrokerWorkerCancellation,
  resolveCurrentSessionId,
  reserveDarwinTrackedJob,
  reserveLinuxTrackedJob,
  runTrackedJob,
  sameDarwinLease,
  sameLinuxLease,
  verifyDarwinTrackedOwner,
  verifyLinuxTrackedOwner,
} from "./lib/tracked-jobs.mjs";
import { withAvailableDarwinLease } from "./lib/darwin-worker-lease.mjs";
import { verifyPublishedDarwinLeaseRecords } from "./lib/darwin-lease-sweep.mjs";
import { withAvailableLinuxLease } from "./lib/linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "./lib/linux-lease-ledger.mjs";
import { isActiveJob } from "./lib/job-status.mjs";
import { registerDirectAgentOwner, waitForDirectAgentStop } from "./lib/direct-agent-control.mjs";
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
  ["latest", "grok-4.7"]
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
    "  node scripts/grok-companion.mjs state-lock migrate --offline-confirmed --local-only --expected-state-dir <absolute> [--all-old-processes-stopped] [--cwd <workspace>] [--json]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--language <bcp47>] [focus text]",
      "  node scripts/grok-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--language <bcp47>] [focus text]",
      "  node scripts/grok-companion.mjs audit [--language <bcp47>] [focus text]",
      "  node scripts/grok-companion.mjs task [--json] [--write] [--resume-last|--resume|--fresh] [--model <model|fast|reasoning|multi|build|latest>] [--effort <low|medium|high>] [--prompt-file <path> | prompt]",
      "    task is read-only unless --write is set; --prompt-file reads UTF-8 text.",
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
  const authStatus = await getGrokAuthStatus(cwd);
  const grokStatus = authStatus.availability;
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (grokStatus.reason === "missing-agent-stdio") {
    nextSteps.push("Update Grok Build with `!grok update` so that `grok agent stdio` is available.");
  } else if (!grokStatus.available) {
    nextSteps.push(
      process.platform === "win32"
        ? "Install Grok Build with `irm https://x.ai/cli/install.ps1 | iex`."
        : "Install Grok Build with `curl -fsSL https://x.ai/cli/install.sh | bash`."
    );
  }
  if (grokStatus.available && authStatus.reason === "not-authenticated") {
    nextSteps.push("Run `!grok login` to sign in with your SuperGrok or X Premium+ account.");
    nextSteps.push("If browser login is blocked, retry with `!grok login --device-auth`.");
    nextSteps.push("For headless or metered use instead, set the `XAI_API_KEY` environment variable (it takes precedence over browser credentials).");
  } else if (grokStatus.available && !authStatus.authenticated) {
    nextSteps.push("Resolve the authentication check error shown above, then rerun setup.");
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

function handleStateLock(argv) {
  const normalized = normalizeArgv(argv);
  for (const token of normalized) {
    if (/^--(?:offline-confirmed|local-only|all-old-processes-stopped)=/.test(token) && !/=(?:true|false)$/.test(token)) {
      throw new Error("State lock confirmation options require explicit true/false values");
    }
  }
  const { options, positionals } = parseCommandInput(normalized, {
    valueOptions: ["cwd", "expected-state-dir"], booleanOptions: ["offline-confirmed", "local-only", "all-old-processes-stopped", "json", "help"]
  });
  if (options.help) {
    console.log([
      "Explicit state lock migration (Windows NTFS, Linux ext4/tmpfs, macOS local APFS):",
      "  state-lock migrate --offline-confirmed --local-only --expected-state-dir <absolute> [--all-old-processes-stopped] [--cwd <workspace>] [--json]",
      "  state-lock stop-sentinel --offline-confirmed --local-only --expected-state-dir <absolute> [--cwd <workspace>] [--json] (Linux)",
      "  state-lock recover --offline-confirmed --local-only --all-old-processes-stopped --expected-state-dir <absolute> [--cwd <workspace>] [--json] (Linux)",
      "--expected-state-dir: copy the absolute state directory reported by the host's migration error; a different effective directory is refused before migration.",
      "--offline-confirmed: you have stopped every old runtime, broker, agent and delayed starter on every host and will not restart them for this state directory.",
      "--local-only: you confirm that no other host will concurrently use this state directory, including synchronized copies.",
      "--all-old-processes-stopped: required for Linux recovery and macOS legacy file-lock migration; every old process is stopped and will not be restarted.",
      "These are your execution prerequisites, not automatically detected guarantees. Host identifiers do not prove host uniqueness.",
      "Network/unknown filesystems and unsupported platforms are refused. Existing legacy lock files are never removed.",
      "Windows: interrupted migration may be resumed by rerunning the same explicit migration.",
      "POSIX: for incomplete migration or a device identity change, stop every runtime and keep it stopped, confirm single-host use, preserve the state.lock directory under a unique backup name, then rerun the explicit migration. Never replace or remove it while a runtime is active."
    ].join("\n"));
    return;
  }
  if (positionals.length !== 1 || !["migrate", "stop-sentinel", "recover"].includes(positionals[0])) {
    throw new Error("Invalid state-lock arguments/options. Usage: state-lock migrate --offline-confirmed --local-only --expected-state-dir <absolute> [--cwd <workspace>] [--json]");
  }
  if (positionals[0] !== "recover" && !(positionals[0] === "migrate" && process.platform === "darwin") && Object.hasOwn(options, "all-old-processes-stopped")) {
    throw new Error("--all-old-processes-stopped is only valid for state-lock recover or macOS legacy migration.");
  }
  const expectedStateDir = options["expected-state-dir"];
  if (typeof expectedStateDir !== "string" || !path.isAbsolute(expectedStateDir)
      || (path.sep === "\\" && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(expectedStateDir))) {
    throw new Error("--expected-state-dir is required and must be an absolute path copied from the host's migration error (offline/local-only confirmations are also required)");
  }
  if (positionals[0] === "stop-sentinel") {
    if (process.platform !== "linux") throw new Error("Sentinel shutdown is only available on Linux.");
    if (options["offline-confirmed"] !== true || options["local-only"] !== true) {
      throw new Error("Sentinel shutdown requires --offline-confirmed and --local-only.");
    }
    const stateDir = resolveStateDir(resolveCommandWorkspace(options));
    const payload = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir });
    outputCommandResult(payload, `Linux state sentinel stopped for ${stateDir}. Keep all runtimes stopped; explicit offline recovery is required before reuse.`, options.json);
    return;
  }
  if (positionals[0] === "recover") {
    if (process.platform !== "linux") throw new Error("State epoch recovery is only available on Linux.");
    if (options["offline-confirmed"] !== true || options["local-only"] !== true || options["all-old-processes-stopped"] !== true) {
      throw new Error("State epoch recovery requires --offline-confirmed, --local-only and --all-old-processes-stopped.");
    }
    const workspaceRoot = resolveCommandWorkspace(options);
    const stateDir = resolveStateDir(workspaceRoot, { strictWorkspace: true });
    if (stateDir !== expectedStateDir) {
      throw new Error("Expected state directory does not match the effective state directory; no recovery was performed.");
    }
    const payload = withStateSnapshot(workspaceRoot, (_state, context) => {
      if (context.stateDir !== expectedStateDir) {
        throw new Error("State directory changed before recovery; no recovery was performed.");
      }
      const result = createLinuxEpochRecovery(context, { offlineConfirmed: true, localOnly: true,
        allOldProcessesStopped: true, expectedStateDir });
      return { stateDir: context.stateDir, ...result };
    }, { strictWorkspace: true });
    outputCommandResult(payload, `Linux epoch recovery was recorded for ${payload.stateDir}. Keep all old processes stopped.`, options.json);
    return;
  }
  const payload = migrateStateLock(resolveCommandWorkspace(options), {
    offlineConfirmed: options["offline-confirmed"], localOnly: options["local-only"],
    allOldProcessesStopped: options["all-old-processes-stopped"], expectedStateDir
  });
  outputCommandResult(payload, `State lock migration is complete for this local host: ${payload.stateDir}. Keep all old runtimes stopped; state.json and jobs were preserved.`, options.json);
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
function normalizeLanguageTag(language) {
  if (/[^A-Za-z0-9-]/.test(String(language))) {
    throw new Error(`Invalid BCP 47 language tag "${language}".`);
  }
  const tag = String(language).toLowerCase();
  // RFC 5646 §2.1 の固定リスト。Intl は Unicode locale identifier だけを扱う。
  const grandfathered = new Set([
    "en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon",
    "i-lux", "i-mingo", "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu",
    "sgn-be-fr", "sgn-be-nl", "sgn-ch-de", "art-lojban", "cel-gaulish", "no-bok",
    "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang"
  ]);
  // ABNF の langtag / privateuse。登録済みサブタグの網羅照合は Intl と同様に行わない。
  const langtag = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?<variants>(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)(?<extensions>(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)(?:-x(?:-[a-z0-9]{1,8})+)?$/;
  const match = langtag.exec(tag);
  const privateuse = /^x(?:-[a-z0-9]{1,8})+$/.test(tag);
  if (!grandfathered.has(tag) && !privateuse) {
    if (!match) throw new Error(`Invalid BCP 47 language tag "${language}".`);
    const variants = match.groups.variants.split("-").filter(Boolean);
    const singletons = Array.from(match.groups.extensions.matchAll(/-([0-9a-wy-z])(?:-[a-z0-9]{2,8})+/g), (item) => item[1]);
    if (new Set(variants).size !== variants.length || new Set(singletons).size !== singletons.length) {
      throw new Error(`Invalid BCP 47 language tag "${language}".`);
    }
  }
  try {
    return new Intl.Locale(language).toString();
  } catch {
    // 祖父タグ、extlang、私用専用など、BCP47で許されIntlの範囲外となる形。
    return tag;
  }
}

function buildResponseLanguageRule(language, focusText) {
  const fields = "every human-readable field (summary, finding titles and bodies, recommendations, next steps)";
  // タグはそのまま命令文へ埋まるので、BCP 47 の形をしたものだけ通す。
  // 検証しないと、任意の文章を指示としてプロンプトへ差し込めてしまう。
  if (language) {
    const normalizedLanguage = normalizeLanguageTag(language);
    return `Write ${fields} in the language identified by the BCP 47 tag "${normalizedLanguage}".`;
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

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.grokSessionId &&
        job.taskSessionResumable !== false &&
        !isActiveJob(job) &&
        (process.platform !== "linux" || ["completed", "failed", "cancelled"].includes(job.status))
    ) ?? null
  );
}

function currentEpochJobs(workspaceRoot, sessionId = null, excludeJobId = null) {
  return withStateSnapshot(workspaceRoot, (state, context) => state.jobs.filter(indexed => {
    if (process.platform !== "linux") return true;
    if (indexed.id === excludeJobId) return false;
    let stored;
    try {
      stored = readStoredJob(workspaceRoot, indexed.id, context);
    } catch (error) {
      if (indexed.jobClass === "task" && (!sessionId || !indexed.sessionId || indexed.sessionId === sessionId)) {
        throw new Error(`Task ${indexed.id} has unverified records; resume is unavailable.`, { cause: error });
      }
      return false;
    }
    const sameSession = !sessionId || !indexed.sessionId || indexed.sessionId === sessionId ||
      (stored && (!stored.sessionId || stored.sessionId === sessionId));
    const isTask = indexed.jobClass === "task" || stored?.jobClass === "task";
    // 索引だけが旧 epoch の場合も detail を読み、現 epoch への部分更新を隠さない。
    if (indexed.epoch && indexed.epoch !== context.epoch) {
      if ((!stored || stored.epoch !== indexed.epoch) && isTask && sameSession) {
        throw new Error(`Task ${indexed.id} has unverified or inconsistent epoch records; resume is unavailable.`);
      }
      return false;
    }
    const matches = Boolean(context.epoch && stored && stored.id === indexed.id &&
      indexed.epoch === context.epoch && stored.epoch === context.epoch &&
      ["status", "sessionId", "jobClass", "grokSessionId", "taskSessionResumable", "terminationPending",
        "createdAt", "startedAt", "pid", "processStartKey", "claimToken", "workerStopConfirmed", "workerStopProof",
        "workerStopLeaseId", "workerStopProcessStartKey"].every(key => (stored[key] ?? null) === (indexed[key] ?? null)) &&
      ((stored.workerLease == null && indexed.workerLease == null) || sameLinuxLease(stored.workerLease, indexed.workerLease)));
    if (!matches && isTask && sameSession) throw new Error(`Task ${indexed.id} has unverified or inconsistent records; resume is unavailable.`);
    if (matches && isTask && sameSession) {
      if (indexed.workerLease != null) {
        try {
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
          if (!isActiveJob(indexed)) {
            const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
              verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
              context.check();
              return true;
            });
            if (released.status !== "available") throw new Error("worker lease is still held or unavailable");
          }
        }
        catch (error) { throw new Error(`Task ${indexed.id} has an unverified worker lease; resume is unavailable.`, { cause: error }); }
      } else if (indexed.workerStopConfirmed !== true || indexed.workerStopProof !== "linux-lease-released" || indexed.pid != null ||
          typeof indexed.workerStopLeaseId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(indexed.workerStopLeaseId) ||
          (indexed.workerStopProcessStartKey ?? null) !== (indexed.processStartKey ?? null)) {
        throw new Error(`Task ${indexed.id} has no verified worker stop evidence; resume is unavailable.`);
      }
    }
    return matches;
  }));
}

function assertOldTaskTurnsSettled(workspaceRoot, sessionId, grokSessionId) {
  if (process.platform !== "linux" || !grokSessionId) return;
  withStateSnapshot(workspaceRoot, (state, context) => {
    for (const indexed of state.jobs) {
      if (indexed.epoch === context.epoch) continue;
      const indexRelevant = !sessionId || !indexed.sessionId || indexed.sessionId === sessionId || indexed.grokSessionId === grokSessionId;
      let stored;
      try { stored = readStoredJob(workspaceRoot, indexed.id, context); }
      catch (error) {
        if (indexed.jobClass === "task" && indexRelevant) throw new Error(`Old task ${indexed.id} has unverified turn evidence; resume is unavailable.`, { cause: error });
        continue;
      }
      const isTask = indexed.jobClass === "task" || stored?.jobClass === "task";
      const related = indexRelevant || stored?.grokSessionId === grokSessionId || (sessionId && stored?.sessionId === sessionId);
      if (!isTask || !related) continue;
      if (!stored) throw new Error(`Old task ${indexed.id} has unverified turn evidence; resume is unavailable.`);
      // 両側が一致して別 Grok session を指す場合、その turn は候補と無関係。
      if (indexed.grokSessionId && indexed.grokSessionId === stored.grokSessionId && indexed.grokSessionId !== grokSessionId) continue;
      if (!indexed.epoch || !stored.epoch) throw new Error(`Old task ${indexed.id} has unverified epoch; resume is unavailable.`);
      const same = ["id", "epoch", "jobClass", "sessionId", "status", "createdAt", "startedAt", "grokSessionId",
        "grokPromptState", "terminationPending", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration",
        "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind"]
        .every(key => (indexed[key] ?? null) === (stored[key] ?? null));
      const terminal = same && ["completed", "failed", "cancelled"].includes(indexed.status) &&
        indexed.terminationPending === false && indexed.grokPromptState === "terminal" && indexed.grokSessionId === grokSessionId;
      const neverSent = same && indexed.grokPromptState === "not-sent" && indexed.grokSessionId == null &&
        indexed.startedAt == null && indexed.terminationPending === false;
      if (!terminal && !neverSent) throw new Error(`Old task ${indexed.id} has unverified or pending turn evidence; resume is unavailable.`);
    }
    context.check();
  });
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJob(snapshot.job) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJob(snapshot.job),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = resolveCurrentSessionId();
  const jobs = sortJobsNewestFirst(process.platform === "linux" ? currentEpochJobs(workspaceRoot, sessionId, options.excludeJobId) : listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJob(job));
  if (activeTask) {
    const detail = activeTask.terminationPending
      ? `still needs process termination. Retry /grok:cancel ${activeTask.id} before continuing it.`
      : "is still running. Use /grok:status before continuing it.";
    throw new Error(`Task ${activeTask.id} ${detail}`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    assertOldTaskTurnsSettled(workspaceRoot, sessionId, trackedTask.grokSessionId);
    return { id: trackedTask.grokSessionId };
  }

  if (sessionId || process.platform === "linux") {
    return null;
  }

  // 新jobの早期session保存はcancel用で、再開できたという証拠にはしない。
  // 同じsessionを持つ有効な旧履歴があれば、session全体を除外しない。
  const establishedSessionIds = new Set(jobs.filter((job) => job.jobClass === "task" &&
    job.grokSessionId && job.taskSessionResumable !== false && !isActiveJob(job)).map((job) => job.grokSessionId));
  const excludeSessionIds = jobs.filter((job) => job.jobClass === "task" && job.grokSessionId &&
    job.taskSessionResumable === false && !establishedSessionIds.has(job.grokSessionId)).map((job) => job.grokSessionId);
  return findLatestTaskSession(workspaceRoot, { excludeSessionIds });
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
    executionId: request.jobId,
    enqueuePrompt: createPromptEnqueuer(request.workspaceRoot ?? context.repoRoot, request.jobId, request.ownerToken),
    instructions: prompt,
    model: request.model,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  /** @type {ReturnType<typeof parseStructuredOutput> & { permissionDenials?: string[] }} */
  const parsed = parseStructuredOutput(result.reviewText, {
    status: result.status,
    stopReason: result.stopReason,
    error: result.error?.message ?? null,
    failureMessage: result.error?.message ?? result.stderr
  });
  const validationError = parsed.parseError == null ? validateReviewResultShape(parsed.parsed) : null;
  if (validationError) {
    parsed.parseError = validationError;
  }
  const permissionDenials = Array.isArray(result.permissionDenials)
    ? result.permissionDenials.filter((reason) => typeof reason === "string" && reason.trim())
    : [];
  const reviewIncomplete = !parsed.parseError &&
    Boolean(parsed.parsed) &&
    (parsed.parsed.verdict === "incomplete" || permissionDenials.length > 0 ||
      result.status !== "completed" || result.stopReason !== "end_turn");
  if (reviewIncomplete && parsed.parsed.verdict !== "incomplete") {
    // 拒否後や途中終了時に approve が届いても、生の応答は証拠として残したまま
    // 公開する構造化結果だけを incomplete へ正規化する。
    parsed.parsed = { ...parsed.parsed, verdict: "incomplete" };
  }
  parsed.permissionDenials = permissionDenials;
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
      stopReason: result.stopReason,
      error: result.error?.message ?? null,
      stderr: result.stderr,
      stdout: result.reviewText,
      reasoning: result.reasoningSummary
    },
    result: parsed.parseError ? null : parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    permissionDenials,
    reasoningSummary: result.reasoningSummary
  };

  return {
    // 構造化出力を読めなかったレビューは、走り切っていても成果物として
    // 使えないので失敗扱いにする。呼び出し側のゲートがすり抜けないように。
    exitStatus: parsed.parseError || reviewIncomplete ? "failed" : result.status,
    turnStopUnconfirmed: result.turnStopUnconfirmed,
    grokSessionId: result.sessionId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parseError ??
      (reviewIncomplete
        ? `Review incomplete${permissionDenials[0] ? `: ${permissionDenials[0]}` : "."}`
        : parsed.parsed?.summary ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`)),
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
    executionId: request.jobId,
    enqueuePrompt: createPromptEnqueuer(workspaceRoot, request.jobId, request.ownerToken),
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
  const permissionDenials = Array.isArray(result.permissionDenials)
    ? result.permissionDenials.filter((reason) => typeof reason === "string" && reason.trim())
    : [];
  const stopGateIncomplete = Boolean(request.stopGate &&
    (permissionDenials.length > 0 || result.status !== "completed" || result.stopReason !== "end_turn"));
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary,
      permissionDenials,
      incomplete: stopGateIncomplete,
      stopReason: result.stopReason,
      error: result.error?.message ?? null
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      stopGate: Boolean(request.stopGate)
    }
  );
  const payload = {
    status: result.status,
    grokSessionId: result.sessionId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    permissionDenials,
    ...(request.stopGate ? {
      reviewStatus: stopGateIncomplete ? "incomplete" : result.status,
      stopReason: result.stopReason,
      error: result.error?.message ?? null
    } : {})
  };

  return {
    exitStatus: stopGateIncomplete ? "failed" : result.status,
    turnStopUnconfirmed: result.turnStopUnconfirmed,
    grokSessionId: result.sessionId,
    payload,
    rendered,
    summary: stopGateIncomplete
      ? `Review incomplete: ${permissionDenials[0] ?? `Grok stopped (${result.stopReason ?? "unknown"}).`}`
      : firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
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
    summary: shortenText(prompt || fallbackSummary, 96),
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
    write,
    grokPromptState: "not-sent"
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  let ownerToken = null;
  return {
    logFile,
    setOwnerToken: (value) => { ownerToken = value; },
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, () => ownerToken, logFile)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return {
    ...createCompanionJob({
      prefix: "task",
      kind: taskMetadata.kind,
      title: taskMetadata.title,
      workspaceRoot,
      jobClass: taskMetadata.jobClass,
      summary: taskMetadata.summary,
      write
    }),
    taskSessionResumable: false
  };
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
  let tracked;
  let reservation = null;
  if (process.platform === "darwin" || process.platform === "linux") {
    const logFile = options.logFile ?? resolveJobLogFile(job.workspaceRoot, job.id);
    reservation = process.platform === "darwin" ? reserveDarwinTrackedJob(job, { logFile }) : reserveLinuxTrackedJob(job, { logFile });
    try {
      if (!options.logFile) {
        if (process.platform === "darwin") createReservedDarwinJobLog(job, logFile, reservation);
        else createReservedLinuxJobLog(job, logFile, reservation);
      }
      tracked = createTrackedProgress(job, { logFile, stderr: !options.json });
    } catch (error) {
      try { if (process.platform === "darwin") fs.closeSync(reservation.fd); }
      catch (closeError) { throw new AggregateError([error, closeError], `Job ${job.id} log preparation failed and its lease could not be closed.`, { cause: error }); }
      throw error;
    }
  } else tracked = createTrackedProgress(job, { logFile: options.logFile, stderr: !options.json });
  const { logFile, progress, setOwnerToken } = tracked;
  if (!options.json) {
    process.stderr.write(`[grok] Job ID: ${job.id}\n`);
  }
  const execution = await runTrackedJob(job, (ownerToken) => {
    setOwnerToken(ownerToken);
    return runner(progress, ownerToken);
  }, { logFile, ...(reservation ? { reservation } : {}) });
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
    (progress, ownerToken) =>
      executeReviewRun({
        ...request,
        jobId: job.id,
        workspaceRoot,
        ownerToken,
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
    (progress, ownerToken) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        stopGate,
        jobId: job.id,
        ownerToken,
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

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = resolveCurrentSessionId();
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(process.platform === "linux" ? currentEpochJobs(workspaceRoot, sessionId) : listJobs(workspaceRoot)));
  if (jobs.some(job => job.jobClass === "task" && isActiveJob(job))) {
    throw new Error("A task is still running or termination is pending; resume is unavailable.");
  }
  const candidate = findLatestResumableTaskJob(jobs);
  if (candidate) assertOldTaskTurnsSettled(workspaceRoot, sessionId, candidate.grokSessionId);

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

function createPromptEnqueuer(workspaceRoot, jobId, ownerToken) {
  if (!jobId) return undefined;
  const verifiedJob = (state, context, action) => {
    const job = state.jobs.find((entry) => entry.id === jobId);
    const stored = readStoredJob(workspaceRoot, jobId, context);
    if (process.platform === "linux" && (!ownerToken?.epoch || !ownerToken?.startKey ||
        !Number.isInteger(ownerToken?.pid) || ownerToken.pid <= 0 || context?.epoch !== ownerToken.epoch ||
        ![job, stored].every(record => record && record.id === jobId && record.epoch === ownerToken.epoch &&
          record.pid === ownerToken.pid && record.processStartKey === ownerToken.startKey))) {
      throw new Error(`Job ${jobId} worker identity or epoch changed; operation was not sent.`);
    }
    if (process.platform === "linux" && !verifyLinuxTrackedOwner(job, stored, jobId, ownerToken, context)) {
      throw new Error(`Job ${jobId} worker identity or lease changed; operation was not sent.`);
    }
    if (process.platform === "darwin" && !verifyDarwinTrackedOwner(job, stored, jobId, ownerToken, context)) {
      throw new Error(`Job ${jobId} worker identity or lease changed; operation was not sent.`);
    }
    if (!job || job.status !== "running" || job.terminationPending ||
        (stored && (stored.status !== "running" || stored.terminationPending))) {
      throw new Error(`Job ${jobId} was cancelled or is no longer running; ${action}.`);
    }
    return { job, stored };
  };
  const enqueuePrompt = (enqueue, execution) => {
    updateState(workspaceRoot, (state, context) => {
      const { job, stored } = verifiedJob(state, context, "prompt was not sent");
      const patch = { grokSessionId: execution.sessionId, grokTransport: execution.transport,
        grokBrokerGeneration: execution.brokerGeneration ?? null, grokPromptState: "pending" };
      // index保存が失敗した場合は送信しない。まず両方の保存を完了する。
      writeJobFile(workspaceRoot, jobId, { ...job, ...stored, ...patch }, context);
      Object.assign(job, patch);
    });
    return withStateSnapshot(workspaceRoot, (state, context) => {
      verifiedJob(state, context, "prompt was not sent");
      context?.check?.();
      // 保存後にcancelが割り込んだ場合も、最新状態の検査と同期送信を直列化する。
      return enqueue();
    });
  };
  const saveConnection = (patch) => {
    updateState(workspaceRoot, (state, context) => {
      const { job, stored } = verifiedJob(state, context, "connection was not started");
      writeJobFile(workspaceRoot, jobId, { ...job, ...stored, ...patch }, context);
      Object.assign(job, patch);
    });
  };
  enqueuePrompt.prepareConnection = () => saveConnection({ grokPromptState: "starting",
    grokSessionId: null, grokTransport: null, grokBrokerGeneration: null });
  enqueuePrompt.connectionEstablished = (connection) => {
    saveConnection({ grokPromptState: connection.transport === "broker" ? "not-sent" : "starting",
      grokSessionId: null, grokTransport: connection.transport,
      grokBrokerGeneration: connection.brokerGeneration ?? null });
    if (connection.transport === "broker" && typeof connection.close === "function") {
      return observeBrokerWorkerCancellation(workspaceRoot, jobId, connection, { ownerToken }).dispose;
    }
  };
  if (process.platform === "linux" || process.platform === "darwin") enqueuePrompt.guardOwnerEffect = (effect) => {
    let issued = false;
    try {
      return withStateSnapshot(workspaceRoot, (state, context) => {
        verifiedJob(state, context, "operation was not sent");
        context.check();
        issued = true;
        return effect(state, context);
      });
    } catch (error) {
      if (issued) throw error;
      throw Object.assign(new Error(`Job ${jobId} owner could not be verified; operation was not sent.`, { cause: error }),
        { code: "GROK_JOB_OWNER_GUARD_FAILED" });
    }
  };
  enqueuePrompt.directAgentStarting = (control) => registerDirectAgentOwner(workspaceRoot, jobId, control, { ownerToken });
  return enqueuePrompt;
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job: selectedJob } = resolveCancelableJob(cwd, reference, { env: process.env });
  let job;
  let existing;
  let nextJob;
  let completedAt;
  const sameJobGeneration = (current, expected) => current && expected &&
    (process.platform !== "linux" || (current.epoch === expected.epoch && current.claimToken === expected.claimToken &&
      ((!current.workerLease && !expected.workerLease) || sameLinuxLease(current.workerLease, expected.workerLease)))) &&
    (process.platform !== "darwin" || (current.epoch === expected.epoch && current.claimToken === expected.claimToken &&
      ((!current.workerLease && !expected.workerLease) || (current.workerLease && expected.workerLease &&
        ["id", "slot", "path", "dev", "ino", "stateGeneration", "directoryDev", "directoryIno"].every(key => current.workerLease[key] === expected.workerLease[key]))))) &&
    ["id", "createdAt", "startedAt", "processStartKey", "sessionId", "grokTransport", "grokBrokerGeneration",
      "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey"].every(key => current[key] === expected[key]);
  const hasGenerationIdentity = current => (typeof current.createdAt === "string" && Boolean(current.createdAt.trim())) ||
    (typeof current.processStartKey === "string" && Boolean(current.processStartKey));
  const sameTurnEvidence = (left, right) => left && right &&
    ["grokPromptState", "grokSessionId"].every(key => (left[key] ?? null) === (right[key] ?? null));
  let turnEvidenceConsistent;
  let indexedEvidence;
  // worker の queued→running claim と同じ lock 内で、最新の PID を記録する。
  updateState(workspaceRoot, (state, context) => {
    const indexed = state.jobs.find((candidate) => candidate.id === selectedJob.id);
    if (!indexed || !isActiveJob(indexed)) {
      throw new Error(`Job ${selectedJob.id} is no longer active. Run /grok:status to inspect it.`);
    }
    if (typeof selectedJob.createdAt !== "string" || !selectedJob.createdAt.trim() ||
        indexed.createdAt !== selectedJob.createdAt ||
        (process.platform === "linux" && (!context.epoch || selectedJob.epoch !== context.epoch)) ||
        (process.platform === "darwin" && selectedJob.workerLease && (!context.epoch || selectedJob.epoch !== context.epoch))) {
      throw new Error(`Job ${selectedJob.id} generation is missing or changed; the cancellation request was not recorded.`);
    }
    existing = readStoredJob(workspaceRoot, selectedJob.id, context);
    if (process.platform === "darwin" && (!context.epoch || indexed.epoch !== context.epoch || !existing ||
        existing.epoch !== context.epoch || !indexed.workerLease || !existing.workerLease || !indexed.claimToken)) {
      throw new Error(`Job ${selectedJob.id} has no verified current worker lease; cancellation remains pending.`);
    }
    if (process.platform === "linux" && (!context.epoch || indexed.epoch !== context.epoch ||
        !existing || existing.id !== indexed.id || existing.epoch !== context.epoch)) {
      throw new Error(`Job ${selectedJob.id} belongs to an unverified state epoch; cancellation remains pending.`);
    }
    if (process.platform === "linux" && (!indexed.workerLease || !existing?.workerLease || !indexed.claimToken)) {
      throw new Error(`Job ${selectedJob.id} has no verified worker lease; cancellation remains pending.`);
    }
    if (existing && !sameJobGeneration(indexed, existing)) {
      throw new Error(`Job ${selectedJob.id} has inconsistent generations; cancellation remains pending.`);
    }
    if (process.platform === "darwin" && (indexed.workerLease || existing?.workerLease)) {
      verifyPublishedDarwinLeaseRecords({ context, indexed, stored: existing, lease: indexed.workerLease });
    }
    if (process.platform === "linux") verifyPublishedLinuxLeaseRecords({ context, indexed, stored: existing, lease: indexed.workerLease });
    indexedEvidence = { ...indexed };
    turnEvidenceConsistent = Boolean(existing && sameTurnEvidence(indexed, existing));
    job = { ...indexed, ...existing };
    completedAt = nowIso();
    // queuedのclaimと同じlockで未起動を確定し、PID欠落からは推測しない。
    const queuedProof = (process.platform !== "linux" && (process.platform !== "darwin" || !job.workerLease)) && typeof job.createdAt === "string" && Boolean(job.createdAt.trim()) &&
      [indexed, existing].every(current => sameJobGeneration(current, job) && current.status === "queued" &&
      current.terminationPending !== true && current.pid == null && current.processStartKey == null)
      ? { workerStopConfirmed: true, workerStopProof: "never-started", workerStopProcessStartKey: null } : {};
    const previousProofKind = job.processStartKey == null ? "never-started" : "process-exited";
    // Darwin の旧 process-exited 記録には lease が結び付かず、PID が消えた後に
    // 元 worker の終了を再検証できない。未起動証拠だけを引き継ぐ。
    const previousProofValid = process.platform !== "linux" && (process.platform !== "darwin" ||
      (previousProofKind === "never-started" && job.startedAt == null)) && hasGenerationIdentity(job) && [indexed, existing].every(current => sameJobGeneration(current, job) &&
      current.status === "cancelled" && current.pid == null && current.processStartKey === job.processStartKey &&
      current.createdAt === job.createdAt && current.startedAt === job.startedAt && current.workerStopConfirmed === true &&
      current.workerStopProof === previousProofKind && current.workerStopProcessStartKey === (job.processStartKey ?? null));
    // 片側だけの証拠をmergeで両保存先へ複製し、確定済みに昇格させない。
    const workerEvidence = queuedProof.workerStopConfirmed ? queuedProof : previousProofValid
      ? { workerStopConfirmed: true, workerStopProof: previousProofKind, workerStopProcessStartKey: job.processStartKey ?? null }
      : { workerStopConfirmed: false, workerStopProof: null, workerStopProcessStartKey: null };
    nextJob = {
      ...job,
      ...workerEvidence,
      status: "cancelled",
      phase: "termination-pending",
      terminationPending: true,
      cancelRequestedAt: completedAt,
      errorMessage: "Cancelled by user."
    };
    if (existing) writeJobFile(workspaceRoot, job.id, { ...nextJob, cancelledAt: completedAt }, context);
    Object.assign(indexed, {
      status: "cancelled",
      phase: "termination-pending",
      terminationPending: true,
      pid: job.pid,
      processStartKey: job.processStartKey,
      errorMessage: "Cancelled by user.",
      cancelRequestedAt: completedAt,
      ...workerEvidence
    });
  });
  const grokSessionId = job.grokSessionId ?? null;
  const cooperativeDirect = job.grokTransport === "direct" && Boolean(job.grokDirectGeneration);
  // 初回updateStateが正常完了した後だけ使う。現generationの確定や停止成功は推測しない。
  function pendingStateFailure(action, error) {
    return new Error(`Could not ${action} for job ${job.id}: ${error?.message ?? String(error)}. ` +
      "The cancellation request for its selected generation was already saved; cancellation remains pending until its state can be confirmed. " +
      `Retry /grok:cancel ${job.id}.`, { cause: error });
  }
  function currentDirectStop(state, context) {
    const indexed = state.jobs.find(candidate => candidate.id === job.id);
    const stored = readStoredJob(workspaceRoot, job.id, context);
    return [indexed, stored].every(current => sameJobGeneration(current, job) &&
      current.grokDirectGeneration === job.grokDirectGeneration &&
      current.grokDirectOwnerPid === job.grokDirectOwnerPid &&
      current.grokDirectOwnerStartKey === job.grokDirectOwnerStartKey &&
      current.processStartKey === job.grokDirectOwnerStartKey &&
      current.grokDirectStopGeneration === job.grokDirectGeneration &&
      ["job-empty", "never-started", "posix-group-empty"].includes(current.grokDirectStopKind));
  }
  const leaseUnconfirmed = new Error(`Job ${job.id} worker lease remains unconfirmed.`);
  function commitCancellation(patch, requireDirectStop = false, requireLease = false, timeoutMs) {
    let committed;
    const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
    try {
      updateState(workspaceRoot, (state, context) => {
        const indexed = state.jobs.find(candidate => candidate.id === job.id);
        const stored = readStoredJob(workspaceRoot, job.id, context);
        const unchangedRecords = sameJobGeneration(indexed, job) && indexed.status === "cancelled" &&
          sameTurnEvidence(indexed, indexedEvidence) && (existing
            ? sameJobGeneration(stored, job) && stored.status === "cancelled" && sameTurnEvidence(stored, existing)
            : stored === null);
        if ((process.platform === "linux" && (!context.epoch || job.epoch !== context.epoch || stored?.epoch !== context.epoch)) ||
            !hasGenerationIdentity(job) || !unchangedRecords ||
            (!turnEvidenceConsistent && patch.terminationPending !== true) ||
            (turnEvidenceConsistent && !sameTurnEvidence(indexed, stored)) ||
            (requireDirectStop && !currentDirectStop(state, context))) {
          throw new Error(`Job ${job.id} generation changed; cancellation remains pending.`);
        }
        committed = { ...indexed, ...stored, ...patch, cancelledAt: stored?.cancelledAt ?? completedAt };
        if (stored) writeJobFile(workspaceRoot, job.id, committed, context);
        Object.assign(indexed, patch);
      }, requireLease ? { aroundCommit: (state, context, commit) => {
        const indexed = state.jobs.find(candidate => candidate.id === job.id);
        const stored = readStoredJob(workspaceRoot, job.id, context);
        if (process.platform === "linux") {
          if (context.epoch !== job.epoch || ![indexed, stored].every(current => sameJobGeneration(current, job) &&
              current.status === "cancelled" && sameLinuxLease(current.workerLease, job.workerLease))) {
            throw new Error(`Job ${job.id} worker lease generation changed.`);
          }
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: job.workerLease });
          const leaseContext = deadline === undefined ? context : { ...context, timeoutMs: Math.max(0, deadline - performance.now()) };
          const observed = withAvailableLinuxLease(job.workerLease, leaseContext, () => {
            verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: job.workerLease });
            context.check();
            return commit();
          });
          if (observed.status !== "available") throw leaseUnconfirmed;
          return observed.value;
        }
        if (context.epoch !== job.epoch || ![indexed, stored].every(current => sameJobGeneration(current, job) &&
            current.status === "cancelled" && sameDarwinLease(current.workerLease, job.workerLease))) {
          throw new Error(`Job ${job.id} worker lease generation changed.`);
        }
        const leaseContext = darwinLeaseDirectory(context);
        if (leaseContext.expectedDirectoryIdentity.dev !== job.workerLease.directoryDev ||
            leaseContext.expectedDirectoryIdentity.ino !== job.workerLease.directoryIno) throw new Error(`Job ${job.id} worker lease directory changed.`);
        verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease: job.workerLease });
        const observed = withAvailableDarwinLease(job.workerLease, deadline === undefined ? leaseContext :
          { ...leaseContext, timeoutMs: Math.max(0, deadline - performance.now()) }, () => {
          verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease: job.workerLease });
          context.check();
          return commit();
        });
        if (observed.status !== "available") throw leaseUnconfirmed;
        return observed.value;
      }, timeoutMs } : undefined);
    } catch (error) {
      throw pendingStateFailure("commit cancellation state", error);
    }
    return committed;
  }
  async function commitAfterWorkerLeaseRelease(patch, requireDirectStop = false) {
    const deadline = performance.now() + 5000;
    let lastUnconfirmed;
    let minimumAttemptBudget = 0;
    for (;;) {
      const remaining = deadline - performance.now();
      // 直前の非待機確認に要した時間も考慮し、期限ぎりぎりの Git / mutex 照会を始めない。
      // 実際に始めた照会の I/O エラーは、そのまま呼出元に返す。
      if (remaining <= minimumAttemptBudget && lastUnconfirmed) throw lastUnconfirmed;
      if (remaining <= 0) throw pendingStateFailure("commit cancellation state", leaseUnconfirmed);
      const attemptStarted = performance.now();
      try {
        return commitCancellation(patch, requireDirectStop, true, remaining);
      } catch (error) {
        if (error?.cause !== leaseUnconfirmed) throw error;
        lastUnconfirmed = error;
        minimumAttemptBudget = Math.max(100, (performance.now() - attemptStarted) * 2);
        const delay = Math.min(100, deadline - performance.now());
        if (delay <= 0) throw error;
        // worker は lease を保持して state mutex を取得するため、待機は mutex の外で行う。
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  const logWarnings = [];
  let warningCount = 0, warningTruncatedCount = 0, warningOmittedCount = 0, warningStderrUnavailable = false;
  function boundedWarning(value) {
    const limit = 768;
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= limit) return { text: value, truncated: false };
    const suffix = "… [truncated; see stderr for the full diagnostic]";
    let budget = limit - Buffer.byteLength(JSON.stringify(suffix), "utf8"), prefix = "";
    for (const character of value) {
      const size = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
      if (size > budget) break;
      prefix += character;
      budget -= size;
    }
    return { text: prefix + suffix, truncated: true };
  }
  function warningData() {
    if (!warningCount) return {};
    return { logWarnings: [...logWarnings, ...(warningOmittedCount ? [`${warningOmittedCount} additional log warning(s) omitted; see stderr.`] : [])],
      logWarningCount: warningCount, logWarningTruncatedCount: warningTruncatedCount, logWarningOmittedCount: warningOmittedCount,
      ...(warningStderrUnavailable ? { logWarningStderrUnavailable: true } : {}) };
  }
  function appendCancellationLog(message) {
    try {
      if (!job.logFile || !String(message ?? "").trim()) return;
      withStateSnapshot(workspaceRoot, (state, context) => {
        const indexed = state.jobs.find(candidate => candidate.id === job.id);
        const stored = readStoredJob(workspaceRoot, job.id, context);
        if ((process.platform === "linux" && (!context.epoch || job.epoch !== context.epoch)) ||
            ![indexed, stored].every(current => sameJobGeneration(current, job) && current.status === "cancelled" &&
              current.logFile === job.logFile)) {
          if (process.platform === "darwin") throw new Error("Cancellation log was skipped because the job identity or log reference changed.");
          return;
        }
        if (process.platform === "darwin" && job.workerLease) {
          verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease: job.workerLease });
        }
        if (process.platform === "linux") verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: job.workerLease });
        context.check();
        if (process.platform === "darwin") {
          assertDarwinJobLogPath(context, job.id, job.logFile);
          appendDarwinVerifiedLog(job.logFile, `[${nowIso()}] ${String(message).trim()}\n`, { create: false });
          return;
        }
        const before = fs.lstatSync(job.logFile, { bigint: true });
        if (before.isSymbolicLink() || !before.isFile()) throw new Error("Cancellation log is not a regular file.");
        const fd = fs.openSync(job.logFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const opened = fs.fstatSync(fd, { bigint: true });
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Cancellation log identity changed.");
          context.check();
          fs.writeFileSync(fd, `[${nowIso()}] ${String(message).trim()}\n`, "utf8");
        } finally { fs.closeSync(fd); }
      });
    } catch (error) {
      const warning = `Could not write cancellation log: ${error?.message ?? String(error)}`;
      warningCount++;
      if (logWarnings.length === 0) {
        const bounded = boundedWarning(warning);
        logWarnings.push(bounded.text);
        if (bounded.truncated) warningTruncatedCount++;
      } else warningOmittedCount++;
      try {
        const bytes = Buffer.from(`[grok] ${warning}\n`);
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(process.stderr.fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error("stderr write made no progress");
          offset += written;
        }
      } catch { warningStderrUnavailable = true; }
    }
  }

  // キャンセルは安全弁なので、割り込みが何で失敗しても
  // この下のプロセス停止とジョブ状態の確定までは必ず通す。
  if (process.platform === "linux") withStateSnapshot(workspaceRoot, (state, context) => {
      const indexed = state.jobs.find(current => current.id === job.id);
      const stored = readStoredJob(workspaceRoot, job.id, context);
      if (!context.epoch || job.epoch !== context.epoch || ![indexed, stored].every(current => sameJobGeneration(current, job))) {
        throw new Error("Job epoch changed before interruption.");
      }
  });
  let interrupt;
  try {
    if (!turnEvidenceConsistent) {
      interrupt = { attempted: false, interrupted: false, stopConfirmed: false,
        detail: "job records have missing or inconsistent turn evidence" };
    } else if (cooperativeDirect) {
      const confirmed = await waitForDirectAgentStop(workspaceRoot, job.id, job);
      interrupt = { attempted: true, interrupted: confirmed, stopConfirmed: confirmed,
        detail: confirmed ? "Owned direct agent stop was persisted by its worker." : "Owned direct agent stop is still pending." };
    } else interrupt = await Promise.race([
      job.grokPromptState === "not-sent" ? Promise.resolve({ attempted: false, interrupted: false, stopConfirmed: true,
        detail: "new job was cancelled before prompt admission" }) :
        interruptGrokTurn(cwd, { sessionId: grokSessionId, executionId: job.id,
          transport: job.grokTransport, brokerGeneration: job.grokBrokerGeneration }),
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

  appendCancellationLog(
    interrupt.notificationSent
      ? `Grok cancellation notification sent on ${grokSessionId}; turn stop is unconfirmed.`
      : interrupt.reservationAccepted
      ? `Reserved cancellation for ${grokSessionId}; no matching broker turn was active.`
      : `Grok turn interrupt skipped${interrupt.detail ? `: ${interrupt.detail}` : "."}`
  );

  if (cooperativeDirect && interrupt.stopConfirmed !== true) {
    // ACKを保存できる実所有workerを先に殺さない。期限後もmonitorは処理を継続する。
    if (warningCount) commitCancellation({ terminationPending: true, phase: "termination-pending", ...warningData() });
    throw new Error(`Direct Grok agent stop for job ${job.id} remains pending; its owner is still allowed to confirm the same generation. Retry /grok:cancel ${job.id}.`);
  }

  const processLookupOptions = createProcessLookupDiagnostics(job.logFile);
  if (process.platform === "linux") {
    const workerProof = { workerStopConfirmed: true, workerStopProof: "linux-lease-released",
      workerStopLeaseId: job.workerLease.id, workerStopProcessStartKey: job.processStartKey ?? null };
    if (interrupt.stopConfirmed !== true) {
      await commitAfterWorkerLeaseRelease({ ...workerProof, pid: null, terminationPending: true, phase: "termination-pending", ...warningData() });
      throw new Error(`Worker stopped for job ${job.id}, but Grok turn stop is unconfirmed; cancellation remains pending. Retry /grok:cancel ${job.id}.`);
    }
    const stoppedJob = await commitAfterWorkerLeaseRelease({ ...workerProof, pid: null, phase: "cancelled", terminationPending: false,
      completedAt: nowIso(), ...warningData() }, cooperativeDirect);
    appendCancellationLog("Cancelled by user.");
    const payload = { jobId: job.id, status: "cancelled", title: job.title, turnInterruptAttempted: interrupt.attempted,
      turnInterrupted: interrupt.interrupted, turnStopConfirmed: true, workerStopConfirmed: true,
      turnInterruptNotificationSent: interrupt.notificationSent === true, turnCancellationReserved: interrupt.reservationAccepted === true,
      ...warningData() };
    outputCommandResult(payload, renderCancelReport({ ...stoppedJob, ...warningData() }), options.json);
    return;
  }
  if (process.platform === "darwin" && job.workerLease) {
    const workerProof = { workerStopConfirmed: true, workerStopProof: "darwin-lease-released",
      workerStopLeaseId: job.workerLease.id, workerStopProcessStartKey: job.processStartKey ?? null };
    if (interrupt.stopConfirmed !== true) {
      await commitAfterWorkerLeaseRelease({ ...workerProof, pid: null, terminationPending: true, phase: "termination-pending", ...warningData() });
      throw new Error(`Worker stopped for job ${job.id}, but Grok turn stop is unconfirmed; cancellation remains pending. Retry /grok:cancel ${job.id}.`);
    }
    const stoppedJob = await commitAfterWorkerLeaseRelease({ ...workerProof, pid: null, phase: "cancelled", terminationPending: false,
      completedAt: nowIso(), ...warningData() }, cooperativeDirect);
    appendCancellationLog("Cancelled by user.");
    const payload = { jobId: job.id, status: "cancelled", title: job.title, turnInterruptAttempted: interrupt.attempted,
      turnInterrupted: interrupt.interrupted, turnStopConfirmed: interrupt.stopConfirmed === true,
      workerStopConfirmed: true, turnInterruptNotificationSent: interrupt.notificationSent === true,
      turnCancellationReserved: interrupt.reservationAccepted === true,
      ...warningData() };
    outputCommandResult(payload, renderCancelReport({ ...stoppedJob, ...warningData() }), options.json);
    return;
  }
  let workerProof;
  try {
    workerProof = withStateSnapshot(workspaceRoot, (state, context) => {
      if (process.platform === "linux" && (!context.epoch || job.epoch !== context.epoch)) throw new Error("Job epoch changed before process lookup.");
      if (!hasGenerationIdentity(job)) return null;
      const indexed = state.jobs.find(current => current.id === job.id);
      const stored = readStoredJob(workspaceRoot, job.id, context);
      const records = [indexed, stored];
      if (process.platform === "linux" && !records.every(current => sameJobGeneration(current, job))) {
        throw new Error("Job records changed before process lookup.");
      }
      if (!records.every(current => sameJobGeneration(current, job) && current.status === "cancelled" &&
          current.processStartKey === job.processStartKey && current.pid == null && current.workerStopConfirmed === true &&
          current.workerStopProcessStartKey === (job.processStartKey ?? null))) return null;
      const proof = job.processStartKey == null ? "never-started" : "process-exited";
      if (process.platform === "darwin" && (proof !== "never-started" || job.startedAt != null)) return null;
      if (!records.every(current => current.workerStopProof === proof)) return null;
      return { workerStopConfirmed: true, workerStopProof: proof, workerStopProcessStartKey: job.processStartKey ?? null };
    });
  } catch (error) {
    throw pendingStateFailure("read worker stop evidence", error);
  }
  // PID 欠落は ESRCH ではない。旧証拠だけで終了扱いせず取消を保留する。
  if (process.platform === "darwin" && !workerProof && (!Number.isInteger(job.pid) || job.pid <= 0)) {
    throw new Error(`Cannot verify the process for job ${job.id}; cancellation remains pending. Retry /grok:cancel ${job.id}.`);
  }
  let identity = workerProof ? "absent" : inspectTrackedJobProcess(job.pid, job.processStartKey, processLookupOptions);
  if (process.platform === "darwin" && identity === "mismatch") identity = "unavailable";
  if (process.platform === "darwin" && !workerProof && identity === "absent") {
    try { process.kill(job.pid, 0); identity = "unavailable"; }
    catch (error) { if (error?.code !== "ESRCH") identity = "unavailable"; }
  }
  if (identity === "unavailable") {
    appendCancellationLog("Process identity lookup failed; cancellation can be retried with the same job id.");
    throw new Error(`Cannot verify the process for job ${job.id}; cancellation remains pending. Retry /grok:cancel ${job.id}.`);
  }
  if (identity === "match") {
    try {
      const stopWorker = () => {
        stopTrackedJobProcess(job.pid, job.processStartKey, { ...processLookupOptions, tree: false });
      };
      if (process.platform === "win32") {
        // Windowsは同一handleでworkerだけを止め、共有brokerは停止対象に含めない。
        withStateSnapshot(workspaceRoot, (state, context) => {
          if (cooperativeDirect && !currentDirectStop(state, context)) throw new Error("Direct agent generation changed before worker stop.");
          stopWorker();
        });
      } else {
        // POSIXはsignalを送らず自然終了を待つ。workerのACK/terminal保存を妨げない。
        if (cooperativeDirect) withStateSnapshot(workspaceRoot, (state, context) => {
          if (!currentDirectStop(state, context)) throw new Error("Direct agent generation changed before worker stop.");
        });
        stopWorker();
      }
    } catch (error) {
      appendCancellationLog(`Process termination failed: ${error?.message ?? String(error)}`);
      throw new Error(`Could not stop process for job ${job.id}; cancellation remains pending. Retry /grok:cancel ${job.id}.`, { cause: error });
    }
  } else if (identity === "mismatch") {
    appendCancellationLog("Skipped process termination because the PID and start time do not identify this job.");
  }
  workerProof ??= { workerStopConfirmed: true, workerStopProof: "process-exited", workerStopProcessStartKey: job.processStartKey };

  if (interrupt.stopConfirmed !== true) {
    // snapshotは元のchild handleと原子的に結合できないため、direct agent停止には使わない。
    commitCancellation({ ...workerProof, pid: null, terminationPending: true, phase: "termination-pending" });
    appendCancellationLog("Tracked worker stopped; Grok turn stop remains unconfirmed.");
    throw new Error(`Worker stopped for job ${job.id}, but Grok turn stop is unconfirmed; cancellation remains pending. Retry /grok:cancel ${job.id}.`);
  }

  appendCancellationLog("Cancelled by user.");
  const stoppedJob = commitCancellation({ ...workerProof, pid: null, phase: "cancelled", terminationPending: false, completedAt: nowIso(),
    ...warningData() }, cooperativeDirect);

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    turnStopConfirmed: interrupt.stopConfirmed === true,
    workerStopConfirmed: true,
    turnInterruptNotificationSent: interrupt.notificationSent === true,
    turnCancellationReserved: interrupt.reservationAccepted === true,
    ...warningData()
  };

  outputCommandResult(payload, renderCancelReport({ ...stoppedJob, ...warningData() }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "state-lock":
      handleStateLock(argv);
      break;
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
