import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { inspectPosixStateLockScope, migratePosixStateLock } from "../../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { withDarwinLegacyLockMigration, DARWIN_LEGACY_MIGRATION_DIR } from "../../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";
import { initializeDarwinLeaseLedger } from "../../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";

const [stateDir, mode = "normal", gate = "", timeout = "7500"] = process.argv.slice(2);
if (mode === "reject-thenable") process.on("unhandledRejection", () => fs.writeSync(1, "UNHANDLED\n"));
function forgedBarrier({ scope }) {
  const dir = path.join(stateDir, "state.lock"), native = path.join(dir, "native.lock"), marker = path.join(dir, "protocol.json");
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(native, "", { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(marker, "wx", 0o600);
  try {
    const payload = { protocol: "posix-local-v3", hostId: scope.hostId, fileSystem: "apfs", directoryIdentity: scope.directoryIdentity,
      barrierIdentity: identity(fs.lstatSync(dir, { bigint: true })), lockIdentity: identity(fs.lstatSync(native, { bigint: true })),
      markerIdentity: identity(fs.fstatSync(fd, { bigint: true })), epoch: "4c1f5f62-b6e0-40a7-8ee3-7dd6dc769876" };
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
    return payload;
  } finally { fs.closeSync(fd); }
}
try {
  const result = withDarwinLegacyLockMigration(stateDir, {
    expectedStateDir: stateDir, offlineConfirmed: mode === "truthy-offline" ? "true" : true,
    localOnly: mode === "truthy-local" ? "true" : true, inspectScope: inspectPosixStateLockScope,
    verifyInventory: mode === "forged" ? () => true
      : mode === "async-callback" ? async () => { await new Promise(resolve => setTimeout(resolve, 10)); fs.writeFileSync(path.join(stateDir, "async-effect"), "unsafe"); return true; }
      : mode === "reject-thenable" ? () => Promise.reject(new Error("injected rejected thenable"))
      : mode === "reentry" ? () => {
        try {
          withDarwinLegacyLockMigration(stateDir, { expectedStateDir: stateDir, offlineConfirmed: true, localOnly: true,
            inspectScope: inspectPosixStateLockScope, verifyInventory: () => true,
            runMigration: () => migratePosixStateLock(stateDir, { expectedStateDir: stateDir, prepareDarwinGeneration: initializeDarwinLeaseLedger }), timeoutMs: 250 });
          throw new Error("unexpectedly accepted nested migration");
        } catch (error) {
          if (!/reentr/i.test(error.message)) throw error;
        }
        return true;
      }
      : ({ stateDir: dir }) => {
      const allowed = new Set(["state.lock", DARWIN_LEGACY_MIGRATION_DIR, "worker-leases", "darwin-lease-ledger.json"]);
      if (fs.readdirSync(dir).some(name => !allowed.has(name))) throw new Error("Unexpected fixture inventory");
      return true;
    },
    runMigration: mode === "forged-barrier" ? forgedBarrier : mode === "forged" ? ({ scope }) => ({ protocol: "posix-local-v3", hostId: scope.hostId,
      fileSystem: "apfs", directoryIdentity: scope.directoryIdentity, epoch: "4c1f5f62-b6e0-40a7-8ee3-7dd6dc769876" })
      : () => migratePosixStateLock(stateDir, { expectedStateDir: stateDir, prepareDarwinGeneration: initializeDarwinLeaseLedger }),
    onStep: name => {
      if (name !== gate) return;
      fs.writeSync(1, `PAUSE:${name}\n`);
      process.kill(process.pid, "SIGSTOP");
    },
    timeoutMs: Number(timeout)
  });
  process.stdout.write(`${JSON.stringify({ success: true, protocol: result.protocol })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ success: false, error: error.message })}\n`);
  process.exitCode = 1;
}
