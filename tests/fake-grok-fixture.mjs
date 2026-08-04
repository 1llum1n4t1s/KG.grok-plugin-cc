/**
 * ACP を話す偽の `grok` を用意するテスト用フィクスチャ。
 *
 * 本家 codex-plugin-cc は fake-codex-fixture.mjs で Codex の app-server を
 * 模していた。こちらは `grok agent stdio` が話す ACP を模す。
 *
 * 偽 grok が対応するもの:
 *   - `grok --version` / `grok agent stdio --help`（可用性チェック用）
 *   - initialize / session/new / session/set_model / session/prompt
 *     / session/cancel / session/list
 *
 * 応答内容はシナリオファイル（JSON）で差し替える。1 回目と 2 回目の
 * session/prompt で違う返答をさせられるので、壊れた JSON を返してから
 * 訂正させる経路も試験できる。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

const FAKE_GROK_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const SCENARIO_PATH = process.env.FAKE_GROK_SCENARIO;
const STATE_PATH = process.env.FAKE_GROK_STATE;

const scenario = SCENARIO_PATH && fs.existsSync(SCENARIO_PATH)
  ? JSON.parse(fs.readFileSync(SCENARIO_PATH, "utf8"))
  : {};

const argv = process.argv.slice(2);

if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write("grok 9.9.9 (fake) [test]\\n");
  process.exit(0);
}

if (argv[0] === "agent" && argv[1] === "stdio" && argv.includes("--help")) {
  process.stdout.write("Run the agent over stdio\\n");
  process.exit(0);
}

if (!(argv[0] === "agent" && argv[1] === "stdio")) {
  process.stderr.write("fake grok: unsupported invocation: " + argv.join(" ") + "\\n");
  process.exit(2);
}

// 呼び出しの記録。テストから何が起きたか検証できるようにする。
const state = { prompts: [], models: [], cancels: [], sessions: 0 };
function persist() {
  if (STATE_PATH) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  }
}
persist();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

let promptIndex = 0;

function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        authMethods: [{ id: "xai.api_key", name: "API key" }],
        _meta: {
          agentVersion: "9.9.9",
          modelState: {
            currentModelId: scenario.defaultModel ?? "grok-fake-nonreasoning",
            availableModels: (scenario.availableModels ?? ["grok-fake-nonreasoning", "grok-4.5"]).map((m) => ({ modelId: m, name: m }))
          }
        }
      }});
      return;

    case "session/new": {
      if (scenario.authError) {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      state.sessions += 1;
      persist();
      send({ jsonrpc: "2.0", id, result: {
        sessionId: "fake-session-" + state.sessions,
        models: {
          currentModelId: scenario.defaultModel ?? "grok-fake-nonreasoning",
          availableModels: (scenario.availableModels ?? ["grok-fake-nonreasoning", "grok-4.5"]).map((m) => ({ modelId: m, name: m }))
        }
      }});
      return;
    }

    case "session/set_model":
      state.models.push(params.modelId);
      persist();
      send({ jsonrpc: "2.0", id, result: {} });
      return;

    case "session/cancel":
      state.cancels.push(params.sessionId);
      persist();
      send({ jsonrpc: "2.0", id, result: {} });
      return;

    case "session/list":
      send({ jsonrpc: "2.0", id, result: { sessions: scenario.sessions ?? [] } });
      return;

    case "session/prompt": {
      state.prompts.push(params.prompt.map((block) => block.text).join(""));
      persist();

      const replies = scenario.replies ?? [];
      const reply = replies[promptIndex] ?? replies[replies.length - 1] ?? { text: "no scenario reply" };
      promptIndex += 1;

      // 権限確認を求めるシナリオ: クライアントの応答を待ってから続ける。
      if (reply.requestPermissionFor) {
        pendingReply = { id, reply, sessionId: params.sessionId };
        send({
          jsonrpc: "2.0",
          id: 9000 + promptIndex,
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "call-1", title: reply.requestPermissionFor.title, rawInput: reply.requestPermissionFor.rawInput },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" }
            ]
          }
        });
        return;
      }

      emitReply(id, params.sessionId, reply);
      return;
    }

    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported: " + method } });
  }
}

let pendingReply = null;

function emitReply(id, sessionId, reply) {
  for (const thought of reply.thoughts ?? []) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought } } } });
  }
  for (const tool of reply.tools ?? []) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: tool } } });
  }
  // 本物と同じくトークン単位の断片で流す。
  for (const chunk of String(reply.text ?? "").match(/.{1,8}/gs) ?? []) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } } });
  }
  send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId, update: { sessionUpdate: "response_completed", usage: { input_tokens: 10, output_tokens: 20 } } } });
  send({ jsonrpc: "2.0", id, result: { stopReason: reply.stopReason ?? "end_turn" } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  // 権限確認への応答が返ってきた。
  if (pendingReply && message.id !== undefined && !message.method) {
    const outcome = message.result?.outcome?.outcome;
    const optionId = message.result?.outcome?.optionId;
    const { id, reply, sessionId } = pendingReply;
    pendingReply = null;
    const denied = outcome !== "selected" || optionId !== "allow";
    emitReply(id, sessionId, denied ? (reply.onDenied ?? { text: "denied", stopReason: "cancelled" }) : reply);
    return;
  }

  handle(message);
});
`;

/**
 * 偽 grok を一時ディレクトリへ設置し、テスト用の環境変数を返す。
 *
 * @param {object} scenario 応答シナリオ
 * @returns {{ env: NodeJS.ProcessEnv, binDir: string, statePath: string, readState: () => object }}
 */
export function installFakeGrok(scenario = {}) {
  const binDir = makeTempDir("grok-fake-bin-");
  const scriptPath = path.join(binDir, "fake-grok.mjs");
  const scenarioPath = path.join(binDir, "scenario.json");
  const statePath = path.join(binDir, "state.json");

  writeExecutable(scriptPath, FAKE_GROK_SOURCE);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf8");

  // GROK_BIN は実行ファイルのパスとして扱われる。node スクリプトを直接
  // 指せないので、node を呼ぶ薄いラッパーを置く。
  const isWindows = process.platform === "win32";
  const wrapperPath = path.join(binDir, isWindows ? "grok.cmd" : "grok");
  const wrapperSource = isWindows
    ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;
  writeExecutable(wrapperPath, wrapperSource);

  return {
    binDir,
    statePath,
    env: {
      ...process.env,
      GROK_BIN: wrapperPath,
      FAKE_GROK_SCENARIO: scenarioPath,
      FAKE_GROK_STATE: statePath,
      // 実物の資格情報を巻き込まないよう明示的に差し替える。
      XAI_API_KEY: "fake-key-for-tests",
      // 共有ブローカーは detached プロセスとして残るため、テストでは使わない。
      // 各コマンドが自分で偽 grok を起動し、終了時に確実に片付ける。
      GROK_COMPANION_DISABLE_BROKER: "1"
    },
    readState() {
      return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
    }
  };
}
