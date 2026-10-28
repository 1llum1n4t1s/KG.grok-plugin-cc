import { once } from "node:events";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [{ directory, stateGeneration, descendantMarker, fakeLockf, failFsync, auditFsync, restrictiveUmask, denyObserverOpen, probeTimeoutMs }] = await once(process, "message");
let observerOpenDenied = false;
try {
  if (restrictiveUmask) process.umask(0o400);
  if (denyObserverOpen) {
    const originalOpen = fs.openSync;
    fs.openSync = (file, flags, mode) => {
      if (file === `${directory}/slot-000.lease` && typeof flags === "number" && (flags & 3) === fs.constants.O_RDONLY) {
        observerOpenDenied = true;
        throw Object.assign(new Error("injected observer open denial"), { code: "EACCES" });
      }
      return originalOpen(file, flags, mode);
    };
    syncBuiltinESMExports();
  }
  const originalSpawnSync = childProcess.spawnSync;
  let fakeEnabled = false;
  let killSignal;
  let utilityTimeout;
  let utilityResult;
  let fsyncInjected = false;
  const fsyncCalls = [];
  if (fakeLockf) {
    childProcess.spawnSync = (command, args, options) => {
      if (!fakeEnabled || command !== "/usr/bin/lockf") return originalSpawnSync(command, args, options);
      killSignal = options.killSignal ?? null;
      utilityTimeout = options.timeout ?? null;
      const source = `const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(process.argv[1], 'started');
        setTimeout(() => process.exit(0), 8000);`;
      const result = originalSpawnSync(process.execPath, ["-e", source, fakeLockf], options);
      utilityResult = { errorCode: result.error?.code ?? null, signal: result.signal };
      return result;
    };
    syncBuiltinESMExports();
  }
  if (failFsync || auditFsync) {
    const originalFsync = fs.fsyncSync;
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd);
      fsyncCalls.push(stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other");
      if ((failFsync === "directory" && stat.isDirectory()) || (failFsync === "file" && stat.isFile())) {
        fsyncInjected = true;
        throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
      }
      return originalFsync(fd);
    };
    syncBuiltinESMExports();
  }
  const { acquireDarwinWorkerLease, withAvailableDarwinLease } = await import("../../plugins/grok/scripts/lib/darwin-worker-lease.mjs");
  let owner;
  try {
    const stat = fs.lstatSync(directory, { bigint: true });
    owner = acquireDarwinWorkerLease({ directory, stateGeneration, slot: 0, expectedDirectoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) } });
  } catch (error) {
    if (!failFsync) throw error;
    process.send({ type: "sync-failed", fsyncInjected, code: error.code ?? null });
  }
  if (failFsync && owner) {
    fs.closeSync(owner.fd);
    process.send({ type: "sync-returned", fsyncInjected });
  }
  if (failFsync) {
    // 子を生存させ、別プロセスから FD 解放を検証してから終了する。
    await once(process, "message");
    process.disconnect();
  } else if (fakeLockf) {
    fs.closeSync(owner.fd);
    fakeEnabled = true;
    const stat = fs.lstatSync(directory, { bigint: true });
    const context = { stateGeneration, expectedDirectory: directory, expectedDirectoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
      ...(probeTimeoutMs === undefined ? {} : { timeoutMs: probeTimeoutMs }) };
    let called = false;
    const before = performance.now();
    const result = withAvailableDarwinLease(owner.lease, context, () => { called = true; });
    const elapsedMs = performance.now() - before;
    process.send({ type: "timeout-probed", result, called, elapsedMs, killSignal, utilityTimeout, utilityResult, started: fs.existsSync(fakeLockf) }, () => process.disconnect());
  } else {
    if (descendantMarker) {
      // 子はリース FD を受け取らず、親の終了後に独立して終了する。
      spawn(process.execPath, ["-e", `const fs = require('node:fs');
        setTimeout(() => fs.writeFileSync(process.argv[1], 'exited'), 3000);`, descendantMarker],
      { stdio: "ignore" });
    }
    process.send({ type: "acquired", lease: owner.lease, fsyncCalls, observerOpenDenied });
    await once(process, "message");
    process.disconnect();
  }
} catch (error) {
  process.send({ type: "error", message: error.message, code: error.code ?? null, observerOpenDenied }, () => process.disconnect());
}
