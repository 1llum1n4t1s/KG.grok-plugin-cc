import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("fixture grok agent stdio");
  process.exit(0);
}
fs.writeFileSync(process.env.GROK_LINUX_SIM_AGENT_PID, String(process.pid), { flag: "wx", mode: 0o600 });
const lines = readline.createInterface({ input: process.stdin });
if (process.env.GROK_LINUX_SIM_COMPLETE === "1") lines.on("line", line => {
  const message = JSON.parse(line), { id, method, params } = message;
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (method === "session/new") {
    if (process.env.GROK_LINUX_SIM_FAILURE_READY && process.env.GROK_LINUX_SIM_FAILURE_RELEASE) {
      fs.writeFileSync(process.env.GROK_LINUX_SIM_FAILURE_READY, "ready", { flag: "wx", mode: 0o600 });
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.GROK_LINUX_SIM_FAILURE_RELEASE)) return;
        clearInterval(timer);
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: `fixture external failure: ${'🚨"\\\n'.repeat(6000)}` } });
      }, 20);
    } else send({ jsonrpc: "2.0", id, result: { sessionId: "fixture-session", configOptions: [] } });
  }
  else if (method === "session/prompt") {
    if (process.env.GROK_LINUX_SIM_PROMPT_MARKER) fs.writeFileSync(process.env.GROK_LINUX_SIM_PROMPT_MARKER, "prompt", { flag: "wx", mode: 0o600 });
    if (process.env.GROK_LINUX_SIM_HOLD_PROMPT === "1") return;
    const length = Number(process.env.GROK_LINUX_SIM_REPLY_BYTES);
    const text = Number.isSafeInteger(length) && length > 0 && length <= 4 * 1024 * 1024 ? "x".repeat(length) : "fixture complete";
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else send({ jsonrpc: "2.0", id, result: {} });
});
lines.on("close", () => process.exit(0));
