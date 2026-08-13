import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { processCommandContains, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "GROK_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "GROK_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_FILE = "broker.lock";
/** ロックを持ったプロセスが落ちた場合に、その後の全員が詰まらないようにする。 */
const BROKER_LOCK_STALE_MS = 30000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 2000;

export function createBrokerSessionDir(prefix = "gkc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, timeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS) {
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");

    // 接続はできたが応答が返らないブローカーで固まると、SessionEnd の
    // 短い予算を使い切って後続の後始末に到達しなくなる。必ず時間で切る。
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  }));
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = resolveBrokerStateFile(cwd);
  const temporaryFile = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryFile, stateFile);
  } finally {
    if (fs.existsSync(temporaryFile)) {
      fs.rmSync(temporaryFile, { force: true });
    }
  }
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

function resolveBrokerLockFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
}

/**
 * ブローカー起動の排他ロック。取れたら true。
 *
 * 起動判定は「読んで、無ければ spawn して、書く」の 3 段なので、
 * 同じリポジトリで 2 プロセスが同時に走るとブローカーが二重に立ち、
 * 負けた側と配下の grok が誰にも参照されないまま残り続ける。
 */
function acquireBrokerLock(cwd) {
  const lockFile = resolveBrokerLockFile(cwd);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  try {
    fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  // ロックを持ったまま落ちたプロセスの置き土産は、時間で無効にする。
  try {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (age > BROKER_LOCK_STALE_MS) {
      fs.rmSync(lockFile, { force: true });
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      return true;
    }
  } catch {
    // 別プロセスと競り合って消えた場合は、取れなかったものとして扱う。
  }

  return false;
}

function releaseBrokerLock(cwd) {
  try {
    fs.rmSync(resolveBrokerLockFile(cwd), { force: true });
  } catch {
    // 後始末の失敗は起動の成否に影響しない。
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  const authMode = (options.env ?? process.env).XAI_API_KEY ? "api-key" : "browser";
  if (existing?.authMode && existing.authMode !== authMode) {
    // 異なる認証コンテキストの broker は再利用しない。
  } else if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (!acquireBrokerLock(cwd)) {
    // 別プロセスが今まさに立ち上げている。その結果を待って使い回す。
    const deadline = Date.now() + (options.timeoutMs ?? 2000);
    while (Date.now() < deadline) {
      const rival = loadBrokerSession(cwd);
      if (rival && (!rival.authMode || rival.authMode === authMode) && (await isBrokerEndpointReady(rival.endpoint))) {
        return rival;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 待っても使えなければ、呼び出し側の直接起動フォールバックへ委ねる。
    return null;
  }

  try {
    return await startBrokerSession(cwd, options, existing);
  } finally {
    releaseBrokerLock(cwd);
  }
}

async function startBrokerSession(cwd, options, existing) {
  // ロックを取った後にもう一度見る。待っている間に別プロセスが
  // 立ち上げ切っているかもしれない。
  const current = loadBrokerSession(cwd);
  const authMode = (options.env ?? process.env).XAI_API_KEY ? "api-key" : "browser";
  if (current && current.endpoint !== existing?.endpoint && (!current.authMode || current.authMode === authMode) && (await isBrokerEndpointReady(current.endpoint))) {
    return current;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      // 既定で確実に止める。渡し忘れるとファイルだけ消えてプロセスが残る。
      killProcess: options.killProcess ?? terminateProcessTree
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../acp-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    // 起動に失敗したときのログは、原因がそこにしか残らない。
    // 消してしまうと利用者は「静かに直接起動へ落ちた」ことしか分からない。
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? terminateProcessTree,
      keepLog: true
    });
    // 直接起動へ静かに落ちると、共有ブローカーが壊れていることに気づけない。
    process.stderr.write(`Shared Grok broker did not start; falling back to a direct run. Log: ${logFile}\n`);
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    authMode
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null,
  keepLog = false
}) {
  if (Number.isFinite(pid) && killProcess && processCommandContains(pid, "acp-broker.mjs")) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (!keepLog && logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
