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
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { spawnWindowsAgent } from "./windows-agent.mjs";
import { JsonlFramer } from "./jsonl.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.codex-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
const POSIX_AGENT_SUPERVISOR = fileURLToPath(new URL("./posix-agent-supervisor.mjs", import.meta.url));

const promptFailureEvidence = new WeakMap();
const promptSuccessEvidence = new WeakMap();
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
/** ACP のプロトコル版。grok 0.2.x は 1 を返す。 */
export const ACP_PROTOCOL_VERSION = 1;

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
    super(`Grok agent did not complete the ACP handshake within ${ms}ms.`);
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
        if (pending.method === "session/prompt") {
          const terminal = "confirmed";
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
  #posixAgentExit = null;

  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
    this.windowsOwnedAgent = null;
    this.windowsOwnedStartup = null;
    this.windowsClosePromise = null;
    this.directAgentSpawnAttempted = false;
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
    if (useShell) {
      this.windowsOwnedStartup = spawnWindowsAgent(this.cwd, quoteIfNeeded(command), args, {
        env: this.options.env ?? process.env,
        beforeSpawn: () => {
          if (this.closed || this.closeStarted) throw new Error("Direct Grok agent was closed before supervisor startup.");
          this.directAgentSpawnAttempted = true;
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
        this.proc = spawn(process.execPath, [POSIX_AGENT_SUPERVISOR, command, ...args], {
          cwd: this.cwd,
          env: this.options.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          shell: false,
          detached: true,
          windowsHide: true
        });
        return this.proc;
      };
      spawnChild();
      // PIDだけを受け取る停止APIを作らず、このspawnの直子だけをclosureに固定する。
      const child = this.proc;
      let exitData = "";
      child.stdio[3].setEncoding("utf8");
      child.stdio[3].on("data", chunk => { if (exitData.length <= 1024) exitData += chunk; });
      child.stdio[3].on("error", () => {});
      child.stdio[3].on("end", () => {
        if (exitData.length > 1024) return;
        try {
          const value = JSON.parse(exitData);
          if ((Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 && value.signal === null) ||
              (value.code === null && typeof value.signal === "string" && /^SIG[A-Z0-9]+$/.test(value.signal))) {
            this.#posixAgentExit = value;
          }
        } catch { /* 不完全な証拠は supervisor の終了状態を使う。 */ }
      });
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
          process.kill(-groupPid, "SIGTERM");
        } catch { /* 後の停止証拠だけで判定する */ }
      };
      this.#posixGroupIsEmpty = () => {
        if (this.proc !== child || !Number.isInteger(groupPid) || groupPid <= 0) return false;
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
      if (!this.windowsOwnedAgent && this.#posixAgentExit) ({ code, signal } = this.#posixAgentExit);
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
        if (this.closeStopUnconfirmed) this.releaseUnconfirmedProcess();
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
      if (this.#posixChildIsClosed?.()) {
        do {
          if (this.#posixGroupIsEmpty?.()) { this.#posixGroupEmptyConfirmed = true; break; }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)));
        } while (true);
      }
      if (this.proc && !this.#posixSpawnNeverStarted && (!this.#posixChildIsClosed?.() || !this.#posixGroupEmptyConfirmed)) this.closeStopUnconfirmed = true;
      if (this.closeStopUnconfirmed) this.releaseUnconfirmedProcess();
    });
    await this.#posixClosePromise;
  }

  releaseUnconfirmedProcess() {
    this.proc?.stdin?.destroy?.();
    this.proc?.stdout?.destroy?.();
    this.proc?.stderr?.destroy?.();
    this.proc?.stdio?.[3]?.destroy?.();
    this.proc?.unref?.();
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

export class GrokAcpClient {
  static async connectForeground(cwd, options = {}) {
    const client = new SpawnedAcpClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      try { await client.close(); } catch { client.closeStopUnconfirmed = true; }
      if (client.closeStopUnconfirmed && error && typeof error === "object") error.turnStopUnconfirmed = true;
      throw error;
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
