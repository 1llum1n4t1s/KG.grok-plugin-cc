#!/usr/bin/env node
/**
 * 共有 ACP ブローカー。
 *
 * 1 本の `grok agent stdio` プロセスを複数の Claude Code 呼び出しで使い回すため、
 * Unix ドメインソケット（Windows では名前付きパイプ）で JSON-RPC を中継する。
 *
 * 本家 codex-plugin-cc の app-server-broker.mjs からの主な変更点:
 *
 *   - ストリーム所有権の追跡を削除した。Codex の `turn/start` は即座に返って
 *     以降も通知が続いたため「どのソケットへ通知を流すか」を別途覚える必要が
 *     あったが、ACP の `session/prompt` はターン終了まで解決しないので、
 *     通知は常に「今リクエストを出しているソケット」へ流せば足りる。
 *   - agent → client 方向のリクエスト（session/request_permission, fs/*）を
 *     ブローカーが自分で処理せず、接続元のクライアントへ転送するようにした。
 *     ここを握ってしまうと、書き込みを許可したいジョブでもブローカー側の
 *     既定（読み取り専用）で拒否されてしまうため。
 *   - initialize の応答をスタブではなく実物の転送にした。クライアントは
 *     agentCapabilities とモデル一覧を initialize の結果から読むため。
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_AGENT_STDERR_METHOD, BROKER_BUSY_RPC_CODE, GrokAcpClient } from "./lib/acp.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

/** 実行中に別ソケットから割り込めるメソッド。 */
function isCancelRequest(message) {
  return message?.method === "session/cancel";
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  // エージェントの stderr は broker.log にしか残らず、クライアント側の
  // client.stderr が常に空になっていた。占有中のソケットへ中継する。
  let forwardAgentStderr = () => {};
  const agent = await GrokAcpClient.connect(cwd, {
    disableBroker: true,
    onStderr: (chunk) => forwardAgentStderr(chunk)
  });

  /** 今このソケットがエージェントを占有している。 */
  let activeSocket = null;
  const sockets = new Set();
  /** エージェントが出した逆リクエストの id -> 転送先ソケット。 */
  const forwardedAgentRequests = new Map();

  function clearSocketOwnership(socket) {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    for (const [id, target] of forwardedAgentRequests) {
      if (target === socket) {
        // 転送先が消えたので、エージェントを待たせないよう打ち切る。
        agent.respondToAgent(id, { error: buildJsonRpcError(-32000, "Client disconnected.") });
        forwardedAgentRequests.delete(id);
      }
    }
  }

  forwardAgentStderr = (chunk) => {
    if (activeSocket) {
      send(activeSocket, {
        jsonrpc: "2.0",
        method: BROKER_AGENT_STDERR_METHOD,
        params: { chunk: String(chunk) }
      });
    }
  };

  // 通知は占有中のソケットへ素通しする。
  agent.setNotificationHandler((message) => {
    if (activeSocket) {
      send(activeSocket, message);
    }
  });

  // 逆リクエストは占有中のソケットへ転送し、応答が返るのを待つ。
  agent.setAgentRequestHandler((message) => {
    if (!activeSocket) {
      agent.respondToAgent(message.id, {
        error: buildJsonRpcError(-32000, "No client is attached to answer this request.")
      });
      return;
    }
    forwardedAgentRequests.set(message.id, activeSocket);
    send(activeSocket, message);
  });

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await agent.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, { jsonrpc: "2.0", id: null, error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`) });
          continue;
        }

        // 転送した逆リクエストへの応答。エージェントへ中継して終わり。
        if (message.id !== undefined && !message.method && forwardedAgentRequests.has(message.id)) {
          forwardedAgentRequests.delete(message.id);
          agent.respondToAgent(message.id, { result: message.result, error: message.error });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { jsonrpc: "2.0", id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        // 通知は応答を返さないので、そのままエージェントへ素通しする。
        // ACP の `session/cancel` は通知なので、ここで捨てると
        // `/grok:cancel` が Grok 側のターンに一切届かなくなる。
        // 占有ロックも取らない（実行中の別セッションを止めるのが本来の用途）。
        if (message.id === undefined) {
          if (message.method) {
            agent.notify(message.method, message.params ?? {});
          }
          continue;
        }

        // initialize はエージェントの実応答をそのまま返す。
        // クライアントは agentCapabilities とモデル一覧をここから読む。
        if (message.method === "initialize") {
          send(socket, { jsonrpc: "2.0", id: message.id, result: agent.initializeResult ?? {} });
          continue;
        }

        // 実行中の別セッションを止めにいく場合だけ、占有中でも通す。
        const allowCancelDuringActiveTurn = isCancelRequest(message) && activeSocket && activeSocket !== socket;

        if (activeSocket && activeSocket !== socket && !allowCancelDuringActiveTurn) {
          send(socket, {
            jsonrpc: "2.0",
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Grok broker is busy.")
          });
          continue;
        }

        const claimed = !allowCancelDuringActiveTurn;
        if (claimed) {
          activeSocket = socket;
        }

        try {
          const result = await agent.request(message.method, message.params ?? {});
          send(socket, { jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          send(socket, {
            jsonrpc: "2.0",
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
        } finally {
          if (claimed && activeSocket === socket) {
            activeSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  // listen 失敗（名前付きパイプの衝突、残骸ソケットの権限など）を
  // 未捕捉例外にすると、原因がスタックトレースにしか残らない。
  // ここで理由を書き出してから終わることで broker.log から追える。
  server.on("error", (error) => {
    process.stderr.write(`Grok broker could not listen on ${endpoint}: ${error?.message ?? error}\n`);
    process.exit(1);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
