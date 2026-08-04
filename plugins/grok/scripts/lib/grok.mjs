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
 *
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").SessionUpdate} SessionUpdate
 * @typedef {import("./acp-protocol").StopReason} StopReason
 * @typedef {((update: string | { message: string, phase: string | null, sessionId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import {
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  GrokAcpClient,
  quoteIfNeeded,
  createAllowAllPermissionResponder,
  createReadOnlyPermissionResponder
} from "./acp.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const TASK_SESSION_PREFIX = "Grok Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

/**
 * レビューに使う既定モデル。
 *
 * API キー認証だと `session/new` の既定が `grok-4.20-0309-non-reasoning` になり、
 * 推論なしモデルではレビュー品質が落ちる。明示的に推論可能な最上位を指す。
 * 環境変数 GROK_PLUGIN_MODEL で上書きできる。
 */
const DEFAULT_REVIEW_MODEL = "grok-4.5";

/**
 * ツール名だけで書き込みと判定できるもの。
 *
 * シェル実行系（run_terminal_command 等）はここに入れない。レビュー中の Grok は
 * `git diff` や `git show` のような読み取り専用コマンドを普通に使うため、
 * 名前で一律に拒否するとレビューそのものが中断してしまう。
 * シェルは classifyShellCommand が中身を見て可否を決める。
 */
const MUTATING_TOOL_PATTERN = /(write|edit|create|delete|remove|rename|patch|apply_|multi_edit|str_replace)/i;

/**
 * 読み取り専用として許可するコマンド。
 * git はサブコマンドまで見て、履歴や作業ツリーを変えないものだけ通す。
 */
/**
 * 汎用インタプリタ（node / python など）は載せない。
 * `-e` や `-c` の引数一つで任意の書き込みができてしまい、
 * コマンド名だけでは読み取り専用を保証できないため。
 * 情報を取りたいときは Grok 自身のファイル読み取りツールを使わせる。
 */
const READ_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "type",
  "ls", "dir", "pwd", "find", "tree", "stat", "file", "wc",
  "rg", "grep", "egrep", "fgrep", "ack", "ag",
  "echo", "which", "where", "basename", "dirname", "realpath",
  "jq", "sort", "uniq", "cut", "awk", "sed", "tr", "diff"
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff", "show", "log", "status", "blame", "ls-files", "ls-tree", "rev-parse",
  "describe", "cat-file", "shortlog", "branch", "tag", "remote", "config", "grep", "whatchanged"
]);

/** ファイルへ書き出すリダイレクトと、その場編集を示す痕跡。 */
const WRITE_SIDE_EFFECT_PATTERN = /(^|\s)(>>?|\btee\b)(\s|$)|(^|\s)-i(\s|$)/;

/**
 * コマンド置換。`git log $(rm -rf .)` のように、許可コマンドの引数へ
 * 埋め込むだけで別のコマンドが先に走るため、中身を見ずに一律で拒否する。
 */
const COMMAND_SUBSTITUTION_PATTERN = /\$\(|\$\{|`/;

/**
 * 許可コマンドの中でも、引数次第でシェルへ抜けたり書き込んだりできるもの。
 * `git` と同じく、名前だけでなく引数まで見て判定する。
 */
const ARGUMENT_SENSITIVE_COMMANDS = new Map([
  // awk の system() / exec() / シェルへのパイプ、sed の e（実行）・w（書き出し）コマンド。
  ["awk", /\b(system|exec)\s*\(|\|\s*["']/],
  ["sed", /\b(system|exec)\s*\(|\|\s*["']|(^|[;{'"\s])[0-9,$~\/]*\s*[ewW](\s|$)/],
  // find は -exec / -delete で読み取り専用ではなくなる。
  ["find", /(^|\s)-(exec|execdir|ok|okdir|delete|fls|fprint|fprintf|fprint0)(\s|$)/]
]);

function cleanGrokStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s*(WARNING|warning): proceeding/.test(line))
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (typeof onProgress !== "function") {
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
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

/**
 * シェルコマンドが読み取り専用かどうかを判定する。
 *
 * `&&` `||` `;` `|` で区切った各セグメントの先頭コマンドを見て、すべてが
 * 許可リストに載っていて、かつファイルへの書き出しを含まない場合だけ許可する。
 * 判断できないものは拒否側に倒す。
 *
 * @returns {{ allowed: boolean, reason: string | null }}
 */
/**
 * コマンド行を語へ分ける。引用符で囲まれた部分は 1 語として扱う。
 * Windows の `"C:\Program Files\Git\bin\git.exe" diff` を素の空白分割で壊さないため。
 */
function tokenizeCommand(segment) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function classifyShellCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) {
    return { allowed: false, reason: "empty command" };
  }

  if (WRITE_SIDE_EFFECT_PATTERN.test(text)) {
    return { allowed: false, reason: "writes to a file or edits in place" };
  }

  // 置換の中身は先頭トークンの判定が届かないので、セグメント分割より前に弾く。
  if (COMMAND_SUBSTITUTION_PATTERN.test(text)) {
    return { allowed: false, reason: "uses command substitution" };
  }

  const segments = text.split(/\|\||&&|[;|]/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    // 環境変数の前置き（FOO=bar cmd）を読み飛ばす。
    const tokens = tokenizeCommand(segment).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    const head = (tokens[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    if (!head) {
      return { allowed: false, reason: `could not parse "${segment}"` };
    }

    if (head === "git") {
      const sub = (tokens[1] ?? "").toLowerCase();
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
        return { allowed: false, reason: `git ${sub || "(no subcommand)"} is not read-only` };
      }
      // `git config <key> <value>` は書き込みなので、読み取り形だけ通す。
      if (sub === "config" && tokens.length > 3 && !tokens.includes("--get") && !tokens.includes("--list")) {
        return { allowed: false, reason: "git config appears to set a value" };
      }
      continue;
    }

    if (!READ_ONLY_COMMANDS.has(head)) {
      return { allowed: false, reason: `${head} is not on the read-only allowlist` };
    }

    const sensitivePattern = ARGUMENT_SENSITIVE_COMMANDS.get(head);
    if (sensitivePattern && sensitivePattern.test(segment)) {
      return { allowed: false, reason: `${head} is being used in a way that can write or run other commands` };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * 権限要求を読み取り専用の観点で判定する。
 *
 * @returns {{ allowed: boolean, reason: string | null }}
 */
function classifyToolCall(params) {
  const call = params?.toolCall ?? {};
  const rawInput = call.rawInput ?? {};

  const command = typeof rawInput === "object" && rawInput ? rawInput.command ?? rawInput.cmd : null;
  if (typeof command === "string") {
    return classifyShellCommand(command);
  }

  const name = [call.title, call.kind].filter(Boolean).join(" ");
  if (MUTATING_TOOL_PATTERN.test(name)) {
    return { allowed: false, reason: "the tool modifies files" };
  }

  return { allowed: true, reason: null };
}

/**
 * 読み取り専用セッション用の権限応答器。
 *
 * ACP では読み取り系ツールがそもそも問い合わせてこない（実測: list_dir /
 * read_file は自動解決される）ので、ここへ届く時点で書き込みや外部実行の
 * 可能性が高い。書き込みと判定したものは拒否し、それ以外は 1 回だけ許可する。
 */
function createReviewPermissionHandler(onProgress) {
  const readOnly = createReadOnlyPermissionResponder();
  return (params) => {
    const verdict = classifyToolCall(params);
    if (verdict.allowed) {
      return readOnly(params);
    }

    emitProgress(
      onProgress,
      `Denied during read-only review (${verdict.reason}): ${shorten(params?.toolCall?.title ?? "unknown tool", 60)}`,
      "running"
    );

    const options = Array.isArray(params?.options) ? params.options : [];
    const reject = options.find((option) => ["reject_once", "reject_always"].includes(option?.kind));
    // reject_once を返せばモデルは別の手段へ切り替えられる。cancelled を返すと
    // ターンごと終了してしまうので、選べる拒否肢が無いときの最後の手段にする。
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
function createTurnCollector(sessionId, options = {}) {
  const state = {
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

  const handle = (message) => {
    const method = message?.method;

    // xAI 独自通知。使用量だけ拾い、他は無視する。
    if (method === "_x.ai/session_notification") {
      const update = message.params?.update;
      if (update?.sessionUpdate === "response_completed" && update.usage) {
        state.usage = update.usage;
      }
      return;
    }

    if (method !== "session/update") {
      return;
    }

    const update = message.params?.update;
    if (!update) {
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.text ?? "";
        state.agentMessage += text;
        return;
      }
      case "agent_thought_chunk": {
        state.reasoningBuffer += update.content?.text ?? "";
        return;
      }
      case "tool_call": {
        const title = update.title ?? update.toolCallId;
        state.toolCalls.set(update.toolCallId, { title, status: update.status ?? "pending" });
        emitProgress(state.onProgress, `Tool: ${shorten(title, 60)}`, "running", { sessionId });
        return;
      }
      case "tool_call_update": {
        const existing = state.toolCalls.get(update.toolCallId) ?? {};
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
            ? update.rawInput.command ?? update.rawInput.cmd ?? null
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
 *
 * ブローカーが他ジョブで埋まっている場合は、ブローカーを介さず
 * 直接 `grok agent stdio` を起動する経路へ落とす（本家と同じ考え方）。
 */
async function withGrok(cwd, handler, options = {}) {
  // 共有ブローカーを使わず、毎回自前で grok を起動する逃げ道。
  // ブローカー由来の不具合を切り分けるときと、プロセスの後始末を
  // 呼び出し側で完結させたいとき（統合テスト）に使う。
  const brokerDisabled =
    options.disableBroker || ["1", "true", "yes"].includes(String(process.env.GROK_COMPANION_DISABLE_BROKER ?? "").toLowerCase());

  let client;
  try {
    client = await GrokAcpClient.connect(cwd, { ...options, disableBroker: brokerDisabled });
  } catch (error) {
    if (error?.rpcCode === BROKER_BUSY_RPC_CODE) {
      client = await GrokAcpClient.connect(cwd, { ...options, disableBroker: true });
    } else {
      throw error;
    }
  }

  try {
    return await handler(client);
  } finally {
    await client.close();
  }
}

async function withDirectGrok(cwd, handler, options = {}) {
  return withGrok(cwd, handler, { ...options, disableBroker: true });
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
 * 再開したセッションへモデルと推論レベルを反映する。
 *
 * `session/load` の応答は `session/new` と違ってモデル一覧を含まない
 * （ACP v1 の LoadSessionResponse は modes と configOptions だけ）。
 * 現在値と比べられないので、要求された値をそのまま当てにいく。
 *
 * ここでの失敗は再開そのものを壊すべきではない。設定が当たらなくても
 * 元のセッションの値が残るだけで、続きを話すという目的は果たせる。
 */
async function applyResumedSessionSettings(client, response, options) {
  try {
    await applyRequestedModel(client, response, options);
  } catch (error) {
    emitProgress(
      options.onProgress,
      `Could not set model ${options.model} on the resumed session: ${error?.message ?? error}`,
      "starting"
    );
  }

  await applyRequestedEffort(client, response, options);
}

/**
 * セッションを開始し、必要ならモデルと推論レベルを差し替える。
 */
async function startSession(client, cwd, options = {}) {
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
async function runPrompt(client, sessionId, promptText, options = {}) {
  const collector = createTurnCollector(sessionId, { onProgress: options.onProgress });
  client.setNotificationHandler(collector.handle);

  let stopReason = null;
  let error = null;
  try {
    const response = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }]
    });
    stopReason = response?.stopReason ?? null;
  } catch (caught) {
    error = caught;
  } finally {
    client.setNotificationHandler(null);
  }

  collector.state.stopReason = stopReason;
  collector.finalize();
  return { ...collector.state, error };
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
      return turnState.agentMessage ? "completed" : "unknown";
  }
}

/** `grok` 実行ファイルの場所。GROK_BIN で上書きできる。 */
function resolveGrokBin(env = process.env) {
  if (env.GROK_BIN) {
    return env.GROK_BIN;
  }
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const bundled = path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return "grok";
}

export function getGrokAvailability(cwd) {
  const bin = resolveGrokBin();
  // Windows では cmd.exe 経由で起動する。`process.env.SHELL`（Git Bash）だと
  // パスのバックスラッシュがエスケープとして食われ、`.cmd` ラッパーも起動できない。
  const spawnOptions = { cwd, shell: process.platform === "win32" };
  const command = quoteIfNeeded(bin);

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

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  return {
    brokerEndpoint: endpoint,
    brokerActive: Boolean(endpoint)
  };
}

/**
 * 認証状態を調べる。
 *
 * Grok は XAI_API_KEY があればそれを優先し、無ければ `grok login` で保存した
 * ブラウザ資格情報を使う。ACP の initialize は未認証でも成功し、
 * `session/new` で初めて "Authentication required" になるため、
 * セッションを 1 本張ってみるところまでを確認手段にしている。
 */
export async function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    return { authenticated: false, reason: "grok-missing", availability };
  }

  const env = options.env ?? process.env;
  const usingApiKey = Boolean(env.XAI_API_KEY);

  try {
    return await withDirectGrok(
      cwd,
      async (client) => {
        const methods = client.initializeResult?.authMethods ?? [];
        try {
          const session = await client.request("session/new", { cwd, mcpServers: [] });
          return {
            authenticated: true,
            method: usingApiKey ? "api-key" : "browser-login",
            currentModelId: session.models?.currentModelId ?? null,
            availableModels: session.models?.availableModels?.map((model) => model.modelId) ?? [],
            agentVersion: client.initializeResult?._meta?.agentVersion ?? null,
            availability
          };
        } catch (error) {
          return {
            authenticated: false,
            reason: "not-authenticated",
            detail: error?.message ?? String(error),
            authMethods: methods.map((method) => method.id),
            availability
          };
        }
      },
      { grokBin: availability.bin, env }
    );
  } catch (error) {
    return { authenticated: false, reason: "connect-failed", detail: error?.message ?? String(error), availability };
  }
}

/**
 * 進行中の Grok ターンへ割り込む。
 *
 * ACP の `session/cancel` は notification なので応答は返らない。
 * `request` で送ると解決しない Promise を待ち続けるため `notify` を使う。
 *
 * ここは `/grok:cancel` の途中経路でしかないので、失敗しても投げずに
 * 結果として返す。投げてしまうと呼び出し側がプロセス停止とジョブ状態の
 * 確定まで進めず、止めたはずのジョブが走り続ける。
 */
export async function interruptGrokTurn(cwd, { sessionId }) {
  if (!sessionId) {
    return {
      attempted: false,
      interrupted: false,
      detail: "no Grok session was recorded for this job yet",
      sessionId: null
    };
  }

  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    return { attempted: false, interrupted: false, detail: grokMissingMessage(availability), sessionId };
  }

  try {
    await withGrok(
      cwd,
      async (client) => {
        client.notify("session/cancel", { sessionId });
      },
      { grokBin: availability.bin, reuseExistingBroker: true }
    );
    return { attempted: true, interrupted: true, detail: null, sessionId };
  } catch (error) {
    return { attempted: true, interrupted: false, detail: error?.message ?? String(error), sessionId };
  }
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
export async function runGrokReview(cwd, options = {}) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }

  const model = options.model ?? process.env.GROK_PLUGIN_MODEL ?? DEFAULT_REVIEW_MODEL;

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

      client.setPermissionHandler(createReviewPermissionHandler(options.onProgress));

      const promptText = buildReviewPrompt(options);
      let turnState = await runPrompt(client, sessionId, promptText, { onProgress: options.onProgress });
      let repaired = false;

      // 構造化出力を要求したのに壊れた JSON が返った場合、同じセッションで
      // 1 回だけ訂正させる。調べ直しは不要で、直すのは JSON の形だけ。
      if (options.outputSchema && !turnState.error && turnState.agentMessage) {
        const attempt = parseStructuredOutput(turnState.agentMessage);
        if (attempt.parseError) {
          emitProgress(options.onProgress, "Grok returned malformed JSON; asking it to re-emit.", "running", {
            sessionId
          });
          const retry = await runPrompt(
            client,
            sessionId,
            buildJsonRepairPrompt(attempt.parseError, options.outputSchema),
            { onProgress: options.onProgress }
          );
          if (!retry.error && retry.agentMessage && !parseStructuredOutput(retry.agentMessage).parseError) {
            // 訂正が通ったときだけ差し替える。思考サマリは初回のものを残す。
            turnState = { ...retry, reasoning: turnState.reasoning };
            repaired = true;
          }
        }
      }

      return {
        jsonRepaired: repaired,
        status: buildResultStatus(turnState),
        sessionId,
        model: session.effectiveModel ?? model,
        reviewText: turnState.agentMessage,
        reasoningSummary: turnState.reasoning,
        stopReason: turnState.stopReason,
        usage: turnState.usage,
        error: turnState.error,
        stderr: cleanGrokStderr(client.stderr)
      };
    },
    { grokBin: availability.bin, env: options.env }
  );
}

/**
 * レビュー用のプロンプトを組み立てる。
 *
 * Grok は `review/start` の target でレビュー対象（diff / commit / ブランチ）を
 * 指定できたが、Grok にはその概念が無いので、対象の説明と収集済みの diff を
 * 文章として渡す。
 */
function buildReviewPrompt(options = {}) {
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
      "- Do not modify any file, run any command, or write anything to disk. This is a read-only review.\n" +
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
export async function runGrokTurn(cwd, options = {}) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const model = options.model ?? process.env.GROK_PLUGIN_MODEL ?? DEFAULT_REVIEW_MODEL;

  return withGrok(
    cwd,
    async (client) => {
      let sessionId;

      // session/load はエージェントが loadSession capability を宣言した
      // ときだけ使える。未対応の相手には投げずに新規セッションへ落とす。
      const canLoadSession = client.initializeResult?.agentCapabilities?.loadSession === true;

      if (options.resumeSessionId && !canLoadSession) {
        emitProgress(
          options.onProgress,
          "This Grok build cannot resume sessions; starting a fresh one instead.",
          "starting"
        );
      }

      if (options.resumeSessionId && canLoadSession) {
        emitProgress(options.onProgress, `Resuming session ${options.resumeSessionId}.`, "starting");
        const loaded = await client.request("session/load", {
          sessionId: options.resumeSessionId,
          cwd,
          mcpServers: options.mcpServers ?? []
        });
        sessionId = options.resumeSessionId;

        // 再開だと startSession を通らないため、以前は --model と --effort が
        // 黙って無視されていた。読み込んだセッションにも同じ設定を当てる。
        await applyResumedSessionSettings(
          client,
          { ...loaded, sessionId },
          { model, effort: options.effort, onProgress: options.onProgress }
        );
      } else {
        emitProgress(options.onProgress, "Starting Grok task session.", "starting");
        const session = await startSession(client, cwd, {
          model,
          effort: options.effort,
          onProgress: options.onProgress,
          mcpServers: options.mcpServers ?? []
        });
        sessionId = session.sessionId;
      }

      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

      client.setPermissionHandler(
        options.readOnly ? createReviewPermissionHandler(options.onProgress) : createAllowAllPermissionResponder()
      );

      const promptText = options.outputSchema
        ? `${prompt}\n\n## Required output\nReply with a single JSON object and nothing else. It must validate against this JSON Schema:\n\n${JSON.stringify(options.outputSchema, null, 2)}`
        : prompt;

      const turnState = await runPrompt(client, sessionId, promptText, { onProgress: options.onProgress });

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
        reasoningSummary: turnState.reasoning,
        stopReason: turnState.stopReason,
        usage: turnState.usage,
        error: turnState.error,
        stderr: cleanGrokStderr(client.stderr),
        touchedFiles: [...turnState.touchedFiles],
        commandExecutions: turnState.commandExecutions
      };
    },
    { grokBin: availability.bin, env: options.env }
  );
}

/**
 * 直近の委任タスク用セッションを探す。`/grok:rescue` の再開先に使う。
 */
export async function findLatestTaskSession(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }

  return withGrok(
    cwd,
    async (client) => {
      if (!client.initializeResult?.agentCapabilities?.sessionCapabilities?.list) {
        return null;
      }
      const response = await client.request("session/list", { cwd, limit: 20 });
      const sessions = response?.sessions ?? [];
      return (
        sessions.find((session) => typeof session.title === "string" && session.title.startsWith(TASK_SESSION_PREFIX)) ??
        null
      );
    },
    { grokBin: availability.bin, reuseExistingBroker: true }
  );
}

export function buildPersistentTaskSessionName(prompt) {
  return buildTaskSessionName(prompt);
}

/**
 * 構造化出力を取り出す。
 *
 * Grok は outputSchema でモデルを制約できたが、ACP の session/prompt には
 * その口が無くプロンプトでの依頼になるため、コードフェンス付きで返ってくる
 * ケースを剥がしてから JSON.parse する。
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
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

  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    return fenced[1].trim();
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

export { DEFAULT_CONTINUE_PROMPT, TASK_SESSION_PREFIX, resolveGrokBin, stripJsonFence };
