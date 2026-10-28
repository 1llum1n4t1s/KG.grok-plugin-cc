import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("fake grok 1.0");
  process.exit(0);
}
const { SETTINGS_LOG: log, SETTINGS_READY: ready, SETTINGS_RELEASE: release,
  SETTINGS_EXIT: exited, SETTINGS_GATE: gate } = process.env;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const options = [{ id: "effort", category: "thought_level", currentValue: "low", options: [{ value: "high" }] },
  { id: "model", category: "model", currentValue: "default", options: [{ value: "requested" }] }];
function gated(action) {
  fs.writeFileSync(ready, "ready");
  const timer = setInterval(() => {
    if (!fs.existsSync(release)) return;
    clearInterval(timer);
    action();
  }, 10);
}
const expiry = setTimeout(() => process.exit(2), 20000);
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => { clearTimeout(expiry); fs.writeFileSync(exited, "exiting"); });
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  fs.appendFileSync(log, `${message.method}\n`);
  if (message.method === "initialize") return reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (message.method === "session/new") {
    const sendSession = () => reply(message.id, { sessionId: "s", models: { currentModelId: "default", availableModels: [{ modelId: "requested" }] }, configOptions: options });
    return gate === "new" ? gated(sendSession) : sendSession();
  }
  if (message.method === "session/load") {
    const sendSession = () => reply(message.id, { models: { currentModelId: "default", availableModels: [{ modelId: "requested" }] }, configOptions: options });
    return gate === "load" ? gated(sendSession) : sendSession();
  }
  if (message.method === "session/set_model") {
    const reject = () => send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
    return gate === "model" ? gated(reject) : reply(message.id, {});
  }
  if (message.method === "session/set_config_option") return reply(message.id, {});
  if (message.method === "session/prompt") return reply(message.id, { stopReason: "end_turn" });
  return reply(message.id, {});
});
