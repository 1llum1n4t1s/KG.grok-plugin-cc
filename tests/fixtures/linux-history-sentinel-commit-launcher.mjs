import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.env.GROK_LINUX_SIM_STATE_DIR, barrier = path.join(root, "state.lock");
const generation = process.env.GROK_HISTORY_SENTINEL_GENERATION, nonce = process.env.GROK_HISTORY_SENTINEL_NONCE;
const sentinel = fileURLToPath(new URL("../../plugins/grok/scripts/lib/linux-state-sentinel.mjs", import.meta.url));
const rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
const barrierFd = fs.openSync(barrier, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  execFileSync("/usr/bin/flock", ["-x", "-n", "3"], { stdio: ["ignore", "ignore", "pipe", rootFd], timeout: 5000 });
  const child = spawn(process.execPath, [sentinel, "sentinel", barrier, generation, nonce], {
    detached: true, env: { ...process.env, GROK_SENTINEL_HISTORY_ROOT_LOCK: nonce },
    stdio: ["pipe", "pipe", "pipe", barrierFd, rootFd]
  });
  child.stdin.on("error", () => {});
  let received = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", value => process.stderr.write(value));
  child.stdout.on("data", value => {
    received += value;
    if (received.split("\n").includes("started")) {
      received = ""; child.stdin.write(`commit:${nonce}`);
    }
  });
  child.on("exit", (code, signal) => { if (code !== 0) process.exitCode = code || (signal ? 1 : 0); });
} finally { fs.closeSync(barrierFd); fs.closeSync(rootFd); }
