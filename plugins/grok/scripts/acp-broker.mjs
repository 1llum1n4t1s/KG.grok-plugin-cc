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
 *   - initialize は起動時に取得した実応答を返す。
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_AGENT_STDERR_METHOD, BROKER_BUSY_RPC_CODE, BROKER_CAPACITY_RPC_CODE, GrokAcpClient } from "./lib/acp.mjs";
import { inspectBrokerConfirmation, recordBrokerAgentStopped, verifyBrokerEpoch } from "./lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { JsonlFramer } from "./lib/jsonl.mjs";

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
  const generation = process.env.GROK_COMPANION_BROKER_GENERATION;

  // エージェントの stderr は broker.log にしか残らず、クライアント側の
  // client.stderr が常に空になっていた。占有中のソケットへ中継する。
  /** @type {(chunk: string) => void} */
  let forwardAgentStderr = () => {};
  const agent = await GrokAcpClient.connectBrokerOwned(cwd, {
    brokerEndpoint: String(options.endpoint),
    // startup失敗時も外側のbroker所有groupからagentを逃がさない。Windows Jobは独立。
    posixGroupMode: "inherit",
    grokBin: process.env.GROK_BIN,
    onStderr: (chunk) => forwardAgentStderr(chunk)
  });
  const epoch = agent.brokerAuthorization?.grant?.ownerIdentity?.epoch;
  function epochValid() {
    try { return verifyBrokerEpoch(cwd, epoch); } catch { return false; }
  }
  if (!epochValid()) throw new Error("Broker state epoch is no longer valid before writing its PID file.");
  writePidFile(pidFile);

  /** 今このソケットがエージェントを占有している。 */
  let activeSocket = null;
  const sockets = new Set();
  /** エージェントが出した逆リクエストの id -> 転送先ソケット。 */
  const forwardedAgentRequests = new Map();
  const inFlight = new Set();
  let closing = false;
  // 切断したturnと同一sessionの再開は、遅延フレームを区別できない。
  // このbroker内では失効させ、別sessionの実行だけを受け付ける。
  const disconnectedSessions = new Set();
  // cancelがpromptより先着しても、同じ実行の修復送信を受け付けない。
  const cancelledExecutions = new Set();
  const maxCancelledExecutions = 4096;
  let cancellationCapacityReached = false;
  // 上限到達後も初回とrepairの間にある実行を保護する。接続終了で破棄する。
  const admittedExecutions = new Map();
  const maxAdmissionsPerSocket = 64;
  // 終了応答のない実行を接続の寿命と切り離して追跡する。
  const executionLedger = new Map();
  // 確認できた世代だけをcacheする。期限切れのI/Oが完了するまでは新たな読取りを増やさない。
  let confirmed = false, confirmation = null;
  function confirmAdmission() {
    if (!epochValid()) return Promise.resolve(false);
    if (confirmed) return Promise.resolve(true);
    if (confirmation) return confirmation.result;
    const current = { expired: false, result: null };
    confirmation = current;
    const deadline = performance.now() + 750;
    const authorization = agent.brokerAuthorization;
    const read = inspectBrokerConfirmation(authorization?.grant, authorization?.baseline, endpoint, generation).catch(() => false);
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { current.expired = true; resolve(false); }, 750); });
    current.result = Promise.race([read, timeout]).then(value => {
      clearTimeout(timer);
      const valid = !current.expired && value === true && performance.now() < deadline;
      if (valid) confirmed = true;
      return valid;
    });
    void read.finally(() => { if (confirmation === current) confirmation = null; });
    return current.result;
  }
  const legacySessions = new Set();
  const maxExecutionRecords = 4096;
  const executionKey = (sessionId, executionId) => JSON.stringify([sessionId, executionId]);
  const scopedActive = (sessionId) => [...inFlight].some((request) =>
    request.method === "session/prompt" && request.sessionId === sessionId && request.executionId);

  function sessionIsActive(socket, sessionId) {
    return typeof sessionId === "string" && !disconnectedSessions.has(sessionId) &&
      [...inFlight].some((request) => request.socket === socket && request.sessionId === sessionId);
  }

  function rejectForwardedRequests(socket, message) {
    for (const [id, target] of forwardedAgentRequests) {
      if (target === socket) {
        if (epochValid()) agent.respondToAgent(id, { error: buildJsonRpcError(-32000, message) });
        forwardedAgentRequests.delete(id);
      }
    }
  }

  function clearSocketOwnership(socket) {
    admittedExecutions.delete(socket);
    if (activeSocket === socket && ![...inFlight].some((request) =>
        request.socket === socket && request.method === "session/prompt")) {
      activeSocket = null;
    }
    for (const request of inFlight) {
      if (request.socket === socket && typeof request.sessionId === "string") {
        disconnectedSessions.add(request.sessionId);
      }
    }
    rejectForwardedRequests(socket, "Client disconnected.");
    const cancelledSessions = new Set();
    for (const request of inFlight) {
      if (request.socket !== socket) continue;
      // promptはagentのterminalまでpendingを残す。abortすると遅延応答を失う。
      if (request.method !== "session/prompt") request.controller.abort(new Error("Client disconnected."));
      if (request.method === "session/prompt" && !cancelledSessions.has(request.sessionId)) {
        cancelledSessions.add(request.sessionId);
        if (epochValid()) agent.notify("session/cancel", { sessionId: request.sessionId });
      }
    }
  }

  forwardAgentStderr = (chunk) => {
    if (activeSocket && epochValid()) {
      send(activeSocket, {
        jsonrpc: "2.0",
        method: BROKER_AGENT_STDERR_METHOD,
        params: { chunk: String(chunk) }
      });
    }
  };

  // 通知は占有中のソケットへ素通しする。
  agent.setNotificationHandler((message) => {
    if (!epochValid()) return;
    if (activeSocket && (message.params?.sessionId === undefined || sessionIsActive(activeSocket, message.params.sessionId))) {
      send(activeSocket, message);
    }
  });

  // 逆リクエストは占有中のソケットへ転送し、応答が返るのを待つ。
  agent.setAgentRequestHandler((message) => {
    if (!epochValid()) return;
    if (!activeSocket || !sessionIsActive(activeSocket, message.params?.sessionId)) {
      agent.respondToAgent(message.id, {
        error: buildJsonRpcError(-32000, "No client is attached to answer this request.")
      });
      return;
    }
    forwardedAgentRequests.set(message.id, activeSocket);
    send(activeSocket, message);
  });

  let shutdownPromise = null;
  async function shutdown(server) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
    closing = true;
    const flushed = [...sockets].map(socket => new Promise(resolve => {
      if (socket.destroyed) return resolve(undefined);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; clearTimeout(timer); socket.off("close", finish); resolve(undefined);
      };
      // 接続先が読まない場合も停止を無期限に待たない。ACKが届かなければ呼出元は未確認のまま保持する。
      const timer = setTimeout(finish, 1000);
      socket.once("close", finish);
      try { socket.end(finish); } catch { finish(); }
    }));
    let agentCloseFailed = false;
    await agent.close().catch(() => { agentCloseFailed = true; });
    await Promise.all(flushed);
    // POSIXのserver.closeはbind時のpathnameを無条件unlinkする。
    // 別世代に交換されたentryを守るため、所有processの終了でlistenerを閉じる。
    if (process.platform !== "win32") return;
    await new Promise((resolve) => server.close(resolve));
    // 直子closeだけで同groupの子孫消滅を推測しない。外側の所有group確認へ記録を残す。
    if (agentCloseFailed || agent.closeStopUnconfirmed) return;
    if (process.platform === "win32") {
      // 受付ACKやbroker PID消滅はJob空の証拠ではない。同generationへ保存してから回収する。
      if (!("directAgentStopProof" in agent) || agent.directAgentStopProof() !== "job-empty") return;
      const deadline = performance.now() + 100;
      try {
        let saved;
        do {
          saved = recordBrokerAgentStopped(cwd, { generation, pid: process.pid, endpoint });
          if (saved !== "locked") break;
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)));
        } while (performance.now() < deadline);
        if (saved !== "saved") return;
      } catch {
        process.stderr?.write?.("Grok broker could not persist its Job stop proof; retaining cleanup records.\n");
        return;
      }
    }

    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    })();
    return shutdownPromise;
  }

  const server = net.createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const admissions = new Map();
    admittedExecutions.set(socket, admissions);
    socket.setEncoding("utf8");
    let pendingRequests = 0;

    async function handleMessage(message) {
      if (socket.destroyed || !sockets.has(socket)) return;
      if (agent.closed) {
        socket.destroy();
        return;
      }
      if (!epochValid()) {
        if (message.id !== undefined) send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32000, "Broker state epoch is no longer valid.") });
        else socket.destroy();
        return;
      }
      if (closing) {
        socket.end();
        return;
      }
      // initialize はエージェントの実応答をそのまま返す。
      // クライアントは agentCapabilities とモデル一覧をここから読む。
      if (message.id !== undefined && message.method === "initialize") {
        send(socket, { jsonrpc: "2.0", id: message.id, result: { ...agent.initializeResult,
          _meta: { ...agent.initializeResult?._meta, grokScopedCancellation: true,
            grokExecutionLedger: true, grokBrokerGeneration: generation,
            grokPromptAdmission: !cancellationCapacityReached } } });
        return;
      }

      if (message.id !== undefined && message.method === "broker/cancelTurn") {
        const { sessionId, executionId } = message.params ?? {};
        if (typeof sessionId !== "string" || !sessionId || typeof executionId !== "string" || !executionId) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32602, "Session and execution identities are required.") });
          return;
        }
        const key = executionKey(sessionId, executionId);
        const execution = executionLedger.get(key);
        const matchingGeneration = Boolean(generation) && message.params?.generation === generation;
        const executionState = !matchingGeneration ? "unknown" : execution?.state ??
          (legacySessions.has(sessionId) ? "unknown" : "never-accepted");
        if (!matchingGeneration) {
          send(socket, { jsonrpc: "2.0", id: message.id, result: {
            reservationAccepted: false, notificationSent: false, executionState: "unknown", generation
          } });
          return;
        }
        // ACKより先に全接続の一致する実行を取り消し、repair待ちも保護する。
        for (const records of admittedExecutions.values()) {
          const admitted = records.get(key);
          if (admitted) admitted.cancelled = true;
        }
        if (!cancelledExecutions.has(key)) {
          if (cancelledExecutions.size < maxCancelledExecutions) cancelledExecutions.add(key);
          else cancellationCapacityReached = true;
        }
        const active = [...inFlight].some((request) => request.method === "session/prompt" &&
          request.sessionId === sessionId && request.executionId === executionId);
        if (active) agent.notify("session/cancel", { sessionId });
        send(socket, { jsonrpc: "2.0", id: message.id,
          result: { reservationAccepted: true, notificationSent: active, executionState, generation } });
        return;
      }

      if (!confirmed) {
        const admitted = await confirmAdmission();
        // 読取り中の切断・停止・取消を先に反映し、その後の同期区間で判定する。
        if (socket.destroyed || !sockets.has(socket)) return;
        if (closing) { socket.end(); return; }
        if (!epochValid()) {
          if (message.id !== undefined) send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32000, "Broker state epoch is no longer valid.") });
          return;
        }
        if (!admitted) {
          if (message.id !== undefined) send(socket, { jsonrpc: "2.0", id: message.id,
            error: buildJsonRpcError(-32002, "Broker readiness is not confirmed.") });
          return;
        }
      }
      if (message.id !== undefined && message.method === "broker/shutdownIfIdle") {
        if (!generation || message.params?.generation !== generation) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32602, "Broker generation does not match.") });
          return;
        }
        // request 間の待機も保護する。判定から closing まで await を挟まない。
        if (inFlight.size || [...sockets].some((other) => other !== socket)) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Grok broker has attached clients.") });
          return;
        }
        closing = true;
        send(socket, { jsonrpc: "2.0", id: message.id, result: { closing: true, generation } });
        await shutdown(server);
        process.exit(0);
        return;
      }
      // 転送した逆リクエストへの応答。エージェントへ中継して終わり。
      if (message.id !== undefined && !message.method) {
        if (forwardedAgentRequests.get(message.id) !== socket) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32600, "Unexpected agent response from this client.") });
          return;
        }
        forwardedAgentRequests.delete(message.id);
        agent.respondToAgent(message.id, { result: message.result, error: message.error });
        return;
      }

      if (message.id !== undefined && message.method === "broker/shutdown") {
        if (inFlight.size || [...sockets].some((other) => other !== socket)) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Grok broker is busy or has attached clients.") });
          return;
        }
        closing = true;
        send(socket, { jsonrpc: "2.0", id: message.id, result: {} });
        await shutdown(server);
        process.exit(0);
        return;
      }

      // 旧クライアントのsession単位cancelで新しい実行を止めない。
      if (isCancelRequest(message) && scopedActive(message.params?.sessionId)) {
        if (message.id !== undefined) send(socket, { jsonrpc: "2.0", id: message.id,
          error: buildJsonRpcError(-32602, "Execution-scoped cancellation is required for this turn.") });
        return;
      }

      // 通知は応答を返さないので、そのままエージェントへ素通しする。
      // ACP の `session/cancel` は通知なので、ここで捨てると
      // `/grok:cancel` が Grok 側のターンに一切届かなくなる。
      // 占有ロックも取らない（実行中の別セッションを止めるのが本来の用途）。
      if (message.id === undefined) {
        if (message.method) {
          agent.notify(message.method, message.params ?? {});
        }
        return;
      }

      const promptKey = executionKey(message.params?.sessionId, message.params?.executionId);
      if (message.method === "session/load") {
        const sessionId = message.params?.sessionId;
        const executions = [...executionLedger.values()].filter((record) => record.sessionId === sessionId);
        const knownTerminal = executions.length > 0 && executions.every((record) => record.state === "terminal");
        if (!knownTerminal || legacySessions.has(sessionId) || disconnectedSessions.has(sessionId)) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32002,
            "Cannot resume this session: this broker has no safe terminal execution history. Direct, disconnected, and previous-broker sessions require a fresh session.") });
          return;
        }
      }
      if (message.method === "session/prompt" &&
          (admissions.get(promptKey)?.cancelled || cancelledExecutions.has(promptKey))) {
        send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(-32002, "Execution was cancelled; prompt was not sent.",
          { source: "grok-broker", promptForwarded: false, reason: "cancelled" }) });
        return;
      }

      // 実行中の別セッションを止めにいく場合だけ、占有中でも通す。
      const allowCancelDuringActiveTurn = isCancelRequest(message) && activeSocket && activeSocket !== socket;

      if ((!isCancelRequest(message) && disconnectedSessions.has(message.params?.sessionId)) ||
          (activeSocket && activeSocket !== socket && !allowCancelDuringActiveTurn)) {
        send(socket, {
          jsonrpc: "2.0",
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Grok broker is busy.", { source: "grok-broker", promptForwarded: false })
        });
        return;
      }

      if (message.method === "session/prompt" && [...inFlight].some((request) =>
          request.method === "session/prompt" && request.sessionId === message.params?.sessionId)) {
        send(socket, { jsonrpc: "2.0", id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "This session already has an active prompt.", { source: "grok-broker", promptForwarded: false }) });
        return;
      }

      if (message.method === "session/prompt") {
        const scoped = typeof message.params?.executionId === "string" && message.params.executionId.length > 0 &&
          typeof message.params?.sessionId === "string" && message.params.sessionId.length > 0;
        if ((!executionLedger.has(promptKey) && (scoped || !legacySessions.has(message.params.sessionId)) &&
              executionLedger.size + legacySessions.size >= maxExecutionRecords) ||
            (!admissions.has(promptKey) && cancellationCapacityReached) ||
            (scoped && !admissions.has(promptKey) && admissions.size >= maxAdmissionsPerSocket)) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(BROKER_CAPACITY_RPC_CODE,
            "Broker capacity reached; prompt was not forwarded.", { source: "grok-broker", promptForwarded: false }) });
          return;
        }
        // busy/取消判定後、agentへの同期enqueueと同じevent-loop区間で登録する。
        if (scoped && !admissions.has(promptKey)) admissions.set(promptKey, { cancelled: false });
        if (scoped) executionLedger.set(promptKey, { state: "accepted", sessionId: message.params.sessionId });
        else legacySessions.add(message.params.sessionId);
      }

      // 同じ接続のキャンセルも、進行中 prompt の占有を解除してはいけない。
      const claimed = !isCancelRequest(message);
      const request = { socket, sessionId: message.params?.sessionId, executionId: message.params?.executionId, method: message.method, controller: new AbortController() };
      if (claimed) {
        activeSocket = socket;
        pendingRequests += 1;
        inFlight.add(request);
      }

      try {
        const params = { ...message.params };
        delete params.executionId;
        const result = await agent.request(message.method, params, { signal: request.controller.signal });
        if (!epochValid()) throw new Error("Broker state epoch is no longer valid.");
        if (message.method === "session/prompt" && executionLedger.has(promptKey)) {
          executionLedger.get(promptKey).state = "terminal";
        }
        send(socket, { jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        if (message.method === "session/prompt") {
          // RPC errorもagent自身の終了応答。切断・送信失敗は停止の証拠にならない。
          const state = error.rpcResponseReceived === true && epochValid() ? "terminal" : "unknown";
          if (executionLedger.has(promptKey)) executionLedger.get(promptKey).state = state;
          if (state === "unknown") disconnectedSessions.add(message.params?.sessionId);
        }
        send(socket, {
          jsonrpc: "2.0",
          id: message.id,
          // agentがbroker専用code/dataを返しても未送信証拠として扱わせない。
          error: buildJsonRpcError([BROKER_BUSY_RPC_CODE, BROKER_CAPACITY_RPC_CODE].includes(error.rpcCode) ? -32000 : (error.rpcCode ?? -32000), error.message,
            message.method === "session/prompt" ? { source: "grok-broker", turnStopConfirmed: error.rpcResponseReceived === true } : undefined)
        });
      } finally {
        if (claimed) {
          inFlight.delete(request);
          pendingRequests -= 1;
          if (pendingRequests === 0) {
            if (activeSocket === socket) activeSocket = null;
            rejectForwardedRequests(socket, "Client request completed.");
          }
        }
      }
    }

    const framer = new JsonlFramer((line) => {
      if (!line.trim()) return;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        send(socket, { jsonrpc: "2.0", id: null, error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`) });
        return;
      }
      // フレーム分離中に待たない。RPC 完了待ちの間も cancel と逆応答を転送する。
      void handleMessage(message).catch((error) => {
        send(socket, { jsonrpc: "2.0", id: message?.id ?? null, error: buildJsonRpcError(-32000, error.message) });
      });
    });
    socket.on("data", (chunk) => framer.push(chunk));

    socket.on("close", () => {
      framer.close();
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      framer.close();
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

  // agent の接続が失われた後に保存済み initialize 応答を再利用しない。
  // 既存の pending は agent 側の失敗として解決し、未確認の turn を保持する。
  void agent.exitPromise.then(async () => {
    if (closing) return;
    process.stderr.write(`Grok broker agent connection ended: ${agent.exitError?.message ?? "connection closed"}\n`);
    try { await shutdown(server); } finally { process.exit(1); }
  });

  server.listen(listenTarget.path, () => {
    const authorization = agent.brokerAuthorization;
    if (closing || agent.closed || !authorization || authorization.channel.destroyed || authorization.channel.readableEnded || !epochValid()) {
      process.stderr.write("Broker owner disconnected before readiness confirmation.\n");
      void shutdown(server).finally(() => process.exit(1));
      return;
    }
    const { grant, channel } = authorization;
    channel.end(`${JSON.stringify({ version: 1, event: "ready", generation: grant.generation,
      endpoint: String(options.endpoint), pid: process.pid, nonce: grant.nonce,
      ...(process.platform === "linux" ? { epoch: grant.ownerIdentity.epoch } : {}) })}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
