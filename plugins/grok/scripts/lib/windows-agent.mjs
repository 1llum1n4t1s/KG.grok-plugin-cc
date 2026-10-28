import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildShellCommand, getProcessSnapshot } from "./process.mjs";

const supervisorScript = fileURLToPath(new URL("./windows-agent-supervisor.ps1", import.meta.url));

/** Windowsのdirect agent専用。workerや共有brokerをJobへ所属させない。 */
export async function spawnWindowsAgent(cwd, command, args, options = {}) {
  const owner = (options.getProcessSnapshotImpl ?? getProcessSnapshot)(process.pid);
  if (!/^win32-filetime:[0-9]+$/.test(owner?.startKey ?? "")) {
    throw new Error("Windows agent owner identity could not be pinned before startup.");
  }
  const env = options.env ?? process.env;
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const shell = env.ComSpec || process.env.ComSpec || path.win32.join(windowsRoot, "System32", "cmd.exe");
  const pipeName = `grok-owned-agent-${randomUUID()}`;
  const nonce = randomUUID();
  const config = { ParentPid: process.pid, ParentStartKey: owner.startKey, Cwd: cwd,
    ApplicationName: shell, CommandLine: `"${shell}" /d /s /c "${buildShellCommand(command, args)}"`,
    PipeName: pipeName, Nonce: nonce };
  const server = (options.createServerImpl ?? net.createServer)();
  const peers = new Set();
  let control;
  let proc;
  let procClosed = false;
  let controlClosed = false;
  let readySettled = false;
  let readyTimer;
  let closePromise;
  let closeRequested = false;
  let resolveReady;
  let rejectReady;
  let resolveFinished;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // ACPはspawn直後からstdioを購読する。ready待ちを開始する前の失敗も保持する。
  void ready.catch(() => {});
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const owned = {
    proc: null,
    ready,
    stopConfirmed: false,
    close() {
      if (closePromise) return closePromise;
      closeRequested = true;
      closePromise = (async () => {
        if (control && !control.destroyed) {
          // Windows pipe shutdownは短いEOF期限で両端を閉じ得る。ACKまではwriteだけ。
          if (owned.stopConfirmed) control.end();
          else control.write(`${JSON.stringify({ method: "close" })}\n`);
        }
        let timer;
        await Promise.race([finished, new Promise((resolve) => {
          timer = setTimeout(resolve, options.closeTimeoutMs ?? (control ? 4000 : 14000));
        })]);
        clearTimeout(timer);
        cleanup();
        return owned.stopConfirmed;
      })();
      return closePromise;
    }
  };
  const failReady = (error) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    rejectReady(error);
  };
  const cleanup = () => {
    clearTimeout(readyTimer);
    for (const socket of peers) socket.destroy();
    server.close();
  };
  const maybeFinished = () => {
    if (procClosed && (!control || controlClosed)) {
      resolveFinished();
      cleanup();
    }
  };
  server.on("connection", (socket) => {
    peers.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8192) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.nonce !== nonce || (control && control !== socket)) { socket.destroy(); return; }
        if (message.state === "ready" && !control) {
          control = socket;
          if (!readySettled) {
            readySettled = true;
            clearTimeout(readyTimer);
            resolveReady();
          }
          // cancelはcontrollerの登録・readyより先に到着できる。要求を落とさない。
          if (closeRequested) control.write(`${JSON.stringify({ method: "close" })}\n`);
        } else if (socket === control && message.state === "stopped" && Number.isInteger(message.exitCode)) {
          // process closeやPID不在ではなく、同じhJobのActiveProcesses=0 ACKだけを採る。
          owned.stopConfirmed = true;
          socket.end();
        } else { socket.destroy(); return; }
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      peers.delete(socket);
      if (socket === control) controlClosed = true;
      maybeFinished();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(`\\\\.\\pipe\\${pipeName}`, () => { server.removeListener("error", reject); resolve(undefined); });
    });
    const checked = options.beforeSpawn?.();
    if (checked && typeof checked.then === "function") {
      void Promise.resolve(checked).catch(() => {});
      throw new TypeError("Windows agent startup verification must be synchronous.");
    }
    proc = (options.spawnImpl ?? spawn)(path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supervisorScript],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    owned.proc = proc;
    proc.on("error", (error) => { failReady(error); procClosed = true; maybeFinished(); });
    proc.on("close", () => {
      procClosed = true;
      failReady(new Error("Windows owned agent supervisor exited before startup was confirmed."));
      maybeFinished();
    });
    readyTimer = setTimeout(() => failReady(new Error("Windows owned agent supervisor startup timed out.")), 10000);
    readyTimer.unref?.();
    server.on("error", failReady);
    // nonceをargv/envへ載せない。ready前はこの長さ付きbootstrap以外を送らない。
    const bootstrap = Buffer.from(JSON.stringify(config), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bootstrap.length);
    proc.stdin.on("error", failReady);
    proc.stdin.write(Buffer.concat([length, bootstrap]));
    return owned;
  } catch (error) {
    failReady(error);
    cleanup();
    throw error;
  }
}
