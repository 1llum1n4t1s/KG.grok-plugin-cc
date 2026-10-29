/**
 * Grok Build の `grok agent stdio` が話す ACP (Agent Client Protocol) クライアント。
 *
 * 本家 codex-plugin-cc の app-server.mjs（Codex 独自 JSON-RPC）を置き換えたもの。
 * JSON-RPC のフレーミングと保留リクエスト管理は本家の構造をそのまま引き継ぎ、
 * 以下の ACP 固有の差分を足している。
 *
 *   1. initialize のパラメータが {protocolVersion, clientCapabilities} である
 *   2. ACP には `initialized` 通知がない（LSP 由来の作法を持たない）
 *   3. agent → client 方向のリクエストが実在する
 *      （session/request_permission, fs/read_text_file, fs/write_text_file）
 *      本家 Codex 版はここを一律 -32601 で突き返していたが、ACP では応答しないと
 *      エージェントの実行が止まるため、ハンドラを差し込めるようにしている。
 *
 * @typedef {Error & { data?: unknown, rpcCode?: number, rpcResponseReceived?: boolean }} ProtocolError
 * @typedef {import("./acp-protocol").AcpMethod} AcpMethod
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").AcpNotificationHandler} AcpNotificationHandler
 * @typedef {import("./acp-protocol").ClientInfo} ClientInfo
 * @typedef {import("./acp-protocol").AcpClientOptions} AcpClientOptions
 * @typedef {import("./acp-protocol").ClientCapabilities} ClientCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession, reserveDirectAdmission, reserveManagedBroker, inspectManagedBrokerForCancel, authorizeBrokerChild, verifyBrokerEpoch, findExplicitManagedSession } from "./broker-lifecycle.mjs";
import { finishDirectStart, verifyDirectStart, verifyDirectStartWithinContext } from "./direct-start-admission.mjs";
import { spawnWindowsAgent } from "./windows-agent.mjs";
import { JsonlFramer } from "./jsonl.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.codex-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "GROK_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const BROKER_CAPACITY_RPC_CODE = -32003;
// callback に渡った Error や data の後続変更から、受信時の未転送証拠を守る。
const brokerUnsentRejections = new WeakMap();
const promptFailureEvidence = new WeakMap();
const promptSuccessEvidence = new WeakMap();
const BROKER_UNSENT_METHODS = new Set(["session/new", "session/set_model", "session/set_config_option", "session/set_mode", "session/prompt"]);

/** 実際に同じ broker client が受信した未転送応答だけを返す。 */
export function getBrokerUnsentRejection(error, client) {
  if (!error || typeof error !== "object") return null;
  const record = brokerUnsentRejections.get(error);
  return record && record.client === client ? record.evidence : null;
}

/** 実際の prompt RPC 応答を受けた時点の停止・未送信証拠を返す。 */
export function getAcpPromptFailureEvidence(error, client) {
  if (!error || typeof error !== "object") return null;
  const record = promptFailureEvidence.get(error);
  return record && record.client === client ? record.evidence : null;
}

/** 実際の prompt RPC 成功応答と、受信時の終了理由を返す。 */
export function getAcpPromptSuccessEvidence(response, client) {
  if (!response || typeof response !== "object") return null;
  const record = promptSuccessEvidence.get(response);
  return record && record.client === client ? record.evidence : null;
}
/** ブローカーがエージェントの stderr を中継するときの通知メソッド。 */
export const BROKER_AGENT_STDERR_METHOD = "broker/agent_stderr";

/** ACP のプロトコル版。grok 0.2.x は 1 を返す。 */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * ブローカーへ接続して initialize が返るまでの上限。
 *
 * 状態ファイルに記録済みのブローカーは、生きてさえいれば再利用される。
 * ここで古い版や別プロトコルのブローカーを掴むと、応答が返らないまま
 * 永久に待ち続けてしまうため、時間で見切って直接起動へ落とす。
 */
const BROKER_HANDSHAKE_TIMEOUT_MS = 10_000;
const DIRECT_HANDSHAKE_TIMEOUT_MS = 10_000;
const CONTROL_RPC_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 1_000;
// 長寿命の共有プロセスでも、直近の診断だけを最大64K UTF-16コード単位で保持する。
const STDERR_RETENTION_LIMIT = 65_536;

/** callback / transport 由来の例外を、agent の RPC 応答証拠と混同しない。 */
function normalizeTransportError(value) {
  try {
    const candidate = /** @type {any} */ (value);
    const error = new Error(value instanceof Error ? value.message : String(value), { cause: value });
    const code = candidate?.code;
    if (typeof code === "string" || typeof code === "number") /** @type {any} */ (error).code = code;
    return error;
  } catch {
    return new Error("Grok ACP transport failure.", { cause: value });
  }
}

/** direct 起動の元値を維持しながら broker 側の失敗も記録する。 */
function attachBrokerFailure(value, brokerError) {
  try {
    if (value instanceof Error && !("brokerError" in value)) {
      if ("cause" in value) {
        /** @type {any} */ (value).brokerError = brokerError;
        if (/** @type {any} */ (value).brokerError === brokerError) return value;
      } else {
        value.cause = brokerError;
        if (value.cause === brokerError) return value;
      }
    }
  } catch { /* 変更できない Error は元値を cause として包む。 */ }
  let message = "Direct Grok agent initialization failed.";
  try { if (value instanceof Error && typeof value.message === "string") message = value.message; } catch { /* 固定メッセージを使う。 */ }
  const wrapped = new Error(message, { cause: value });
  /** @type {any} */ (wrapped).brokerError = brokerError;
  try {
    const candidate = /** @type {any} */ (value);
    const code = candidate?.code;
    if (typeof code === "string" || typeof code === "number") /** @type {any} */ (wrapped).code = code;
    if (candidate?.turnStopUnconfirmed === true) /** @type {any} */ (wrapped).turnStopUnconfirmed = true;
  } catch { /* 元値を触れない場合も cause を維持する。 */ }
  return wrapped;
}

function waitForExitWithTimeout(exitPromise, timeoutMs = CLOSE_TIMEOUT_MS) {
  return Promise.race([
    exitPromise,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    })
  ]);
}

class HandshakeTimeoutError extends Error {
  constructor(ms) {
    super(`Grok broker did not complete the ACP handshake within ${ms}ms.`);
    this.name = "HandshakeTimeoutError";
  }
}

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  name: "Claude Code",
  title: "Grok Plugin",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/**
 * 既定のクライアント能力。
 *
 * fs.readTextFile / writeTextFile を false で申告すると、Grok は自前の
 * ファイルツールで読み書きするため、こちら側へファイル I/O の逆リクエストが
 * 飛んでこない。レビュー用途では Grok に直接読ませたいので false を既定にする。
 * 呼び出し側が true にした場合は handleServerRequest が実ファイルを扱う。
 *
 * @type {ClientCapabilities}
 */
const DEFAULT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
};

/**
 * shell 経由で起動するとき、空白を含むパスが複数の引数に割れないよう囲う。
 * すでに囲われている場合と、空白が無い場合はそのまま返す。
 */
export function quoteIfNeeded(command) {
  const value = String(command ?? "");
  if (!/\s/.test(value) || /^".*"$/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

/**
 * 権限要求へ「読み取り専用なら許可、それ以外は拒否」で答える既定ハンドラ。
 *
 * ACP の options は [{optionId, name, kind}] の配列で、kind は
 * allow_once / allow_always / reject_once / reject_always のいずれか。
 * レビュー用途では書き込みを通したくないので、既定は allow_once だけを拾い、
 * 該当がなければ reject_once へ落とす。
 */
export function createReadOnlyPermissionResponder({ allowKinds = ["allow_once"] } = {}) {
  return (params) => {
    const options = Array.isArray(params?.options) ? params.options : [];
    const pick = (kinds) => options.find((option) => kinds.includes(option?.kind));
    const allowed = pick(allowKinds);
    if (allowed) {
      return { outcome: { outcome: "selected", optionId: allowed.optionId } };
    }
    const rejected = pick(["reject_once", "reject_always"]);
    if (rejected) {
      return { outcome: { outcome: "selected", optionId: rejected.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  };
}

/**
 * すべての権限要求を許可する応答器。書き込みを伴う委任ジョブ用。
 */
export function createAllowAllPermissionResponder() {
  return createReadOnlyPermissionResponder({
    allowKinds: ["allow_always", "allow_once"]
  });
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.closeStopUnconfirmed = false;
    this.exitError = null;
    /** @type {AcpNotificationHandler | null} */
    this.notificationHandler = null;
    /** @type {((params: unknown) => unknown) | null} */
    this.permissionHandler = options.permissionHandler ?? null;
    this.writeDeniedHandler = null;
    /**
     * agent → client リクエストを丸ごと横取りするハンドラ。
     * ブローカーが「自分では処理せず接続元のクライアントへ転送する」ために使う。
     * 設定されている場合、応答を返す責任はハンドラ側にある。
     * @type {((message: unknown) => void) | null}
     */
    this.agentRequestHandler = options.agentRequestHandler ?? null;
    this.framer = new JsonlFramer((line) => this.handleLine(line));
    this.transport = "unknown";
    /** initialize の応答。モデル一覧や capabilities の確認に使う。 */
    this.initializeResult = null;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setPermissionHandler(handler) {
    this.permissionHandler = handler;
  }

  setWriteDeniedHandler(handler) {
    this.writeDeniedHandler = handler;
  }

  setAgentRequestHandler(handler) {
    this.agentRequestHandler = handler;
  }

  /**
   * agent → client リクエストへ生の JSON-RPC 応答を返す。ブローカーの中継用。
   *
   * @param {number | string} id
   * @param {{ result?: unknown, error?: unknown }} [response]
   */
  respondToAgent(id, response = {}) {
    if (this.closed) return;
    const { result, error } = response;
    this.sendMessage(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result: result ?? {} });
  }

  /**
   * @template {AcpMethod} M
   * @param {M} method
   * @param {import("./acp-protocol").AcpRequestParams<M>} params
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import("./acp-protocol").AcpResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed) {
      throw new Error("grok agent stdio client is closed.");
    }
    const signal = options.signal;
    if (signal?.aborted) throw signal.reason ?? new Error("Grok ACP request was aborted.");

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutMs = method === "session/prompt" ? 0 : (this.options.rpcTimeoutMs ?? CONTROL_RPC_TIMEOUT_MS);
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            pending?.reject(new Error(`Grok ACP ${method} timed out after ${timeoutMs}ms.`));
          }, timeoutMs)
        : null;
      timer?.unref?.();
      const abort = () => {
        this.pending.delete(id);
        pending.reject(signal.reason ?? new Error("Grok ACP request was aborted."));
      };
      const pending = {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        method
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.sendMessage({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        pending.reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk) {
    if (this.closed) return;
    try {
      this.framer.push(chunk);
    } catch (error) {
      // 通知処理の I/O 失敗も接続を閉じ、未完了の要求へ元の原因を返す。
      this.handleExit(error, true);
    }
  }

  appendStderr(chunk) {
    const tail = chunk.length >= STDERR_RETENTION_LIMIT
      ? chunk.slice(-STDERR_RETENTION_LIMIT)
      : (this.stderr + chunk).slice(-STDERR_RETENTION_LIMIT);
    // 切断位置がサロゲートペアの途中なら、不完全な先頭だけを除く。
    const first = tail.charCodeAt(0);
    this.stderr = first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
  }

  handleLine(line) {
    if (this.closed) return;
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse grok agent JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        const error = createProtocolError(message.error.message ?? `grok ${pending.method} failed.`, message.error);
        error.rpcResponseReceived = true;
        const code = message.error.code, data = message.error.data;
        if (this.transport === "broker" && BROKER_UNSENT_METHODS.has(pending.method) &&
            data?.source === "grok-broker" && data?.promptForwarded === false &&
            (code === BROKER_BUSY_RPC_CODE || (code === BROKER_CAPACITY_RPC_CODE && pending.method === "session/prompt"))) {
          brokerUnsentRejections.set(error, { client: this, evidence: Object.freeze({
            method: pending.method, reason: code === BROKER_BUSY_RPC_CODE ? "busy" : "capacity", requestId: message.id
          }) });
        }
        if (pending.method === "session/prompt") {
          const cancelledBeforeSend = this.transport === "broker" && code === -32002 &&
            data?.source === "grok-broker" && data?.promptForwarded === false && data?.reason === "cancelled";
          const terminal = this.transport === "direct" ? "confirmed"
            : this.transport === "broker" && (brokerUnsentRejections.has(error) || cancelledBeforeSend) ? "not-sent"
            : this.transport === "broker" && data?.turnStopConfirmed === true ? "confirmed"
            : "unconfirmed";
          promptFailureEvidence.set(error, { client: this, evidence: Object.freeze({ method: pending.method, requestId: message.id, terminal }) });
        }
        pending.reject(error);
      } else {
        const result = message.result ?? {};
        if (pending.method === "session/prompt" && result && typeof result === "object" && !Array.isArray(result)) {
          promptSuccessEvidence.set(result, { client: this, evidence: Object.freeze({
            method: pending.method, requestId: message.id, stopReason: typeof result.stopReason === "string" ? result.stopReason : null
          }) });
        }
        pending.resolve(result);
      }
      return;
    }

    // ブローカーが中継してくるエージェントの stderr。直接起動と同じように
    // client.stderr へ溜め、失敗時の診断がどちらの経路でも同じ内容になるようにする。
    if (message.method === BROKER_AGENT_STDERR_METHOD) {
      this.appendStderr(String(message.params?.chunk ?? ""));
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AcpNotification} */ (message));
    }
  }

  /**
   * agent → client 方向のリクエストに応答する。
   *
   * ACP ではエージェントが権限確認とファイル I/O をクライアントへ問い合わせる。
   * 応答しないとエージェント側のターンが待ち続けて固まるため、
   * 未対応メソッドにも必ずエラー応答を返して打ち切る。
   */
  handleServerRequest(message) {
    if (this.closed) return;
    // 転送ハンドラが刺さっている場合は、判断ごと委ねて何も応答しない。
    if (this.agentRequestHandler) {
      this.agentRequestHandler(message);
      return;
    }

    const respond = (result) => {
      this.sendMessage({ jsonrpc: "2.0", id: message.id, result });
    };
    const fail = (code, text) => {
      this.sendMessage({ jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(code, text) });
    };

    try {
      switch (message.method) {
        case "session/request_permission": {
          const handler = this.permissionHandler ?? createReadOnlyPermissionResponder();
          respond(handler(message.params));
          return;
        }
        case "fs/read_text_file": {
          const resolved = this.resolveWorkspacePath(message.params?.path);
          if (!resolved) {
            fail(-32602, "Path escapes the session workspace.");
            return;
          }
          let content = fs.readFileSync(resolved, "utf8");
          const line = message.params?.line;
          const limit = message.params?.limit;
          if (typeof line === "number" || typeof limit === "number") {
            const lines = content.split("\n");
            const start = typeof line === "number" ? Math.max(0, line - 1) : 0;
            const end = typeof limit === "number" ? start + limit : lines.length;
            content = lines.slice(start, end).join("\n");
          }
          respond({ content });
          return;
        }
        case "fs/write_text_file": {
          if (this.options.readOnly || this.options.clientCapabilities?.fs?.writeTextFile !== true) {
            this.writeDeniedHandler?.("ACP file write request was denied");
            fail(-32601, "Client file writes are not enabled for this session.");
            return;
          }
          const resolved = this.resolveWorkspacePath(message.params?.path);
          if (!resolved) {
            fail(-32602, "Path escapes the session workspace.");
            return;
          }
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, message.params?.content ?? "", "utf8");
          respond({});
          return;
        }
        default:
          fail(-32601, `Unsupported agent request: ${message.method}`);
      }
    } catch (error) {
      fail(-32603, error?.message ?? String(error));
    }
  }

  /**
   * エージェントから渡されたパスをセッションの作業ディレクトリ内へ閉じ込める。
   * 外へ出るパスは null を返して呼び出し側で拒否させる。
   */
  resolveWorkspacePath(target) {
    if (typeof target !== "string" || !target) {
      return null;
    }
    const root = path.resolve(this.cwd);
    const resolved = path.resolve(root, target);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      return null;
    }

    const realRoot = fs.realpathSync(root);
    let existing = resolved;
    const missing = [];
    // 未作成のwrite先も、存在する最深の祖先までリンク先を確認する。
    while (true) {
      try {
        fs.lstatSync(existing);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) return null;
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }

    let realExisting;
    try {
      realExisting = fs.realpathSync(existing);
    } catch (error) {
      // dangling link は新規ファイルと区別して拒否する。
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const realTarget = path.resolve(realExisting, ...missing);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative)) {
      return null;
    }
    return realTarget;
  }

  handleExit(error, failed = error != null) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.closed = true;
    this.framer.close();
    this.exitError = failed ? normalizeTransportError(error) : null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("grok agent connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
    void this.close().catch(() => {});
  }

  /**
   * ACP のハンドシェイク。Grok 版と違い `initialized` 通知は送らない。
   */
  async performInitialize() {
    this.initializeResult = await this.request("initialize", {
      protocolVersion: this.options.protocolVersion ?? ACP_PROTOCOL_VERSION,
      clientCapabilities: this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO
    });
    return this.initializeResult;
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }

  async close() {
    throw new Error("close must be implemented by subclasses.");
  }
}

class SpawnedAcpClient extends AcpClientBase {
  #stopPosixGroup = null;
  #posixChildClosed = null;
  #posixChildIsClosed = null;
  #posixClosePromise = null;
  #posixGroupIsEmpty = null;
  #posixGroupEmptyConfirmed = false;
  #posixSpawnNeverStarted = false;

  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
    this.windowsOwnedAgent = null;
    this.windowsOwnedStartup = null;
    this.windowsClosePromise = null;
    this.directAgentSpawnAttempted = false;
    this.directAgentOwner = null;
    this.directSpawnAdmission = null;
    this.brokerAuthorization = null;
  }

  async initialize() {
    if (this.closed || this.closeStarted) throw new Error("Direct Grok agent was closed before startup.");
    const command = this.options.grokBin ?? "grok";
    // Windows では shell が要る。PATH / PATHEXT の解決に加えて、
    // `.cmd` / `.bat` は shell 無しでは起動できないため。
    // ここで `process.env.SHELL` を使ってはいけない。Git Bash 環境では
    // bash が選ばれ、`C:\Users\...` のバックスラッシュをエスケープとして
    // 食って `C:Users...` に化ける。`true` なら cmd.exe が使われる。
    const useShell = process.platform === "win32";
    const args = ["agent", "stdio"];
    // shell 有効のまま引数配列を渡すと Node 24 以降が DEP0190 を stderr へ出し、
    // ホストが統合する出力に混ざる。shell のときは 1 本の文字列へ畳む。
    const validateBeforeSpawn = () => {
      const checked = this.options.beforeDirectSpawn?.();
      if (checked && typeof checked.then === "function") {
        void Promise.resolve(checked).catch(() => {});
        throw new TypeError("Direct agent startup verification must be synchronous.");
      }
      return checked;
    };
    const guardedSpawn = !useShell && this.directSpawnAdmission && typeof this.options.guardOwnerEffect === "function";
    let guardFailure, guardFailed = false;
    if (!guardedSpawn) validateBeforeSpawn();
    if (useShell) {
      this.windowsOwnedStartup = spawnWindowsAgent(this.cwd, quoteIfNeeded(command), args, {
        env: this.options.env ?? process.env,
        beforeSpawn: () => {
          if (this.closed || this.closeStarted) throw new Error("Direct Grok agent was closed before supervisor startup.");
          const checked = validateBeforeSpawn();
          this.directAgentSpawnAttempted = true;
          return checked;
        }
      });
      this.windowsOwnedAgent = await this.windowsOwnedStartup;
      this.proc = this.windowsOwnedAgent.proc;
      if (this.closed || this.closeStarted) {
        await this.close();
        throw new Error("Direct Grok agent was closed during startup.");
      }
    } else {
      const spawnChild = () => {
        if (this.closed || this.closeStarted) throw new Error("Direct Grok agent was closed before spawn.");
        this.directAgentSpawnAttempted = true;
        this.proc = spawn(command, args, {
          cwd: this.cwd,
          env: this.options.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: this.options.posixGroupMode !== "inherit",
          windowsHide: true
        });
        return this.proc;
      };
      if (guardedSpawn) {
        let active = true, called = false, repeated = false;
        try {
          let result;
          try {
            result = this.options.guardOwnerEffect((_state, context) => {
              // guard が遅延実行を仕掛けても mutex の外で spawn させない。
              if (!active) return undefined;
              if (called) { repeated = true; throw new Error("Direct spawn guard invoked its effect more than once."); }
              called = true;
              verifyDirectStartWithinContext(context, this.directSpawnAdmission);
              context.check();
              return spawnChild();
            });
          } finally { active = false; }
          if (result && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => {});
            throw new TypeError("Direct spawn guard must be synchronous.");
          }
          if (!called || repeated || !this.proc || result !== this.proc) throw new Error("Direct spawn guard did not return exactly one owned child.");
        } catch (error) {
          guardFailed = true;
          guardFailure = error;
        }
        if (!this.proc) throw guardFailure;
      } else {
        spawnChild();
      }
      // PIDだけを受け取る停止APIを作らず、このspawnの直子だけをclosureに固定する。
      const child = this.proc;
      child.once("error", () => { if (!Number.isInteger(child.pid) || child.pid <= 0) this.#posixSpawnNeverStarted = true; });
      const groupPid = child.pid;
      let childExited = false;
      let childClosed = false;
      let groupSignalled = false;
      child.once("exit", () => { childExited = true; });
      this.#posixChildClosed = new Promise((resolve) => {
        child.once("close", () => { childClosed = true; resolve(undefined); });
      });
      this.#posixChildIsClosed = () => this.proc === child && childClosed;
      this.#stopPosixGroup = () => {
        if (this.proc !== child || childExited || groupSignalled || child.killed || child.exitCode !== null || child.signalCode ||
            !Number.isInteger(groupPid) || groupPid <= 0) return;
        groupSignalled = true;
        try {
          // broker内はbroker所有groupを継承する。agentからその親groupへsignalしない。
          if (this.options.posixGroupMode === "inherit") child.kill("SIGTERM");
          else process.kill(-groupPid, "SIGTERM");
        } catch { /* 後の停止証拠だけで判定する */ }
      };
      this.#posixGroupIsEmpty = () => {
        if (this.options.posixGroupMode === "inherit" || this.proc !== child || !Number.isInteger(groupPid) || groupPid <= 0) return false;
        try { process.kill(-groupPid, 0); return false; }
        catch (error) { return error?.code === "ESRCH"; }
      };
    }

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.appendStderr(chunk);
      try {
        this.options.onStderr?.(chunk);
      } catch (error) {
        this.handleExit(error, true);
      }
    });

    this.proc.stdout.on("error", (error) => this.handleExit(error));
    this.proc.stderr.on("error", (error) => this.handleExit(error));

    // write() 後の EPIPE 等は ChildProcess ではなく stdin stream に届く。
    this.proc.stdin.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    // exit時点ではstdioに未読データが残り得る。最終応答と診断をdrainしてから確定する。
    this.proc.on("close", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `grok agent stdio exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.proc.stdout.on("data", (chunk) => this.handleChunk(chunk));

    // guard 違反時も先に子の所有・終了監視を登録し、呼出元の close へ渡す。
    if (guardFailed) throw guardFailure;

    if (this.windowsOwnedAgent) await this.windowsOwnedAgent.ready;
    if (this.closed || this.closeStarted) throw new Error("Direct Grok agent was closed before its ACP handshake.");
    await withTimeout(this.performInitialize(), DIRECT_HANDSHAKE_TIMEOUT_MS);
  }

  async close() {
    if (this.closeStarted) {
      if (this.windowsClosePromise) await this.windowsClosePromise;
      else if (this.#posixClosePromise) await this.#posixClosePromise;
      else await waitForExitWithTimeout(this.exitPromise);
      return;
    }

    this.closeStarted = true;
    this.closed = true;
    this.framer.close();

    if (process.platform === "win32") {
      // hookから同期closeされても、monitor代入と起動gateの確定を先に終える。
      this.windowsClosePromise = Promise.resolve().then(async () => {
        if (!this.windowsOwnedAgent && this.windowsOwnedStartup) {
          try { this.windowsOwnedAgent = await this.windowsOwnedStartup; } catch { /* 終了証拠は推測しない */ }
        }
        if (this.windowsOwnedAgent) {
          this.proc = this.windowsOwnedAgent.proc;
          this.proc?.stdin?.end();
          this.closeStopUnconfirmed = !(await this.windowsOwnedAgent.close());
        } else {
          this.closeStopUnconfirmed = Boolean(this.directAgentSpawnAttempted || this.proc);
        }
        try {
          const proof = this.directAgentStopProof();
          if (this.directAgentOwner && !(await this.directAgentOwner.finish(proof))) this.closeStopUnconfirmed = true;
        } catch (error) {
          this.closeStopUnconfirmed = true;
          throw error;
        } finally {
          if (this.closeStopUnconfirmed) this.releaseUnconfirmedProcess();
        }
      });
      await this.windowsClosePromise;
      return;
    }

    // 同期closeが登録callback内で再入しても、ownerの代入を先に完了する。
    this.#posixClosePromise = Promise.resolve().then(async () => {
      const deadline = Date.now() + CLOSE_TIMEOUT_MS;
      if (this.proc && !this.proc.killed) {
        this.proc.stdin?.end();
        setTimeout(() => {
          // 通常Node/libuvはreapと全exit callbackの配送を同じloop内で終え、
          // timer phaseと交差させない。未配送のleaderは未reapでPID/PGIDを保持する。
          // checkとkillは同期のままにし、任意のexit callbackへ移動しない。
          // 独自waitpidを行う外部native addonの実行環境はこの保証に含めない。
          this.#stopPosixGroup?.();
        }, 50).unref?.();
      }

      // protocol fatalもexitPromiseを解決するため、実子のstdio closeを別に待つ。
      if (this.proc) await waitForExitWithTimeout(this.#posixChildClosed ?? this.exitPromise, Math.max(0, deadline - Date.now()));
      if (this.#posixChildIsClosed?.() && this.options.posixGroupMode !== "inherit") {
        do {
          if (this.#posixGroupIsEmpty?.()) { this.#posixGroupEmptyConfirmed = true; break; }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)));
        } while (true);
      }
      if (this.proc && !this.#posixSpawnNeverStarted && (!this.#posixChildIsClosed?.() || !this.#posixGroupEmptyConfirmed)) this.closeStopUnconfirmed = true;
      try {
        if (this.directAgentOwner && !(await this.directAgentOwner.finish(this.directAgentStopProof()))) this.closeStopUnconfirmed = true;
      } catch (error) {
        this.closeStopUnconfirmed = true;
        throw error;
      } finally {
        if (this.closeStopUnconfirmed) this.releaseUnconfirmedProcess();
      }
    });
    await this.#posixClosePromise;
  }

  releaseUnconfirmedProcess() {
    this.proc?.stdin?.destroy?.();
    this.proc?.stdout?.destroy?.();
    this.proc?.stderr?.destroy?.();
    this.proc?.unref?.();
  }

  directAgentStopProof() {
    if (this.windowsOwnedAgent?.stopConfirmed === true) return "job-empty";
    if (this.#posixChildIsClosed?.() && this.#posixGroupEmptyConfirmed) return "posix-group-empty";
    if (this.#posixSpawnNeverStarted) return "never-started";
    // closed gateを立てた後の「一度もspawnを試みていない」だけを別証拠にする。
    return this.closed && !this.directAgentSpawnAttempted && !this.proc ? "never-started" : false;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("grok agent stdin is not available.");
    }
    stdin.write(line);
  }
}

async function connectDirectClient(cwd, options, brokerOwned = false) {
  const client = new SpawnedAcpClient(cwd, options);
  let admission = null;
  try {
    if (options.directAgentStarting) {
      client.directAgentOwner = options.directAgentStarting({ close: async () => {
        await client.close();
        return client.directAgentStopProof();
      } });
    }
    if (!brokerOwned) {
      if (client.closed || client.closeStarted) throw new Error("Direct Grok agent was closed before startup.");
      admission = reserveDirectAdmission(cwd);
      client.directSpawnAdmission = admission;
      client.options.beforeDirectSpawn = () => verifyDirectStart(cwd, admission);
    }
    await client.initialize();
    if (client.closed || client.closeStarted) throw new Error("Direct Grok agent was closed during startup.");
    if (admission) {
      finishDirectStart(cwd, admission, "ready");
      admission = null;
    }
    return client;
  } catch (error) {
    try { await client.close(); } catch { client.closeStopUnconfirmed = true; }
    if (admission) {
      try {
        const proof = client.directAgentStopProof();
        if (!proof || !finishDirectStart(cwd, admission, proof)) client.closeStopUnconfirmed = true;
      } catch { client.closeStopUnconfirmed = true; }
    }
    if (client.closeStopUnconfirmed && error && typeof error === "object") error.turnStopUnconfirmed = true;
    throw error;
  }
}

class BrokerAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.performInitialize();
  }

  async close() {
    if (this.closeStarted) {
      if (this.exitError) this.socket?.destroy();
      await waitForExitWithTimeout(this.exitPromise);
      return;
    }

    this.closeStarted = true;
    this.closed = true;
    this.framer.close();
    if (this.socket) {
      if (this.options.brokerOnly || this.exitError) this.socket.destroy();
      else this.socket.end();
    } else this.handleExit(null);
    await waitForExitWithTimeout(this.exitPromise);
  }

  sendMessage(message) {
    if (this.options.cancellationOnly &&
        (message.method !== "initialize" && (message.method !== "broker/cancelTurn" ||
          message.params?.generation !== this.options.cancellationGeneration ||
          message.params?.sessionId !== this.options.cancellationSessionId ||
          message.params?.executionId !== this.options.cancellationExecutionId))) {
      throw new Error("Cancellation-only broker client refuses this operation or generation.");
    }
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("grok agent broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class GrokAcpClient {
  static async connectBrokerOwned(cwd, options = {}) {
    const authorization = await authorizeBrokerChild(cwd, options.brokerEndpoint);
    try {
      const env = { ...(options.env ?? process.env) };
      for (const key of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "TMPDIR", "TMP", "TEMP"]) {
        const value = authorization.grant.agentEnv[key];
        if (value === null) delete env[key]; else env[key] = value;
      }
      const client = await connectDirectClient(cwd, { ...options, env,
        beforeDirectSpawn: () => verifyBrokerEpoch(cwd, authorization.grant.ownerIdentity.epoch) }, true);
      client.brokerAuthorization = authorization;
      return client;
    } catch (error) { authorization.channel.destroy(); throw error; }
  }
  static async connect(cwd, options = {}) {
    if (options.cancellationOnly && (!options.brokerOnly ||
        ![options.cancellationGeneration, options.cancellationSessionId, options.cancellationExecutionId].every(value => typeof value === "string" && value))) {
      throw new Error("Cancellation-only broker connection requires recorded generation, session, and execution identities.");
    }
    let brokerEndpoint = null;
    let managedAdmission = null;
    let managedGeneration = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (brokerEndpoint && (process.platform === "linux" || options.requireManagedBroker)) {
        const known = process.platform === "linux" ? findExplicitManagedSession(cwd, brokerEndpoint) : (() => {
          const session = loadBrokerSession(cwd);
          return session?.endpoint === brokerEndpoint ? { session, legacy: false } : null;
        })();
        if (known?.legacy) throw new Error("Explicit managed broker belongs to a legacy epoch; offline recovery is required.");
        if (options.requireManagedBroker && !known) throw new Error("Cannot resume through an unverified broker endpoint.");
        if (known) {
          if (options.cancellationOnly) {
            if (known.session.generation !== options.cancellationGeneration) throw new Error("Recorded broker generation changed before cancellation.");
            inspectManagedBrokerForCancel(cwd, known.session);
          } else managedAdmission = reserveManagedBroker(cwd, known.session);
          managedGeneration = known.session.generation;
        }
      }
      if (!brokerEndpoint && options.reuseExistingBroker) {
        const lookupBudget = options.brokerDeadlineMs ? options.brokerDeadlineMs - Date.now() : 7500;
        if (lookupBudget <= 0) throw new Error("Broker lookup deadline expired.");
        const session = loadBrokerSession(cwd, performance.now() + lookupBudget);
        if (session) {
          const timeoutMs = options.brokerDeadlineMs ? Math.max(1, options.brokerDeadlineMs - Date.now()) : 7500;
          if (options.cancellationOnly) {
            if (session.generation !== options.cancellationGeneration) throw new Error("Recorded broker generation changed before cancellation.");
            inspectManagedBrokerForCancel(cwd, session, { timeoutMs });
          } else managedAdmission = reserveManagedBroker(cwd, session, { timeoutMs });
          brokerEndpoint = session.endpoint;
          managedGeneration = session.generation;
        }
      }
      if (!brokerEndpoint && !options.reuseExistingBroker && !options.brokerOnly) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        if (brokerSession) {
          managedAdmission = reserveManagedBroker(cwd, brokerSession);
          brokerEndpoint = brokerSession.endpoint;
          managedGeneration = brokerSession.generation;
        }
      }
    }
    if (options.requireManagedBroker && brokerEndpoint && !managedGeneration) {
      throw new Error("Cannot resume without a verified managed broker generation.");
    }
    if (!brokerEndpoint) {
      if (options.brokerOnly || options.requireManagedBroker) throw new Error(options.requireManagedBroker
        ? "No existing managed Grok broker is available for session resumption."
        : "No existing Grok broker is available for cancellation.");
      return connectDirectClient(cwd, options);
    }

    const client = new BrokerAcpClient(cwd, { ...options, brokerEndpoint });
    let brokerInitialized = false;
    try {
      const timeoutMs = options.brokerDeadlineMs
        ? Math.max(1, Math.min(BROKER_HANDSHAKE_TIMEOUT_MS, options.brokerDeadlineMs - Date.now()))
        : BROKER_HANDSHAKE_TIMEOUT_MS;
      await withTimeout(client.initialize(), timeoutMs);
      brokerInitialized = true;
      if (options.cancellationOnly && client.initializeResult?._meta?.grokBrokerGeneration !== options.cancellationGeneration) {
        throw new Error("Broker generation did not match the cancellation request.");
      }
      if (managedGeneration && client.initializeResult?._meta?.grokBrokerGeneration !== managedGeneration) {
        throw new Error("Broker generation did not match the managed session.");
      }
      if (managedAdmission) {
        const remaining = options.brokerDeadlineMs ? Math.max(1, options.brokerDeadlineMs - Date.now()) : 7500;
        finishDirectStart(cwd, managedAdmission, "ready", { timeoutMs: remaining });
        managedAdmission = null;
      }
      return client;
    } catch (error) {
      // 応答しないブローカーを掴んだ場合は、それを諦めて自前で起動し直す。
      // ここで諦めないと呼び出し側がハングしたまま戻らない。
      await client.close().catch(() => {});
      if (managedAdmission) {
        try {
          const remaining = options.brokerDeadlineMs ? Math.max(1, options.brokerDeadlineMs - Date.now()) : 7500;
          finishDirectStart(cwd, managedAdmission, brokerInitialized ? "ready" : "never-started", { timeoutMs: remaining });
        }
        catch (releaseError) { error.cause ??= releaseError; throw error; }
      }
      if (options.brokerOnly || options.requireManagedBroker || brokerInitialized) throw error;
      // タイムアウトに限らず、接続失敗（消えたソケット等）でも直接起動へ落とす。
      // 直接起動まで失敗したときだけ、元の失敗理由を添えて投げ直す。
      try {
        return await connectDirectClient(cwd, options);
      } catch (fallbackError) {
        throw attachBrokerFailure(fallbackError, error);
      }
    }
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HandshakeTimeoutError(ms)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
