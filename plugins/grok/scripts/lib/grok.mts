import type { AcpClientOptions, AcpNotification, SessionUpdate, SessionUpdateNotification, StopReason } from "./acp-protocol.js";
type ProgressUpdate = { message: string; phase: string | null; sessionId?: string | null; kind?: string };
type ProgressReporter = (update: string | ProgressUpdate) => void;
interface GrokOptions {
  grokBin?: string;
  onStderr?: (chunk: string) => void;
  effort?: string;
  env?: NodeJS.ProcessEnv;
  instructions?: string;
  mcpServers?: unknown[];
  model?: string;
  defaultModels?: string[];
  onProgress?: ProgressReporter;
  onUpdate?: (update: SessionUpdate) => void;
  permissionHandler?: AcpClientOptions["permissionHandler"];
  onWriteDenied?: (reason: string) => void;
  outputSchema?: unknown;
  prompt?: string;
  readOnly?: boolean;
}
interface TurnCollectorState {
  sessionId: string;
  onProgress: ProgressReporter | null;
  agentMessage: string;
  reasoningBuffer: string;
  reasoning: string[];
  toolCalls: Map<string, { title: string; status: string }>;
  touchedFiles: Set<string>;
  commandExecutions: { command: string; status: string }[];
  title: string | null;
  usage: unknown;
  stopReason: StopReason | null;
}
/**
 * Grok Build を ACP 越しに動かすランタイム層。
 *
 * 本家 codex-plugin-cc の lib/codex.mjs に対応する。移植にあたっての主な差分:
 *
 *   - Codex の `thread/*` を ACP の `session/*` へ置き換えた。用語も thread → session
 *     に統一している（外向けの戻り値キーは sessionId）。
 *   - Codex には `review/start` という専用 API があったが、Grok Build の ACP には無い。
 *     レビューは通常の `session/prompt` にレビュー指示と JSON Schema を載せて行い、
 *     読み取り専用の担保は ACP の権限応答側（書き込み系ツールを拒否）で取る。
 *   - Codex 版は `turn/start` が即座に返り、通知の流れから完了を推測して
 *     タイマーで打ち切っていた。ACP の `session/prompt` はターン終了時に
 *     stopReason を伴って解決するため、その推測機構は不要になり削除した。
 *   - `externalAgentConfig/import`（Claude セッションの取り込み）に相当する
 *     機能が Grok に無いため、importExternalAgentSession は移植していない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { READ_ONLY_GIT_GLOBAL_ARGS } from "./git.mjs";
import {
  GrokAcpClient,
  getAcpPromptFailureEvidence,
  getAcpPromptSuccessEvidence,
  quoteIfNeeded,
  createAllowAllPermissionResponder,
  createReadOnlyPermissionResponder
} from "./acp.mjs";
import { binaryAvailable } from "./process.mjs";
import { READ_ONLY_COMMANDS, classifyShellCommand } from "./shell-allowlist.mjs";
function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(command);
}
import { t } from "./i18n.mjs";
import { extractGeneratedImagePaths, failedToolText, isImageGenerationTool } from "./imagine.mjs";
import { shortenText } from "./text.mjs";


/**
 * 明示指定が無いときの既定モデルの候補。先頭から順に、モデル一覧にある最初のものを使う。
 * fast 版が無い環境（4.6 など）では、バージョン名の決め打ちではなく一覧の有無で次の候補へ落ちる。
 *
 * API キー認証だと `session/new` の既定が `grok-4.20-0309-non-reasoning` になり、
 * 推論なしモデルではレビュー品質が落ちるため、推論可能なモデルを明示的に指す。
 * 環境変数 GROK_PLUGIN_MODEL で上書きできる。
 */
const DEFAULT_MODEL_CANDIDATES = ["grok-4.7-build-fast", "grok-4.7"];

/** 明示指定が無いときの推論深度。選択肢が無いモデルでは黙って流す。 */
const DEFAULT_REASONING_EFFORT = "high";

/**
 * ツール名だけで書き込みと判定できるもの。
 *
 * シェル実行系（run_terminal_command 等）はここに入れない。レビュー中の Grok は
 * `git diff` や `git show` のような読み取り専用コマンドを普通に使うため、
 * 名前で一律に拒否するとレビューそのものが中断してしまう。
 * シェルは classifyShellCommand が中身を見て可否を決める。
 */
const MUTATING_TOOL_PATTERN = /(write|edit|create|delete|remove|rename|patch|apply_|multi_edit|str_replace)/i;

function cleanGrokStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s*(WARNING|warning): proceeding/.test(line))
    .join("\n");
}

function emitProgress(onProgress: ProgressReporter, message: string, phase: string | null = null, extra: Partial<ProgressUpdate> = {}) {
  if (typeof onProgress !== "function") {
    return;
  }
  onProgress({ message, phase, ...extra });
}

/** 権限要求を読み取り専用の観点で判定する。 */
function classifyToolCall(params, cwd): { allowed: boolean; reason: string | null } {
  const call = params?.toolCall ?? {};
  const rawInput = call.rawInput ?? {};

  // Grok 組み込み WebFetch は URL の内容だけを返す。表示名や read_only フラグだけでは許可しない。
  if (call.kind === "fetch" && rawInput?.variant === "WebFetch") {
    if (Object.keys(rawInput).some((key) => !["variant", "url"].includes(key)) ||
        typeof rawInput.url !== "string") {
      return { allowed: false, reason: t("err.perm_webfetch_url_only") };
    }
    try {
      const url = new URL(rawInput.url);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
        return { allowed: true, reason: null };
      }
    } catch {
      // 不正な URL は許可しない。
    }
    return { allowed: false, reason: t("err.perm_webfetch_http") };
  }

  const command = typeof rawInput === "object" && rawInput ? rawInput.command ?? rawInput.cmd : null;
  if (typeof command === "string") {
    return classifyShellCommand(command, cwd);
  }

  const name = [call.title, call.kind].filter(Boolean).join(" ");
  if (MUTATING_TOOL_PATTERN.test(name)) {
    return { allowed: false, reason: t("err.perm_tool_modifies_files") };
  }

  return { allowed: false, reason: t("err.perm_tool_unknown") };
}

/**
 * 読み取り専用セッション用の権限応答器。
 *
 * ACP では読み取り系ツールがそもそも問い合わせてこない（実測: list_dir /
 * read_file は自動解決される）が、WebFetch は問い合わせる。明示的に許可した
 * 読み取り専用の要求だけを 1 回許可し、未知の要求は拒否する。
 */
function createReviewPermissionHandler(cwd, onProgress, onDenied = (_reason) => {}): NonNullable<AcpClientOptions["permissionHandler"]> {
  const readOnly = createReadOnlyPermissionResponder();
  const deny = createReadOnlyPermissionResponder({ allowKinds: [] });
  return (params) => {
    const verdict = classifyToolCall(params, cwd);
    const permissionOptions = Array.isArray(params?.options) ? params.options : [];
    if (verdict.allowed && permissionOptions.some((option) => option?.kind === "allow_once")) {
      return readOnly(params);
    }

    const reason = verdict.reason ?? t("err.perm_no_allow_option");
    const denial = `${reason}: ${shortenText(params?.toolCall?.title ?? t("err.perm_unknown_tool"), 60)}`;
    onDenied(denial);
    emitProgress(
      onProgress,
      `Denied during read-only review (${reason}): ${shortenText(params?.toolCall?.title ?? t("err.perm_unknown_tool"), 60)}`,
      "running"
    );

    // 拒否肢があれば選ぶ。ただし Grok Build は選択による拒否でも
    // permission_rejected としてターンを終了することがある。
    return deny(params);
  };
}

/**
 * Imagine 用の権限応答器。画像生成・編集の 1 回許可だけを通し、
 * リポジトリの編集、シェル、動画生成は拒否する。
 */
function createImaginePermissionHandler(onProgress, onDenied = (_reason: string) => {}): NonNullable<AcpClientOptions["permissionHandler"]> {
  const allow = createReadOnlyPermissionResponder();
  const deny = createReadOnlyPermissionResponder({ allowKinds: [] });
  return (params) => {
    const tool = params?.toolCall;
    const permissionOptions = Array.isArray(params?.options) ? params.options : [];
    if (isImageGenerationTool(tool) && permissionOptions.some((option) => option?.kind === "allow_once")) return allow(params);
    const reason = isImageGenerationTool(tool)
      ? t("err.perm_imagine_no_option")
      : t("err.perm_imagine_only");
    const title = tool?.title ?? t("err.perm_unknown_tool");
    onDenied(`${reason}: ${shortenText(title, 60)}`);
    emitProgress(onProgress, `Denied during imagine (${reason}): ${shortenText(title, 60)}`, "running");
    return deny(params);
  };
}

/**
 * ターン中に流れてくる session/update を集約する。
 *
 * Codex 版の TurnCaptureState に相当するが、完了判定を stopReason に委ねられる
 * ぶん単純化してある。
 */
function createTurnCollector(sessionId: string, options: GrokOptions = {}) {
  const state: TurnCollectorState = {
    sessionId,
    onProgress: options.onProgress ?? null,
    /** エージェントの最終回答本文（チャンクを連結したもの）。 */
    agentMessage: "",
    /**
     * 思考サマリの生バッファ。
     * agent_thought_chunk はトークン単位の断片で届くため、ここへ連結してから
     * 段落へ切り出す。断片をそのまま配列へ積むと 1 単語 1 項目になってしまう。
     */
    reasoningBuffer: "",
    /** 段落へ整形した思考サマリ。finalize で埋める。 */
    reasoning: [],
    /** ツール呼び出しの記録。toolCallId をキーにする。 */
    toolCalls: new Map(),
    /** 変更が入ったファイルのパス。 */
    touchedFiles: new Set(),
    /** 検証コマンドらしき実行の記録。 */
    commandExecutions: [],
    title: null,
    usage: null,
    stopReason: null
  };

  const handle = (message: AcpNotification) => {
    const method = message?.method;

    // xAI 独自通知。使用量だけ拾い、他は無視する。
    if (method === "_x.ai/session_notification") {
      const update = (message.params as { update?: { sessionUpdate?: string; usage?: unknown } })?.update;
      if (update?.sessionUpdate === "response_completed" && update.usage) {
        state.usage = update.usage;
      }
      return;
    }

    if (method !== "session/update") {
      return;
    }

    const update = (message as SessionUpdateNotification).params?.update;
    if (!update) {
      return;
    }
    options.onUpdate?.(update);

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = (update.content as { text?: string })?.text ?? "";
        state.agentMessage += text;
        return;
      }
      case "agent_thought_chunk": {
        state.reasoningBuffer += (update.content as { text?: string })?.text ?? "";
        return;
      }
      case "tool_call": {
        const title = update.title ?? update.toolCallId;
        state.toolCalls.set(update.toolCallId, { title, status: update.status ?? "pending" });
        emitProgress(state.onProgress, `Tool: ${shortenText(title, 60)}`, "running", { sessionId });
        return;
      }
      case "tool_call_update": {
        const existing: Partial<{ title: string; status: string }> = state.toolCalls.get(update.toolCallId) ?? {};
        const merged = {
          title: update.title ?? existing.title ?? update.toolCallId,
          status: update.status ?? existing.status ?? "pending"
        };
        state.toolCalls.set(update.toolCallId, merged);

        for (const location of update.locations ?? []) {
          if (location?.path) {
            state.touchedFiles.add(location.path);
          }
        }

        const command =
          typeof update.rawInput === "object" && update.rawInput
            ? (update.rawInput as { command?: unknown; cmd?: unknown }).command ?? (update.rawInput as { cmd?: unknown }).cmd ?? null
            : null;
        if (command && looksLikeVerificationCommand(String(command))) {
          state.commandExecutions.push({ command: String(command), status: merged.status });
        }
        return;
      }
      case "session_info_update": {
        if (update.title) {
          state.title = update.title;
        }
        return;
      }
      default:
        return;
    }
  };

  /** ターン終了後に、連結済みバッファを読める単位へ切り出す。 */
  const finalize = () => {
    state.reasoning = splitReasoningSections(state.reasoningBuffer);
    return state;
  };

  return { state, handle, finalize };
}

/**
 * 連結した思考テキストを段落へ分ける。
 * 空行区切りを優先し、区切りが無ければ 1 段落として扱う。
 */
function splitReasoningSections(buffer) {
  const text = String(buffer ?? "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\n{2,}/)
    .map((section) => section.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * ACP クライアントを開いて処理を実行し、必ず閉じる。
 */
async function withGrok(cwd, handler, options: GrokOptions = {}) {
  const client = await GrokAcpClient.connectForeground(cwd, options);
  let result, failure, failed = false;
  try { result = await handler(client); }
  catch (error) { failed = true; failure = error; }
  let closeError;
  try { await client.close(); } catch (error) { closeError = error; }
  if (client.closeStopUnconfirmed || closeError) {
    if (failed) {
      if (failure && typeof failure === "object") failure.turnStopUnconfirmed = true;
      else failure = Object.assign(new Error(String(failure)), { turnStopUnconfirmed: true });
    } else if (closeError) {
      closeError.turnStopUnconfirmed = true;
    } else if (result && typeof result === "object") {
      result.turnStopUnconfirmed = true;
    } else {
      throw Object.assign(new Error(t("err.stop_unconfirmed_direct")), { turnStopUnconfirmed: true });
    }
  }
  if (failed) throw failure;
  if (closeError) throw closeError;
  return result;
}

/** JSON-RPC の method not found。ACP v1 で消えた RPC を呼ぶとこれが返る。 */
const RPC_METHOD_NOT_FOUND = -32601;

/**
 * `session/new` が返した設定項目から、指定カテゴリのものを探す。
 * ACP 仕様上 category はあくまで UX ヒントで必須ではないため、
 * 見つからないことを異常扱いにしない。
 */
function findSessionConfigOption(response, category) {
  const configOptions = Array.isArray(response?.configOptions) ? response.configOptions : [];
  return configOptions.find((option) => option?.category === category) ?? null;
}

/** select 型の選択肢はフラットにもグループにもなるので、両方から value を集める。 */
function collectConfigValueIds(option) {
  const ids = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    if (typeof entry?.value === "string") {
      ids.push(entry.value);
      continue;
    }
    for (const nested of Array.isArray(entry?.options) ? entry.options : []) {
      if (typeof nested?.value === "string") {
        ids.push(nested.value);
      }
    }
  }
  return ids;
}

/**
 * セッション設定を 1 件反映する。反映できなければ理由を返して呼び出し側に委ねる。
 */
async function applySessionConfigOption(client, sessionId, option, wanted) {
  const available = collectConfigValueIds(option);
  const value =
    available.find((id) => id === wanted) ??
    available.find((id) => id.toLowerCase() === String(wanted).toLowerCase()) ??
    null;

  if (!value) {
    const detail = available.length ? `not offered (available: ${available.join(", ")})` : "no selectable values";
    return { applied: false, value: null, reason: detail, available, configOptions: null };
  }

  let configOptions = null;
  if (option.currentValue !== value) {
    const result = await client.request("session/set_config_option", { sessionId, configId: option.id, value });
    // 応答は切替え後の configOptions を返すことがある。
    configOptions = Array.isArray(result?.configOptions) ? result.configOptions : null;
  }
  return { applied: true, value, reason: null, configOptions };
}

/** 応答に配列の configOptions があるときだけそれを返す。無い応答は null。 */
function readConfigOptions(response) {
  return Array.isArray(response?.configOptions) ? response.configOptions : null;
}

/**
 * `session/set_model` は成功しても configOptions を返さない（応答型は空）。
 * 切替前の一覧で推論深度を決めると、API キーの推論なし既定から fast へ移したあとも
 * high を送らず、切替前に high があると切替後に無いモデルへも high を送る。
 * `session/load` が返す切替後の一覧を使う。load が無い実装では切替前へ戻さない。
 */
async function loadConfigOptionsAfterModelSwitch(client, response, options, cwd) {
  try {
    const loaded = await client.request("session/load", {
      sessionId: response.sessionId,
      cwd,
      mcpServers: options.mcpServers ?? []
    });
    return readConfigOptions(loaded) ?? [];
  } catch {
    // session/load は復元用で、進行中のセッションでは失敗し得る。
    // 切替前の一覧へ戻さず、推論深度だけを省く。ターン自体は止めない。
    return [];
  }
}

/**
 * 要求されたモデルへ差し替え、実効モデルと切替え後の configOptions を返す。
 *
 * `session/new` の既定モデルは認証方式によって変わる（API キーだと
 * 推論なしモデルになる）ため、現在値と違えば明示的に合わせる。
 * ACP v1 は `session/set_model` を廃止して `session/set_config_option` へ
 * 統合したので、旧 RPC を先に試し method not found のときだけ新経路へ落ちる。
 *
 * 明示指定（options.model）はそのまま尊重する。指定が無いときだけ
 * options.defaultModels を順に見て、一覧にある最初のものを使う。
 * 推論深度の判定に使えるよう、切替え後の configOptions を併せて返す。
 */
async function applyRequestedModel(client, response, options, cwd) {
  const explicit = options.model ?? null;
  const current = response.models?.currentModelId ?? null;
  const originalConfigOptions = response.configOptions;
  const unchanged = { model: current, configOptions: originalConfigOptions };

  const available = response.models?.availableModels?.map((model) => model.modelId) ?? [];
  let requested = explicit;
  if (!requested) {
    const candidates: string[] = options.defaultModels ?? [];
    if (!candidates.length) {
      return unchanged;
    }
    // 一覧が空・不明のときは従来どおり最後の候補（最上位の非 fast）を直接要求する。
    requested = available.length ? candidates.find((id) => available.includes(id)) ?? null : candidates[candidates.length - 1];
    if (!requested) {
      emitProgress(
        options.onProgress,
        `None of ${candidates.join(", ")} is available; staying on ${current ?? "the session default"}.`,
        "starting"
      );
      return unchanged;
    }
  }

  if (requested === current) {
    return unchanged;
  }

  if (available.length && !available.includes(requested)) {
    emitProgress(
      options.onProgress,
      `Model ${requested} is not available; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return unchanged;
  }

  try {
    const result = await client.request("session/set_model", { sessionId: response.sessionId, modelId: requested });
    emitProgress(options.onProgress, `Model set to ${requested}.`, "starting");
    const configOptions = readConfigOptions(result) ?? await loadConfigOptionsAfterModelSwitch(client, response, options, cwd);
    return { model: requested, configOptions };
  } catch (error) {
    if (error?.rpcCode !== RPC_METHOD_NOT_FOUND) {
      throw error;
    }
  }

  const option = findSessionConfigOption(response, "model");
  if (!option) {
    emitProgress(
      options.onProgress,
      `This Grok build exposes no model selector; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return unchanged;
  }

  const result = await applySessionConfigOption(client, response.sessionId, option, requested);
  if (!result.applied) {
    emitProgress(
      options.onProgress,
      `Model ${requested} is ${result.reason}; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return unchanged;
  }

  emitProgress(options.onProgress, `Model set to ${result.value}.`, "starting");
  return { model: result.value, configOptions: result.configOptions ?? originalConfigOptions };
}

/**
 * 推論レベルを反映する。
 * ACP に専用 RPC は無く、`thought_level` カテゴリの設定項目として扱う。
 * 明示指定（options.effort）が無ければ既定の high を狙うが、これは暗黙の既定なので、
 * 選択項目や high が無いモデルでは黙って流す。明示指定のときだけ理由を進捗へ出す。
 * 反映可否は本題（レビューや委任タスク）の成否と無関係なので、
 * 失敗しても turn を止めない。判定は切替え後の configOptions（state）で行う。
 * 理由の進捗には kind（EFFORT_NOT_APPLIED）を付け、companion が非 JSON 時だけ stderr へ 1 行出す。
 */
export const EFFORT_NOT_APPLIED = "effort-not-applied";
async function applyRequestedEffort(client, state, options) {
  const explicit = options.effort ?? null;
  const requested = explicit ?? DEFAULT_REASONING_EFFORT;
  const report = (message) => {
    if (explicit) {
      emitProgress(options.onProgress, message, "starting", { kind: EFFORT_NOT_APPLIED });
    }
  };

  const option = findSessionConfigOption({ configOptions: state.configOptions }, "thought_level");
  if (!option) {
    report(t("diag.effort_no_selector", { effort: requested }));
    return null;
  }

  try {
    const result = await applySessionConfigOption(client, state.sessionId, option, requested);
    if (!result.applied) {
      report(result.available?.length
        ? t("diag.effort_not_offered", { effort: requested, available: result.available.join(", ") })
        : t("diag.effort_no_values", { effort: requested }));
      return null;
    }
    if (explicit || option.currentValue !== result.value) {
      emitProgress(options.onProgress, `Reasoning effort set to ${result.value}.`, "starting");
    }
    return result.value;
  } catch (error) {
    report(t("diag.effort_failed", { effort: requested, detail: error?.message ?? String(error) }));
    return null;
  }
}

/**
 * セッションを開始し、必要ならモデルと推論レベルを差し替える。
 */
async function startSession(client, cwd, options: GrokOptions = {}) {
  const response = await client.request("session/new", {
    cwd,
    mcpServers: options.mcpServers ?? []
  });

  // session/new が返す currentModelId は差し替え前の値なので、実効モデルを別に持つ。
  const applied = await applyRequestedModel(client, response, options, cwd);
  const effectiveModel = applied.model;
  const effectiveEffort = await applyRequestedEffort(
    client,
    { sessionId: response.sessionId, configOptions: applied.configOptions },
    options
  );

  return { ...response, effectiveModel, effectiveEffort };
}

/**
 * プロンプトを 1 ターン実行し、流れてきた更新を集約して返す。
 */
async function runPrompt(client, sessionId, promptText, options: GrokOptions = {}) {
  const collector = createTurnCollector(sessionId, { onProgress: options.onProgress, onUpdate: options.onUpdate });
  client.setNotificationHandler(collector.handle);

  let stopReason = null;
  let error = null;
  let originalFailure;
  let promptAttempted = false;
  let promptRequestId = null;
  try {
    promptAttempted = true;
    promptRequestId = client.nextId;
    const response = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] });
    const evidence = getAcpPromptSuccessEvidence(response, client);
    if (!evidence || evidence.method !== "session/prompt" || evidence.requestId !== promptRequestId) {
      throw Object.assign(new Error(t("err.prompt_unverified")), { turnStopUnconfirmed: true });
    }
    stopReason = evidence.stopReason;
    if (typeof stopReason !== "string" || !["end_turn", "cancelled", "refusal", "max_tokens", "max_turn_requests"].includes(stopReason)) {
      throw Object.assign(new Error(t("err.prompt_no_terminal")), { turnStopUnconfirmed: true });
    }
  } catch (caught) {
    originalFailure = caught;
    error = caught instanceof Error ? caught : new Error(t("err.prompt_non_error"), { cause: caught });
  } finally { client.setNotificationHandler(null); }

  collector.state.stopReason = stopReason;
  collector.finalize();
  const evidence = error && promptAttempted ? getAcpPromptFailureEvidence(error, client) : null;
  const terminal = evidence?.requestId === promptRequestId && evidence?.method === "session/prompt" && evidence?.terminal === "confirmed";
  let reportedUnconfirmed = false;
  try { reportedUnconfirmed = error?.turnStopUnconfirmed === true || (originalFailure != null && originalFailure !== error && originalFailure.turnStopUnconfirmed === true); }
  catch { reportedUnconfirmed = true; }
  return { ...collector.state, error, turnStopUnconfirmed: Boolean(reportedUnconfirmed || (error && promptAttempted && !terminal)), promptNotSent: !promptAttempted };

}

function buildResultStatus(turnState) {
  if (turnState.error) {
    return "failed";
  }
  switch (turnState.stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "refused";
    case "max_tokens":
    case "max_turn_requests":
      return "truncated";
    default:
      return "unknown";
  }
}

/** Windows の環境変数は大文字小文字を区別しないため、`Path` 等の表記揺れも拾う。 */
function readWindowsEnv(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Windows で区切りのない実行ファイル名を、PATH と PATHEXT だけから絶対パスへ解決する。
 *
 * Grok は cmd.exe 経由で起動するため、素の名前を渡すと cmd.exe は PATH より先に
 * カレントディレクトリ（＝レビュー対象のリポジトリ）を探す。リポジトリ内に置かれた
 * 同名の grok.exe / grok.cmd が本物の代わりに実行されないよう、作業ディレクトリを
 * 探索対象から外して自前で解決する。PATH 上の相対ディレクトリも cwd 依存になるため除外する。
 */
function resolveWindowsCommandOnPath(name, env) {
  const extensions = (readWindowsEnv(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";").map((extension) => extension.trim()).filter(Boolean);
  const candidates = path.win32.extname(name) ? [name] : extensions.map((extension) => name + extension);
  for (const directory of String(readWindowsEnv(env, "PATH") ?? "").split(";")) {
    const dir = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.win32.isAbsolute(dir)) continue;
    for (const candidate of candidates) {
      const full = path.win32.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // 存在しない候補は次を探す。
      }
    }
  }
  return null;
}

/** パス区切りやドライブ指定を含まない、PATH 探索に委ねる名前か。 */
function isBareCommandName(command) {
  return !/[\\/:]/.test(command);
}

/** `grok` 実行ファイルの場所。GROK_BIN で上書きできる。 */
function resolveGrokBin(env = process.env) {
  const configured = env.GROK_BIN;
  let bin = configured || "grok";
  if (!configured) {
    const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
    const bundled = path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  // Windows の素の名前は cwd を先に探されるため、ここで絶対パスへ固定する。
  // 見つからなければ素の名前のまま返し、getGrokAvailability が起動前に未導入として扱う。
  if (process.platform === "win32" && isBareCommandName(bin)) {
    bin = resolveWindowsCommandOnPath(bin, env) ?? bin;
  }
  return bin;
}

export function getGrokAvailability(cwd, env = process.env) {
  const bin = resolveGrokBin(env);
  // PATH で解決できなかった素の名前を cmd.exe へ渡すと、レビュー対象リポジトリ内の
  // 同名ファイルが実行され得る。起動せずに未導入として返す。
  if (process.platform === "win32" && isBareCommandName(bin)) {
    return { available: false, bin, reason: "not-installed", detail: `${bin} was not found on PATH` };
  }
  // Windows では cmd.exe 経由で起動する。`process.env.SHELL`（Git Bash）だと
  // パスのバックスラッシュがエスケープとして食われ、`.cmd` ラッパーも起動できない。
  const spawnOptions = { cwd, env, shell: process.platform === "win32" };
  const command = process.platform === "win32" ? quoteIfNeeded(bin) : bin;

  const versionStatus = binaryAvailable(command, ["--version"], spawnOptions);
  if (!versionStatus?.available) {
    return { available: false, bin, reason: "not-installed", detail: versionStatus?.detail ?? null };
  }

  // `agent stdio` が無い古い版を弾く。--help はサブコマンドが実在するときだけ成功する。
  const agentStatus = binaryAvailable(command, ["agent", "stdio", "--help"], spawnOptions);
  if (!agentStatus?.available) {
    return { available: false, bin, reason: "missing-agent-stdio", detail: agentStatus?.detail ?? null };
  }

  return {
    available: true,
    bin,
    version: versionStatus.detail ?? null
  };
}

export async function getGrokAuthStatus(cwd, options: GrokOptions = {}) {
  const env = options.env ?? process.env;
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    return { authenticated: false, reason: "grok-missing", availability };
  }

  const usingApiKey = Boolean(env.XAI_API_KEY);
  const { permissionDenials, onDenied } = createPermissionDenialLog();

  try {
    return await withGrok(
      cwd,
      async (client) => {
        const methods = client.initializeResult?.authMethods ?? [];
        try {
          const session = await client.request("session/new", { cwd, mcpServers: [] });
          if (permissionDenials.length) {
            return { authenticated: false, reason: "check-failed", detail: permissionDenials.join("; "), availability };
          }
          return {
            authenticated: true,
            method: usingApiKey ? "api-key" : "browser-login",
            currentModelId: session.models?.currentModelId ?? null,
            availableModels: session.models?.availableModels?.map((model) => model.modelId) ?? [],
            agentVersion: client.initializeResult?._meta?.agentVersion ?? null,
            availability
          };
        } catch (error) {
          // session/new の失敗がすべて認証拒否とは限らない。
          const authenticationRequired = !permissionDenials.length && error?.rpcResponseReceived === true && /\bauthentication required\b/i.test(error.message ?? "");
          return {
            authenticated: false,
            reason: authenticationRequired ? "not-authenticated" : "check-failed",
            detail: permissionDenials.length ? permissionDenials.join("; ") : error?.message ?? String(error),
            authMethods: methods.map((method) => method.id),
            availability
          };
        }
      },
      { grokBin: availability.bin, env, readOnly: true,
        permissionHandler: createReviewPermissionHandler(cwd, options.onProgress, onDenied), onWriteDenied: onDenied }
    );
  } catch (error) {
    return { authenticated: false, reason: permissionDenials.length ? "check-failed" : "connect-failed", detail: permissionDenials.length ? permissionDenials.join("; ") : error?.message ?? String(error), availability,
      ...(error?.turnStopUnconfirmed ? { turnStopUnconfirmed: true } : {}) };
  }
}

/**
 * Grok の起動可否を確かめ、未導入・非対応版なら案内付きで失敗させる。
 * レビューとタスクの入口で同じ検査と文言を使うための補助。
 */
function requireGrokAvailability(cwd, env) {
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }
  return availability;
}

/**
 * 明示指定、環境変数 GROK_PLUGIN_MODEL の順で要求モデルを決める。どちらも無ければ null で、
 * その場合は startSession が既定の候補（DEFAULT_MODEL_CANDIDATES）から選ぶ。
 */
function resolveRunModel(options: GrokOptions, env: NodeJS.ProcessEnv): string | null {
  return options.model ?? env.GROK_PLUGIN_MODEL ?? null;
}

/** 報告用のモデル名。実効値が取れなければ要求値、それも無ければ既定の最後の候補。 */
function reportedModel(session, requested: string | null) {
  return session.effectiveModel ?? requested ?? DEFAULT_MODEL_CANDIDATES[DEFAULT_MODEL_CANDIDATES.length - 1];
}

/**
 * 権限拒否の記録と、それへ追記する通知関数の組を作る。
 * 初期化・session/new 中の拒否も同じ記録へ残し、結果と判定に使う。
 */
function createPermissionDenialLog() {
  const permissionDenials: string[] = [];
  const onDenied = (reason: string) => permissionDenials.push(reason);
  return { permissionDenials, onDenied };
}

/** Grok Build の導入コマンド。未導入時の案内（setup と起動失敗）で共有する。 */
export const GROK_INSTALL_COMMANDS = {
  windows: "irm https://x.ai/cli/install.ps1 | iex",
  unix: "curl -fsSL https://x.ai/cli/install.sh | bash"
} as const;

function grokMissingMessage(availability) {
  if (availability?.reason === "missing-agent-stdio") return t("err.grok_missing_agent_stdio");
  return t("err.grok_not_installed", GROK_INSTALL_COMMANDS);
}

/**
 * 読み取り専用のコードレビューを実行する。
 *
 * Codex の `review/start` に相当する専用 API が Grok Build の ACP には無いため、
 * レビュー指示と（あれば）JSON Schema をプロンプトへ載せて実行し、
 * 書き込み系ツールは権限応答側で拒否して読み取り専用を担保する。
 */
export async function runGrokReview(cwd, options: GrokOptions = {}) {
  const env = options.env ?? process.env;
  const availability = requireGrokAvailability(cwd, env);

  const model = resolveRunModel(options, env);

  // 初期化・session/new 中の拒否も JSON 再出力後まで同じ記録へ残す。
  const { permissionDenials, onDenied } = createPermissionDenialLog();

  return withGrok(
    cwd,
    async (client) => {
      emitProgress(options.onProgress, "Starting Grok review session.", "starting");
      const session = await startSession(client, cwd, {
        model,
        defaultModels: DEFAULT_MODEL_CANDIDATES,
        onProgress: options.onProgress,
        // レビュー中に外部 MCP を呼ばせない。Grok は既定でユーザーの
        // グローバル MCP 設定を拾ってしまい、余計なトークンを使うため。
        mcpServers: []
      });
      const sessionId = session.sessionId;
      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

      const promptText = buildReviewPrompt(options);
      const promptOptions = { onProgress: options.onProgress };
      let turnState = await runPrompt(client, sessionId, promptText, promptOptions);
      let repaired = false;

      // 正常に終了した最終応答だけを JSON として訂正する。拒否やキャンセル後の
      // 途中経過を再出力させると、未完了の調査が終わったように見えてしまう。
      if (options.outputSchema && !turnState.error && !turnState.turnStopUnconfirmed && turnState.stopReason === "end_turn" && turnState.agentMessage) {
        const attempt = parseStructuredOutput(turnState.agentMessage);
        if (attempt.parseError) {
          emitProgress(options.onProgress, "Grok returned malformed JSON; asking it to re-emit.", "running", {
            sessionId
          });
          const retry = await runPrompt(
            client,
            sessionId,
            buildJsonRepairPrompt(attempt.parseError, options.outputSchema),
            promptOptions
          );
          // 訂正に失敗しても最新の本文・終了理由・エラーを返す。
          // 監査自体の思考サマリは初回のものを残し、JSON訂正の成否とは分ける。
          // 初回 prompt は送信・終端済みなので、repair の未送信を実行全体の未送信にしない。
          turnState = { ...retry, reasoning: turnState.reasoning, promptNotSent: false };
          repaired = !retry.error && retry.stopReason === "end_turn" && Boolean(retry.agentMessage) &&
            !parseStructuredOutput(retry.agentMessage).parseError;
        }
      }

      const reviewStatus = buildResultStatus(turnState);
      return {
        jsonRepaired: repaired,
        permissionDenials,
        status: reviewStatus,
        sessionId,
        model: reportedModel(session, model),
        reviewText: turnState.agentMessage,
        reasoningSummary: turnState.reasoning,
        stopReason: turnState.stopReason,
        usage: turnState.usage,
        error: turnState.error,
        turnStopUnconfirmed: turnState.turnStopUnconfirmed,
        promptNotSent: turnState.promptNotSent,
        stderr: cleanGrokStderr(client.stderr)
      };
    },
    { grokBin: availability.bin, env, readOnly: true,
      permissionHandler: createReviewPermissionHandler(cwd, options.onProgress, onDenied), onWriteDenied: onDenied }
  );
}

/**
 * レビューと読み取り専用 task が共有する、シェル許可リスト（shell-allowlist.mts）に沿った調査の作法。
 * review のプロンプトはこの並びと文言をそのまま使うため、変えるとレビューの送信文も変わる。
 */
const READ_ONLY_SHELL_RULES = [
  "- Prefer your built-in file-reading tools (read_file, list_dir, and grep). Simple read-only repository commands such as rg are also available. Do not modify files or run commands with side effects.\n",
  "- The shell uses a command allowlist, not a judgment of whether a script looks read-only. Do not run Python (python/python3/py), Node.js, Bun, other interpreters, or shell wrappers (powershell/pwsh/bash/sh/cmd), including inline scripts with -c, -e, or -Command. Read JSON and verification evidence with read_file and inspect the returned text directly. For multiline files, read_file offset/limit select lines; they cannot split a single long line. If you cannot fully inspect the required content, report that evidence as unverified. Do not run a script to extract or summarize fields.\n",
  "- Plain shell command names available for read-only inspection are: " + [...READ_ONLY_COMMANDS].join(", ") + ". Their arguments still undergo the read-only checks below. Git and Test-Path have separate restricted forms. If a command is unavailable on this OS, use built-in file tools instead of wrapping it in another shell. ACP file requests must stay within the repository; report evidence you cannot access as unverified.\n",
  "- Every Git command must start with: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + ". Then use a supported read-only subcommand. For diff, log, show and whatchanged, put --no-ext-diff and --no-textconv immediately after the subcommand as its first two arguments (either order), before any other option, revision or -- path separator. Status and blame are denied. Diff must put --cached or --staged immediately after those two guards, or use an exact 40-digit SHA-1 OID..OID or 64-digit SHA-256 OID..OID there. For fixed ranges, only supported display flags may follow; put paths after -- and do not add revisions or use HEAD/branch names. Use the fixed comparison from collection guidance. Grep requires --cached first; --no-index and modified ls-files checks are denied. These flags suppress textconv/external diff; they do not establish an OS sandbox. Example: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " diff --no-ext-diff --no-textconv --cached --stat. Use complete option names supported by that specific subcommand and separate short options; options from another subcommand, unknown options, custom pretty formats and --submodule=diff are denied. For example, grep --cached --text is supported, but cat-file --text is denied; use cat-file -p to read an object. Use file tools if a command is unsupported.\n",
  "- For recent commit history, use --since=YYYY-MM-DD with git log and --oneline, not a custom percent-based format. Example: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " log --no-ext-diff --no-textconv --since=2026-09-28 --oneline. Replace the example date with the requested starting date.\n",
  "- Avoid PowerShell script blocks and variables, unquoted parentheses or leading @ (quote search patterns that contain parentheses), command substitution, backticks, redirection, and executable paths: the read-only shell policy rejects these even in a read-only command.\n"
];

/**
 * 読み取り専用 task の末尾へ付ける案内。依頼本文は変えず、調査の作法だけを区切って足す。
 * Grok Build は許可されない要求を 1 回でも出すとターンごと取り消すことがあるため、先に許可される形を伝える。
 * 内容は shell-allowlist.mts の実判定と一致させる（パイプは各セグメントの先頭が許可コマンドなら通る）。
 */
function buildReadOnlyTaskPrompt(prompt: string) {
  return (
    prompt +
    "\n\n---\n\n## Read-only inspection rules\n" +
    "This section only constrains how you inspect the repository. It does not change the request above, the output format it asks for, or the response language.\n" +
    "- This run is read-only. Do not modify, create, delete or rename files, and do not run commands with side effects.\n" +
    READ_ONLY_SHELL_RULES.join("") +
    "- Commands may be joined with |, &&, || or ;, but the first word of every segment must itself be an allowed command from the list above (a pipe into an allowed command is fine). The only PowerShell cmdlet allowed is Test-Path -LiteralPath <path inside the repository>.\n" +
    "- The command line is split at | ; && and || before quotes are considered, so these separators are also rejected inside quoted patterns and jq filters (for example rg \"a|b\" src, rg \"a && b\" src and jq \".scripts | keys\" package.json are denied). For alternatives use repeated -e options, such as rg -e foo -e bar src, or pipe separate allowed commands.\n" +
    "- These characters are rejected even inside quotes: ^ { } < > a lone & (not &&), a $name variable, a %name% or !name! sequence (as in \"100% of 50%\") and a newline. Any argument or quoted text is rejected as a path outside the repository when it contains // or \\/, when \\\\ or a / follows the start, a space, =, a quote, \\ or another / (as in \"GET /api\"; /dev/null is the only exception), or when a single letter followed by a colon follows the start, a space, =, a quote, \\ or / (looks like a drive, as in \"x: number\" or \"\\d:\"). An argument may not mix quoted and unquoted text, and absolute paths, .. path segments, a leading ~ (home directory path) and path-qualified executables are rejected. Use --ignore-case, because a lone -i is rejected. Use sed only as sed -n N,Mp. find -exec/-delete and rg --pre are rejected, and a bare space-separated word tee is rejected even as a search term (quote it as \"tee\" to search for it).\n" +
    "- To get the current commit OID, run git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " rev-parse HEAD (use HEAD~1 and similar for earlier commits, or a branch name; do not use ^ or @{...}). This task has no collection guidance, so pick the full OIDs to compare yourself with rev-parse.\n" +
    "- Subagent delegation is unavailable in this read-only runtime; do not call spawn_subagent or other delegation tools.\n" +
    "- A permission denial can terminate the entire Grok turn, so choose a form that is allowed before making a request. State anything you could not verify as unverified in your answer instead of guessing.\n"
  );
}

/**
 * レビュー用のプロンプトを組み立てる。
 *
 * レビュー対象（差分の収集結果と対象の説明）は companion がテンプレートへ埋め込んだ
 * instructions に含まれているので、ここでは調査の作法（Ground rules）と出力形式を足す。
 */
function buildReviewPrompt(options: GrokOptions = {}) {
  const parts = [];
  parts.push(options.instructions?.trim() || "Review the code in this repository for defects.");

  parts.push(
    "\n## Ground rules\n" +
      "- Read whatever files you need from the working tree to judge the change in context.\n" +
      READ_ONLY_SHELL_RULES.join("") +
      "- Perform all review perspectives yourself in this session. Subagent delegation is unavailable in this read-only runtime; do not call spawn_subagent or other delegation tools, even if repository instructions recommend parallel reviewers.\n" +
      "- A permission denial can terminate the entire Grok turn, so choose supported tools before making a request. If the turn continues after a denial, use supported read-only tools and report the limitation. Never claim approval for an incomplete inspection; use the incomplete verdict.\n" +
      "- Report only defects you can point to a specific file and line for."
  );

  if (options.outputSchema) {
    parts.push(buildStructuredOutputInstruction(options.outputSchema));
  }

  return parts.join("\n");
}

/**
 * 構造化出力の指示文。
 *
 * ACP の `session/prompt` にはスキーマでモデルを制約する口が無い
 * （CLI の `--json-schema` は制約できるが、その代わり初回応答で打ち切られて
 * ファイルを読ませられないため、レビューには使えない）。
 * したがってプロンプトで守らせるしかなく、実際に踏んだ失敗
 * ―― 前置きの散文が混ざる、文字列内の `"` が未エスケープ ―― を名指しで禁じる。
 */
function buildStructuredOutputInstruction(schema) {
  return (
    "\n## Required output\n" +
    "Your final message must be a single JSON object and nothing else.\n" +
    "- Do not write any sentence before or after the JSON, not even a short lead-in.\n" +
    "- Do not wrap the JSON in a markdown code fence.\n" +
    '- Escape every `"` that appears inside a string value as `\\"`, and escape backslashes as `\\\\`.\n' +
    "- When you need to quote code that contains quotes, prefer single quotes or describe it in words.\n" +
    "It must validate against this JSON Schema:\n\n" +
    `${JSON.stringify(schema, null, 2)}`
  );
}

/**
 * 直前の返答が JSON として壊れていたときに、同じセッションで訂正させる指示。
 */
function buildJsonRepairPrompt(parseError, schema) {
  return (
    "Your previous message could not be parsed as JSON.\n" +
    `Parser error: ${parseError}\n\n` +
    "Send the same review again as one valid JSON object and nothing else.\n" +
    "Do not re-read any files and do not change your findings — only fix the JSON itself.\n" +
    'Pay particular attention to escaping `"` and `\\` inside string values.\n\n' +
    `It must validate against this JSON Schema:\n\n${JSON.stringify(schema, null, 2)}`
  );
}

/** task と imagine が返す結果の共通部分。キーの並びは --json の出力順そのものなので変えない。 */
function buildTurnResult(turnState, context: { session; sessionId: string; model; permissionDenials: string[]; client: { stderr?: unknown } }) {
  return {
    status: buildResultStatus(turnState),
    sessionId: context.sessionId,
    model: reportedModel(context.session, context.model),
    finalMessage: turnState.agentMessage,
    permissionDenials: context.permissionDenials,
    reasoningSummary: turnState.reasoning,
    stopReason: turnState.stopReason,
    usage: turnState.usage,
    error: turnState.error,
    turnStopUnconfirmed: turnState.turnStopUnconfirmed,
    promptNotSent: turnState.promptNotSent,
    stderr: cleanGrokStderr(context.client.stderr),
    touchedFiles: [...turnState.touchedFiles],
    commandExecutions: turnState.commandExecutions
  };
}

/**
 * 任意のタスクを Grok に委任して 1 ターン実行する。
 * 書き込みを許すかどうかは options.readOnly で切り替える。
 */
export async function runGrokTurn(cwd, options: GrokOptions = {}) {
  const env = options.env ?? process.env;
  const availability = requireGrokAvailability(cwd, env);

  const prompt = options.prompt?.trim() || "";
  if (!prompt) {
    throw new Error(t("cli.prompt_required"));
  }

  const model = resolveRunModel(options, env);
  const { permissionDenials, onDenied } = createPermissionDenialLog();

  return withGrok(
    cwd,
    async (client) => {
      emitProgress(options.onProgress, "Starting Grok task session.", "starting");
      const session = await startSession(client, cwd, { model, defaultModels: DEFAULT_MODEL_CANDIDATES, effort: options.effort, onProgress: options.onProgress, mcpServers: [] });
      const sessionId = session.sessionId;

      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

      if (!options.readOnly) {
        client.setWriteDeniedHandler(onDenied);
        client.setPermissionHandler(createAllowAllPermissionResponder());
      }

      const turnState = await runPrompt(client, sessionId, options.readOnly ? buildReadOnlyTaskPrompt(prompt) : prompt, { onProgress: options.onProgress });

      return buildTurnResult(turnState, { session, sessionId, model, permissionDenials, client });
    },
    { grokBin: availability.bin, env, readOnly: Boolean(options.readOnly),
      ...(options.readOnly ? { permissionHandler: createReviewPermissionHandler(cwd, options.onProgress, onDenied), onWriteDenied: onDenied } : {}) }
  );
}

/**
 * 画像生成を 1 ターン実行する。task と同じ前景セッションで、書き込み許可は画像ツールだけに限る。
 * 保存先への複製は呼び出し側が imagePaths を見て行う。
 */
export async function runGrokImagine(cwd, options: GrokOptions = {}) {
  const env = options.env ?? process.env;
  const availability = requireGrokAvailability(cwd, env);
  const prompt = options.prompt?.trim() || "";
  if (!prompt) throw new Error(t("cli.prompt_required"));
  const model = resolveRunModel(options, env);
  const { permissionDenials, onDenied } = createPermissionDenialLog();
  const imageToolIds = new Set<string>();
  const imagePaths: string[] = [];
  const seen = new Set<string>();
  const failureTexts: string[] = [];
  return withGrok(
    cwd,
    async (client) => {
      emitProgress(options.onProgress, "Starting Grok imagine session.", "starting");
      const session = await startSession(client, cwd, { model, defaultModels: DEFAULT_MODEL_CANDIDATES, effort: options.effort, onProgress: options.onProgress, mcpServers: [] });
      const sessionId = session.sessionId;
      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });
      const turnState = await runPrompt(client, sessionId, prompt, {
        onProgress: options.onProgress,
        onUpdate: (update) => {
          const failed = failedToolText(update);
          if (failed) failureTexts.push(failed);
          if (!("toolCallId" in update) || typeof update.toolCallId !== "string") return;
          if (isImageGenerationTool({ title: update.title, rawInput: update.rawInput })) imageToolIds.add(update.toolCallId);
          if (!imageToolIds.has(update.toolCallId)) return;
          for (const found of extractGeneratedImagePaths(update)) {
            if (seen.has(found)) continue;
            seen.add(found);
            imagePaths.push(found);
          }
        }
      });
      return {
        ...buildTurnResult(turnState, { session, sessionId, model, permissionDenials, client }),
        imagePaths: [...imagePaths],
        toolFailureText: failureTexts.join("\n")
      };
    },
    { grokBin: availability.bin, env, readOnly: true,
      permissionHandler: createImaginePermissionHandler(options.onProgress, onDenied), onWriteDenied: onDenied }
  );
}

/**
 * 応答本文から構造化レビューの JSON を取り出し、解析結果または失敗情報を返す。
 */
export function parseStructuredOutput(rawOutput, fallback: { failureMessage?: string; status?: string; stopReason?: string; error?: string } = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: String(fallback.failureMessage ?? "").trim() || t("err.review_no_final_message"),
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const candidate = stripJsonFence(rawOutput);

  try {
    return {
      parsed: JSON.parse(candidate),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

/**
 * ```json ... ``` のフェンスや前後の散文を剥がして JSON 本体だけにする。
 * フェンスが無く JSON が単体で返っている場合はそのまま返す。
 */
function stripJsonFence(text) {
  const trimmed = String(text).trim();

  const opening = trimmed.indexOf("```");
  if (opening !== -1) {
    const contentStart = trimmed.indexOf("\n", opening + 3);
    if (contentStart !== -1) {
      const closing = trimmed.indexOf("\n```", contentStart + 1);
      if (closing !== -1) {
        return trimmed.slice(contentStart + 1, closing).trim();
      }
    }
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  // 前後に説明文が付いた場合に備え、最初の { から対応する最後の } までを拾う。
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// 許可判定は shell-allowlist.mjs へ移した。既存の公開名を grok.mjs からも保つ。
export { classifyShellCommand, resolveGrokBin };
