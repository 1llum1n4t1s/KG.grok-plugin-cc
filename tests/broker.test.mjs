import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { BROKER_BUSY_RPC_CODE } from "../plugins/grok/scripts/lib/acp.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/grok/scripts/acp-broker.mjs", import.meta.url));
const frame = (message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";

async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function broker(t, scenario) {
  const root = makeTempDir("grok-broker-e2e-");
  const fake = installFakeGrok(scenario);
  const fallback = installFakeGrok({ replies: [{ text: "WRONG_BINARY" }] });
  // broker の既存起動経路も含め、実物の Grok を PATH から選ばせない。
  const env = { ...fake.env, PATH: `${fallback.binDir}${path.delimiter}${fake.env.PATH ?? ""}` };
  const endpoint = createBrokerEndpoint(root);
  const sockets = [];
  const child = spawn(process.execPath, [SCRIPT, "serve", "--endpoint", endpoint, "--cwd", root], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) await sendBrokerShutdown(endpoint, 2000);
    await Promise.race([exited, new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref();
    })]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(fake.binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(fallback.binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true, stderr);
  assert.ok(fake.readState()?.pid, "the isolated fake Grok must have initialized");
  assert.equal(fallback.readState(), null, "GROK_BIN must take precedence over the other fake on PATH");

  async function client() {
    const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    sockets.push(socket);
    socket.setEncoding("utf8");
    const messages = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        messages.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return { socket, messages,
      response: (id) => until(() => messages.find((message) => message.id === id && !message.method), `Missing response ${id}: ${stderr}`) };
  }
  return { fake, client };
}

test("broker forwards coalesced prompt cancellation without releasing the active owner", async (t) => {
  const b = await broker(t, { holdPrompt: true });
  const owner = await b.client();
  const other = await b.client();
  owner.socket.write(
    frame({ id: 1, method: "session/prompt", params: { sessionId: "held", prompt: [{ type: "text", text: "hold" }] } }) +
    frame({ method: "session/cancel", params: { sessionId: "held" } }) +
    frame({ id: 2, method: "session/cancel", params: { sessionId: "held" } })
  );
  await until(() => b.fake.readState()?.cancels.length === 2, "coalesced cancellations were blocked behind prompt");
  assert.deepEqual((await owner.response(2)).result, {});
  owner.socket.write(frame({ id: 6, method: "session/new", params: {} }));
  assert.ok((await owner.response(6)).result.sessionId);
  assert.equal(owner.messages.some((message) => message.id === 1 && !message.method), false);
  other.socket.write(frame({ id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }));
  assert.equal((await other.response(3)).error.code, BROKER_BUSY_RPC_CODE);
  other.socket.write(frame({ id: 4, method: "session/cancel", params: { sessionId: "held" } }));
  assert.deepEqual((await other.response(4)).result, {});
  other.socket.write(frame({ id: 5, method: "session/new", params: {} }));
  assert.equal((await other.response(5)).error.code, BROKER_BUSY_RPC_CODE);
});

test("broker preserves fragmented frames and routes permission replies to the active owner", async (t) => {
  const b = await broker(t, { replies: [{
    text: "PERMISSION_OK",
    requestPermissionFor: { title: "Read source", kind: "read", rawInput: { path: "source.mjs" } }
  }] });
  const owner = await b.client();
  const other = await b.client();
  owner.socket.write(
    frame({ id: 10, method: "session/prompt", params: { sessionId: "permission", prompt: [{ type: "text", text: "read" }] } }) +
    frame({ id: 11, method: "initialize", params: {} })
  );
  const permission = await until(() => owner.messages.find((message) => message.method === "session/request_permission"), "owner did not receive permission request");
  assert.equal(other.messages.some((message) => message.method === "session/request_permission"), false);
  other.socket.write(frame({ id: 20, method: "session/new", params: {} }));
  assert.equal((await other.response(20)).error.code, BROKER_BUSY_RPC_CODE);
  // 別接続の偽応答は、本来の要求を消したり Grok へ転送したりしない。
  other.socket.write(frame({ id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } }));
  assert.equal((await other.response(permission.id)).error.code, -32600);
  const fragment = frame({ id: 12, method: "session/cancel", params: { sessionId: "permission" } });
  const split = fragment.length - 8;
  owner.socket.write(frame({ id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } }) + fragment.slice(0, split));
  assert.ok((await owner.response(11)).result.agentCapabilities);
  assert.equal((await owner.response(10)).result.stopReason, "end_turn");
  owner.socket.write(fragment.slice(split));
  assert.deepEqual((await owner.response(12)).result, {});
  assert.equal(owner.messages.some((message) => message.error?.code === -32700), false);
  other.socket.write(frame({ id: 21, method: "session/new", params: {} }));
  assert.ok((await other.response(21)).result.sessionId);
});
