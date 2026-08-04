import path from "node:path";
import process from "node:process";

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-grok-acp`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  // platform を引数で受け取る関数なので、パスの組み立ても実行環境ではなく
  // その platform に従う。path.join だと Windows 上で unix 用の値を作ったときに
  // 区切りがバックスラッシュになってしまう。
  return `unix:${path.posix.join(sessionDir, "broker.sock")}`;
}

export function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }

  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
