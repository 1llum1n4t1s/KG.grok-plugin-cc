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
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
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
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "GROK_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
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
    this.exitError = null;
    /** @type {AcpNotificationHandler | null} */
    this.notificationHandler = null;
    /** @type {((params: unknown) => unknown) | null} */
    this.permissionHandler = options.permissionHandler ?? null;
    /**
     * agent → client リクエストを丸ごと横取りするハンドラ。
     * ブローカーが「自分では処理せず接続元のクライアントへ転送する」ために使う。
     * 設定されている場合、応答を返す責任はハンドラ側にある。
     * @type {((message: unknown) => void) | null}
     */
    this.agentRequestHandler = options.agentRequestHandler ?? null;
    this.lineBuffer = "";
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
    const { result, error } = response;
    this.sendMessage(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result: result ?? {} });
  }

  /**
   * @template {AcpMethod} M
   * @param {M} method
   * @param {import("./acp-protocol").AcpRequestParams<M>} params
   * @returns {Promise<import("./acp-protocol").AcpResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("grok agent stdio client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk) {
    // 走査済みの位置から探す。先頭から探し直すと、改行を含まない巨大な
    // 1 行（大きなツール出力）を組み立てる間、受信のたびに全体を
    // 再走査して O(N^2) になる。
    const scanFrom = this.lineBuffer.length;
    this.lineBuffer += chunk;

    let searchFrom = scanFrom;
    let newlineIndex = this.lineBuffer.indexOf("\n", searchFrom);
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      searchFrom = 0;
      newlineIndex = this.lineBuffer.indexOf("\n", searchFrom);
    }
  }

  handleLine(line) {
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
        pending.reject(createProtocolError(message.error.message ?? `grok ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    // ブローカーが中継してくるエージェントの stderr。直接起動と同じように
    // client.stderr へ溜め、失敗時の診断がどちらの経路でも同じ内容になるようにする。
    if (message.method === BROKER_AGENT_STDERR_METHOD) {
      this.stderr += String(message.params?.chunk ?? "");
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
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("grok agent connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
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
}

class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const command = this.options.grokBin ?? "grok";
    this.proc = spawn(quoteIfNeeded(command), ["agent", "stdio"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows では shell が要る。PATH / PATHEXT の解決に加えて、
      // `.cmd` / `.bat` は shell 無しでは起動できないため。
      // ここで `process.env.SHELL` を使ってはいけない。Git Bash 環境では
      // bash が選ばれ、`C:\Users\...` のバックスラッシュをエスケープとして
      // 食って `C:Users...` に化ける。`true` なら cmd.exe が使われる。
      shell: process.platform === "win32",
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      this.options.onStderr?.(chunk);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `grok agent stdio exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.performInitialize();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // Windows で shell: true のとき直接の子は cmd.exe なので、
          // 孫の grok プロセスまで含めてツリーごと終了させる。
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // unref 済みタイマー内のベストエフォート後始末。
              // ここで投げるとホストプロセスごと落ちるので握り潰す。
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
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
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("grok agent broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class GrokAcpClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    if (!brokerEndpoint) {
      const client = new SpawnedAcpClient(cwd, options);
      await client.initialize();
      return client;
    }

    const client = new BrokerAcpClient(cwd, { ...options, brokerEndpoint });
    try {
      await withTimeout(client.initialize(), BROKER_HANDSHAKE_TIMEOUT_MS);
      return client;
    } catch (error) {
      // 応答しないブローカーを掴んだ場合は、それを諦めて自前で起動し直す。
      // ここで諦めないと呼び出し側がハングしたまま戻らない。
      await client.close().catch(() => {});
      // タイムアウトに限らず、接続失敗（消えたソケット等）でも直接起動へ落とす。
      // 直接起動まで失敗したときだけ、元の失敗理由を添えて投げ直す。
      try {
        const direct = new SpawnedAcpClient(cwd, options);
        await direct.initialize();
        return direct;
      } catch (fallbackError) {
        fallbackError.cause = error;
        throw fallbackError;
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
