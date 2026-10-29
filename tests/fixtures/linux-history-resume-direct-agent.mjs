import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("fixture grok agent stdio");
  process.exit(0);
}
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
process.on("exit", () => fs.writeFileSync(process.env.SETTINGS_EXIT, "exiting"));
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", line => {
  const { id, method } = JSON.parse(line);
  let result = {};
  if (method === "initialize") result = { protocolVersion: 1, agentCapabilities: {} };
  if (method === "session/new") result = { sessionId: "independent-direct-session", configOptions: [] };
  if (method === "session/prompt") result = { stopReason: "end_turn" };
  send({ jsonrpc: "2.0", id, result });
});
