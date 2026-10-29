import { once } from "node:events";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { reserveDarwinTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { DARWIN_LEASE_SLOT_COUNT } from "../../plugins/grok/scripts/lib/darwin-worker-lease.mjs";

const [{ workspace, count = DARWIN_LEASE_SLOT_COUNT }] = await once(process, "message");
const reservations = [];
const job = id => ({ id, workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "capacity-e2e", grokPromptState: "not-sent" });

// OS の失敗を捕捉しても同じ例外をそのまま返す。機器 ID や path、出力本文は保持しない。
let observedFailures = [];
function reserveObserved(item, injection = null) {
  const exec = childProcess.execFileSync, stat = fs.statSync;
  const failures = [], mountPoints = new Set();
  observedFailures = failures;
  const record = (operation, error) => {
    try {
      if (failures.length >= 8) return;
      const allowedCodes = new Set(["ETIMEDOUT", "EIO", "ENOENT", "EACCES", "EPERM", "EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "E2BIG", "EINVAL", "ENOSPC", "ENOTDIR", "EINTR", "EPIPE", "EFAULT", "EBADF", "ENXIO", "ENODEV", "ENOTSUP", "EOVERFLOW", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
      const code = typeof error?.code === "string" && allowedCodes.has(error.code) ? error.code : null;
      const status = Number.isInteger(error?.status) && error.status >= -255 && error.status <= 255 ? error.status : null;
      const allowedSignals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGPIPE", "SIGHUP", "SIGQUIT"]);
      const signal = typeof error?.signal === "string" && allowedSignals.has(error.signal) ? error.signal : null;
      failures.push({ operation, code, status, signal });
    } catch { /* 診断の失敗で元の例外を変えない。 */ }
  };
  const injectedError = kind => Object.assign(new Error("FIXTURE_PRIVATE_SHOULD_NOT_APPEAR"),
    kind === "timeout" ? { code: "ETIMEDOUT", signal: "SIGTERM", status: null } : { code: "EIO", signal: null, status: null });
  try {
    childProcess.execFileSync = function (command, ...args) {
      const operation = command === "/usr/sbin/ioreg" ? "ioreg" : command === "/sbin/mount" ? "mount" : null;
      try {
        if ((operation === "ioreg" && injection === "host-timeout") || (operation === "mount" && injection === "mount-eio")) {
          throw injectedError(injection === "host-timeout" ? "timeout" : "eio");
        }
        const value = exec.call(this, command, ...args);
        if (operation === "mount" && typeof value === "string") {
          try { for (const line of value.split("\n")) { const match = line.match(/^.+ on (.+) \(([^)]*)\)$/); if (match) mountPoints.add(match[1]); } } catch {}
        }
        return value;
      } catch (error) { if (operation) record(operation, error); throw error; }
    };
    fs.statSync = function (target, ...args) {
      try {
        if (injection === "mount-stat-eio" && typeof target === "string" && mountPoints.has(target)) throw injectedError("eio");
        return stat.call(this, target, ...args);
      } catch (error) { if (typeof target === "string" && mountPoints.has(target)) record("mount-stat", error); throw error; }
    };
    syncBuiltinESMExports();
    const value = reserveDarwinTrackedJob(item);
    observedFailures = [];
    return value;
  } finally { childProcess.execFileSync = exec; fs.statSync = stat; syncBuiltinESMExports(); }
}
try {
  for (let i = 0; i < count; i += 1) {
    reservations.push(reserveObserved(job(`capacity-${i}`)));
  }
  process.send({ type: "full", leases: reservations.map(reservation => reservation.lease) });
  let attempt = 0;
  while (true) {
    const [command] = await once(process, "message");
    if (command === "stop" || command === "exit") break;
    if (["host-timeout", "mount-eio", "mount-stat-eio"].includes(command)) {
      try {
        reserveObserved(job(`diagnostic-${command}`), command);
        process.send({ type: "accepted" });
      } catch (error) {
        process.send({ type: "rejected", message: error.message, diagnostics: observedFailures });
      }
      continue;
    }
    const originalSpawnSync = childProcess.spawnSync;
    if (command === "overflow-git-timeout") {
      childProcess.spawnSync = function (file, ...args) {
        if (file !== "git") return originalSpawnSync.call(this, file, ...args);
        const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
        return { error, status: null, signal: "SIGTERM", stdout: "", stderr: "" };
      };
      syncBuiltinESMExports();
    }
    try {
      const id = attempt === 0 ? "capacity-overflow" : `capacity-overflow-${attempt}`;
      attempt += 1;
      const extra = reserveObserved(job(id));
      reservations.push(extra);
      process.send({ type: "accepted", id, lease: extra.lease });
    } catch (error) {
      process.send({ type: "rejected", message: error.message, diagnostics: observedFailures });
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    }
  }
} catch (error) {
  process.send({ type: "failed", count: reservations.length, message: error.message, diagnostics: observedFailures });
}
process.disconnect();
