import type { AcpClientOptions, AcpNotification, SessionUpdateNotification, StopReason } from "./acp-protocol.js";
type ProgressUpdate = { message: string; phase: string | null; sessionId?: string | null; grokSessionId?: string | null; logTitle?: string | null; logBody?: string | null };
type ProgressReporter = (update: string | ProgressUpdate) => void;
interface GrokOptions {
  grokBin?: string;
  onStderr?: (chunk: string) => void;
  diff?: string;
  effort?: string;
  env?: NodeJS.ProcessEnv;
  instructions?: string;
  logBody?: string;
  logTitle?: string;
  mcpServers?: unknown[];
  message?: string;
  model?: string;
  onProgress?: ProgressReporter;
  permissionHandler?: AcpClientOptions["permissionHandler"];
  onWriteDenied?: (reason: string) => void;
  outputSchema?: unknown;
  phase?: string;
  prompt?: string;
  readOnly?: boolean;
  targetDescription?: string;
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
 *   - Codex には `review/start` という専用 API があったが、Grok には無い。
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
import { shortenText } from "./text.mjs";


/**
 * レビューに使う既定モデル。
 *
 * API キー認証だと `session/new` の既定が `grok-4.20-0309-non-reasoning` になり、
 * 推論なしモデルではレビュー品質が落ちる。明示的に推論可能な最上位を指す。
 * 環境変数 GROK_PLUGIN_MODEL で上書きできる。
 */
const DEFAULT_REVIEW_MODEL = "grok-4.7";

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
  // job保存用の正規キーへそろえる。sessionIdは既存callbackとの互換用に残す。
  onProgress({ message, phase, ...extra, ...(extra.sessionId ? { grokSessionId: extra.sessionId } : {}) });
}

function emitLogEvent(onProgress, options: GrokOptions = {}) {
  if (typeof onProgress !== "function") {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

/** 権限要求を読み取り専用の観点で判定する。 */
function classifyToolCall(params, cwd): { allowed: boolean; reason: string | null } {
  const call = params?.toolCall ?? {};
  const rawInput = call.rawInput ?? {};

  // Grok 組み込み WebFetch は URL の内容だけを返す。表示名や read_only フラグだけでは許可しない。
  if (call.kind === "fetch" && rawInput?.variant === "WebFetch") {
    if (Object.keys(rawInput).some((key) => !["variant", "url"].includes(key)) ||
        typeof rawInput.url !== "string") {
      return { allowed: false, reason: "WebFetch requires only a URL" };
    }
    try {
      const url = new URL(rawInput.url);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
        return { allowed: true, reason: null };
      }
    } catch {
      // 不正な URL は許可しない。
    }
    return { allowed: false, reason: "WebFetch requires an HTTP(S) URL without credentials" };
  }

  const command = typeof rawInput === "object" && rawInput ? rawInput.command ?? rawInput.cmd : null;
  if (typeof command === "string") {
    return classifyShellCommand(command, cwd);
  }

  const name = [call.title, call.kind].filter(Boolean).join(" ");
  if (MUTATING_TOOL_PATTERN.test(name)) {
    return { allowed: false, reason: "the tool modifies files" };
  }

  return { allowed: false, reason: "the tool is not explicitly known to be read-only" };
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
  return (params) => {
    const verdict = classifyToolCall(params, cwd);
    const permissionOptions = Array.isArray(params?.options) ? params.options : [];
    if (verdict.allowed && permissionOptions.some((option) => option?.kind === "allow_once")) {
      return readOnly(params);
    }

    const reason = verdict.reason ?? "no one-time read-only permission option is available";
    const denial = `${reason}: ${shortenText(params?.toolCall?.title ?? "unknown tool", 60)}`;
    onDenied(denial);
    emitProgress(
      onProgress,
      `Denied during read-only review (${reason}): ${shortenText(params?.toolCall?.title ?? "unknown tool", 60)}`,
      "running"
    );

    const options = Array.isArray(params?.options) ? params.options : [];
    const reject = options.find((option) => ["reject_once", "reject_always"].includes(option?.kind));
    // 拒否肢があれば選ぶ。ただし Grok Build は選択による拒否でも
    // permission_rejected としてターンを終了することがある。
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };
}

/**
 * ターン中に流れてくる session/update を集約する。
 *
 * Grok 版の TurnCaptureState に相当するが、完了判定を stopReason に委ねられる
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
      throw Object.assign(new Error("Direct Grok agent stop could not be confirmed."), { turnStopUnconfirmed: true });
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
    return { applied: false, value: null, reason: detail };
  }

  if (option.currentValue !== value) {
    await client.request("session/set_config_option", { sessionId, configId: option.id, value });
  }
  return { applied: true, value, reason: null };
}

/**
 * 要求されたモデルへ差し替え、実効モデルを返す。
 *
 * `session/new` の既定モデルは認証方式によって変わる（API キーだと
 * 推論なしモデルになる）ため、現在値と違えば明示的に合わせる。
 * ACP v1 は `session/set_model` を廃止して `session/set_config_option` へ
 * 統合したので、旧 RPC を先に試し method not found のときだけ新経路へ落ちる。
 */
async function applyRequestedModel(client, response, options) {
  const requested = options.model ?? null;
  const current = response.models?.currentModelId ?? null;

  if (!requested || requested === current) {
    return current;
  }

  const available = response.models?.availableModels?.map((model) => model.modelId) ?? [];
  if (available.length && !available.includes(requested)) {
    emitProgress(
      options.onProgress,
      `Model ${requested} is not available; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return current;
  }

  try {
    await client.request("session/set_model", { sessionId: response.sessionId, modelId: requested });
    emitProgress(options.onProgress, `Model set to ${requested}.`, "starting");
    return requested;
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
    return current;
  }

  const result = await applySessionConfigOption(client, response.sessionId, option, requested);
  if (!result.applied) {
    emitProgress(
      options.onProgress,
      `Model ${requested} is ${result.reason}; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return current;
  }

  emitProgress(options.onProgress, `Model set to ${result.value}.`, "starting");
  return result.value;
}

/**
 * 要求された推論レベルを反映する。
 * ACP に専用 RPC は無く、`thought_level` カテゴリの設定項目として扱う。
 * 反映可否は本題（レビューや委任タスク）の成否と無関係なので、
 * 失敗しても turn を止めず理由だけ進捗へ流す。
 */
async function applyRequestedEffort(client, response, options) {
  const requested = options.effort ?? null;
  if (!requested) {
    return null;
  }

  const option = findSessionConfigOption(response, "thought_level");
  if (!option) {
    emitProgress(
      options.onProgress,
      `This Grok build exposes no reasoning effort selector; --effort ${requested} was not applied.`,
      "starting"
    );
    return null;
  }

  try {
    const result = await applySessionConfigOption(client, response.sessionId, option, requested);
    if (!result.applied) {
      emitProgress(
        options.onProgress,
        `Reasoning effort ${requested} is ${result.reason}; leaving it unchanged.`,
        "starting"
      );
      return null;
    }
    emitProgress(options.onProgress, `Reasoning effort set to ${result.value}.`, "starting");
    return result.value;
  } catch (error) {
    emitProgress(
      options.onProgress,
      `Could not set reasoning effort ${requested}: ${error?.message ?? error}`,
      "starting"
    );
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
  const effectiveModel = await applyRequestedModel(client, response, options);
  const effectiveEffort = await applyRequestedEffort(client, response, options);

  return { ...response, effectiveModel, effectiveEffort };
}

/**
 * プロンプトを 1 ターン実行し、流れてきた更新を集約して返す。
 */
async function runPrompt(client, sessionId, promptText, options: GrokOptions = {}) {
  const collector = createTurnCollector(sessionId, { onProgress: options.onProgress });
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
      throw Object.assign(new Error("The prompt response could not be verified against the issued request."), { turnStopUnconfirmed: true });
    }
    stopReason = evidence.stopReason;
    if (typeof stopReason !== "string" || !["end_turn", "cancelled", "refusal", "max_tokens", "max_turn_requests"].includes(stopReason)) {
      throw Object.assign(new Error("The prompt response did not contain a recognized terminal reason."), { turnStopUnconfirmed: true });
    }
  } catch (caught) {
    originalFailure = caught;
    error = caught instanceof Error ? caught : new Error("The prompt failed with a non-Error value.", { cause: caught });
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

/** 明示指定、環境変数 GROK_PLUGIN_MODEL、既定モデルの順で実行モデルを決める。 */
function resolveRunModel(options: GrokOptions, env: NodeJS.ProcessEnv) {
  return options.model ?? env.GROK_PLUGIN_MODEL ?? DEFAULT_REVIEW_MODEL;
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

function grokMissingMessage(availability) {
  if (availability?.reason === "missing-agent-stdio") {
    return "This Grok Build version does not expose `grok agent stdio`. Update it with `grok update`, then rerun `/grok:setup`.";
  }
  return "Grok Build is not installed. Install it with `irm https://x.ai/cli/install.ps1 | iex` (Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`, then rerun `/grok:setup`.";
}

/**
 * 読み取り専用のコードレビューを実行する。
 *
 * Grok の `review/start` に相当する専用 API が Grok には無いため、
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
          // 初回 prompt は送信・終端済みなので、repair の未送信を job 全体の未送信にしない。
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
        model: session.effectiveModel ?? model,
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
 * レビュー用のプロンプトを組み立てる。
 *
 * Grok は `review/start` の target でレビュー対象（diff / commit / ブランチ）を
 * 指定できたが、Grok にはその概念が無いので、対象の説明と収集済みの diff を
 * 文章として渡す。
 */
function buildReviewPrompt(options: GrokOptions = {}) {
  const parts = [];
  parts.push(options.instructions?.trim() || "Review the code in this repository for defects.");

  if (options.targetDescription) {
    parts.push(`\n## Review target\n${options.targetDescription}`);
  }
  if (options.diff) {
    parts.push(`\n## Diff under review\n\n\`\`\`diff\n${options.diff}\n\`\`\``);
  }

  parts.push(
    "\n## Ground rules\n" +
      "- Read whatever files you need from the working tree to judge the change in context.\n" +
      "- Prefer your built-in file-reading tools (read_file, list_dir, and grep). Simple read-only repository commands such as rg are also available. Do not modify files or run commands with side effects.\n" +
      "- The shell uses a command allowlist, not a judgment of whether a script looks read-only. Do not run Python (python/python3/py), Node.js, Bun, other interpreters, or shell wrappers (powershell/pwsh/bash/sh/cmd), including inline scripts with -c, -e, or -Command. Read JSON and verification evidence with read_file and inspect the returned text directly. For multiline files, read_file offset/limit select lines; they cannot split a single long line. If you cannot fully inspect the required content, report that evidence as unverified. Do not run a script to extract or summarize fields.\n" +
      "- Plain shell command names available for read-only inspection are: " + [...READ_ONLY_COMMANDS].join(", ") + ". Their arguments still undergo the read-only checks below. Git and Test-Path have separate restricted forms. If a command is unavailable on this OS, use built-in file tools instead of wrapping it in another shell. ACP file requests must stay within the repository; report evidence you cannot access as unverified.\n" +
      "- Every Git command must start with: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + ". Then use a supported read-only subcommand. For diff, log, show and whatchanged, put --no-ext-diff and --no-textconv immediately after the subcommand as its first two arguments (either order), before any other option, revision or -- path separator. Status and blame are denied. Diff must put --cached or --staged immediately after those two guards, or use an exact 40-digit SHA-1 OID..OID or 64-digit SHA-256 OID..OID there. For fixed ranges, only supported display flags may follow; put paths after -- and do not add revisions or use HEAD/branch names. Use the fixed comparison from collection guidance. Grep requires --cached first; --no-index and modified ls-files checks are denied. These flags suppress textconv/external diff; they do not establish an OS sandbox. Example: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " diff --no-ext-diff --no-textconv --cached --stat. Use complete option names supported by that specific subcommand and separate short options; options from another subcommand, unknown options, custom pretty formats and --submodule=diff are denied. For example, grep --cached --text is supported, but cat-file --text is denied; use cat-file -p to read an object. Use file tools if a command is unsupported.\n" +
      "- For recent commit history, use --since=YYYY-MM-DD with git log and --oneline, not a custom percent-based format. Example: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " log --no-ext-diff --no-textconv --since=2026-09-28 --oneline. Replace the example date with the requested starting date.\n" +
      "- Avoid PowerShell script blocks and variables, unquoted parentheses or leading @ (quote search patterns that contain parentheses), command substitution, backticks, redirection, and executable paths: the read-only shell policy rejects these even in a read-only command.\n" +
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

/**
 * 任意のタスクを Grok に委任して 1 ターン実行する。
 * 書き込みを許すかどうかは options.readOnly で切り替える。
 */
export async function runGrokTurn(cwd, options: GrokOptions = {}) {
  const env = options.env ?? process.env;
  const availability = requireGrokAvailability(cwd, env);

  const prompt = options.prompt?.trim() || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const model = resolveRunModel(options, env);
  const { permissionDenials, onDenied } = createPermissionDenialLog();

  return withGrok(
    cwd,
    async (client) => {
      emitProgress(options.onProgress, "Starting Grok task session.", "starting");
      const session = await startSession(client, cwd, { model, effort: options.effort, onProgress: options.onProgress, mcpServers: [] });
      const sessionId = session.sessionId;

      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

      if (!options.readOnly) {
        client.setWriteDeniedHandler(onDenied);
        client.setPermissionHandler(createAllowAllPermissionResponder());
      }

      const turnState = await runPrompt(client, sessionId, prompt, { onProgress: options.onProgress });

      emitLogEvent(options.onProgress, {
        phase: "completed",
        logTitle: turnState.title ?? null,
        logBody: null
      });

      return {
        status: buildResultStatus(turnState),
        sessionId,
        model,
        finalMessage: turnState.agentMessage,
        permissionDenials,
        reasoningSummary: turnState.reasoning,
        stopReason: turnState.stopReason,
        usage: turnState.usage,
        error: turnState.error,
        turnStopUnconfirmed: turnState.turnStopUnconfirmed,
        promptNotSent: turnState.promptNotSent,
        stderr: cleanGrokStderr(client.stderr),
        touchedFiles: [...turnState.touchedFiles],
        commandExecutions: turnState.commandExecutions
      };
    },
    { grokBin: availability.bin, env, readOnly: Boolean(options.readOnly),
      ...(options.readOnly ? { permissionHandler: createReviewPermissionHandler(cwd, options.onProgress, onDenied), onWriteDenied: onDenied } : {}) }
  );
}

/**
 * 応答本文から構造化レビューの JSON を取り出し、解析結果または失敗情報を返す。
 */
export function parseStructuredOutput(rawOutput, fallback: { failureMessage?: string; status?: string; stopReason?: string; error?: string } = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: String(fallback.failureMessage ?? "").trim() || "Grok did not return a final structured message.",
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
