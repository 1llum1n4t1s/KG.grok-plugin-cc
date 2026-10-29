import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version") || process.argv.includes("--help")) {
  console.log("fake grok 1.0");
  process.exit(0);
}
const raw = fs.readFileSync("/proc/self/stat", "utf8");
const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
const identity = { pid: process.pid, group: Number(fields[2]), start: fields[19] };
if (!Number.isInteger(identity.group) || !identity.start) throw new Error("Agent process identity unavailable");
fs.writeFileSync(process.env.GROK_TEST_AGENT_STARTED, JSON.stringify(identity));
const expiry = setTimeout(() => process.exit(2), 20000);
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => { clearTimeout(expiry); fs.writeFileSync(process.env.GROK_TEST_AGENT_EXITED, JSON.stringify(identity)); });
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", () => {});
