import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";

// CLI の事前確認は agent 起動や PID 記録を行わず終了する。
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  process.stdout.write(process.argv.includes("--version") ? "grok 9.9.9 (fake)\n" : "Run the agent over stdio\n");
  process.exit(0);
}

// 親が失敗しても、このfixtureと子は専用markerまたは期限で自分から終了する。
const directory = process.env.POSIX_OWNED_FIXTURE;
const stop = `${directory}/stop`;
setTimeout(() => process.exit(0), 12_000);
setInterval(() => { if (fs.existsSync(stop)) process.exit(0); }, 20);
if (process.argv.includes("--grandchild")) {
  process.on("SIGTERM", () => {});
  process.send({ pid: process.pid });
} else {
  fs.writeFileSync(`${directory}/agent.pid`, String(process.pid));
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.method !== "initialize") return;
    if (process.env.POSIX_OWNED_MODE === "handshake") return;
    if (["remaining", "natural"].includes(process.env.POSIX_OWNED_MODE)) {
      const child = spawn(process.execPath, [process.argv[1], "--grandchild"], {
        env: process.env, stdio: ["ignore", "ignore", "inherit", "ipc"],
        // Windows E2E は libuv 自身の Job を使わず supervisor の所有を検証する。
        detached: process.platform === "win32" && process.env.WINDOWS_OWNED_DETACHED_DESCENDANT === "1"
      });
      const pid = await new Promise((resolve, reject) => {
        child.once("message", (value: { pid: number }) => resolve(value.pid));
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Grandchild exited before readiness")));
      });
      fs.writeFileSync(`${directory}/grandchild.pid`, String(pid));
      child.disconnect();
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} } }) + "\n");
    if (process.env.POSIX_OWNED_MODE === "natural") setTimeout(() => process.exit(0), 100);
  });
}
