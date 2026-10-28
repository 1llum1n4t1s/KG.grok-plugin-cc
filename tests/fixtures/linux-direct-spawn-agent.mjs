import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("fake grok 1.0");
  process.exit(0);
}
fs.writeFileSync(process.env.GROK_TEST_AGENT_STARTED, "started");
const expiry = setTimeout(() => process.exit(2), 20000);
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => { clearTimeout(expiry); fs.writeFileSync(process.env.GROK_TEST_AGENT_EXITED, "exiting"); });
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", () => {});
