#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

if (process.argv.includes("--owned-child")) {
  process.send?.("ready");
  setTimeout(() => process.exit(0), 30000);
} else if (process.argv.includes("--version")) {
  console.log("grok 9.9.9 (fixture)");
} else if (process.argv.includes("--help")) {
  console.log("agent stdio");
} else {
  const child = spawn(process.execPath, [process.argv[1], "--owned-child"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  const ready = new Promise(resolve => child.once("message", resolve));
  // On POSIX, reap our child before exiting so a zombie cannot retain the group.
  process.on("SIGTERM", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    child.once("exit", () => process.exit(0));
  });
  const send = message => process.stdout.write(JSON.stringify(message) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", async line => {
    const { id, method, params } = JSON.parse(line);
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (method === "session/new") send({ jsonrpc: "2.0", id, result: { sessionId: "owned-fixture", models: { currentModelId: "fake", availableModels: [{ modelId: "fake", name: "fake" }] }, configOptions: [] } });
    else if (method === "session/prompt") {
      await ready;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(child.pid) } } } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    } else if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
  });
}
