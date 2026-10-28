import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import * as migration from "../../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";
import { verifyDarwinLegacyPreflight, assertDarwinLegacyPreflightToken, prepareDarwinLegacyBarrier } from "../../plugins/grok/scripts/lib/state.mjs";

const [stateDir, mode = "once", timeout = "7500"] = process.argv.slice(2);
try {
  if (typeof migration.acquireDarwinMigrationGuard !== "function") throw new Error("fixed guard acquisition API is unavailable");
  const guard = migration.acquireDarwinMigrationGuard(stateDir, Number(timeout));
  const { context } = guard;
  assert.ok(Object.isFrozen(context));
  assert.equal(migration.assertDarwinLegacyGuardContext(context), true);
  if (mode === "guard-identity") {
    const stat = fs.lstatSync(path.join(stateDir, ".darwin-legacy-migration", "native.lock"), { bigint: true });
    assert.ok(Object.isFrozen(context.guardIdentity));
    assert.deepEqual(context.guardIdentity, { dev: String(stat.dev), ino: String(stat.ino) });
  }
  if (mode === "forged-state-completion") {
    if (typeof migration.publishDarwinMigrationCompletion !== "function") throw new Error("fixed completion publisher is unavailable");
    let accessed = false;
    const fake = Object.defineProperty({}, "check", { get() { accessed = true; throw new Error("untrusted getter"); } });
    assert.throws(() => migration.publishDarwinMigrationCompletion(context, fake));
    assert.equal(accessed, false, "publisher evaluated an unverified state capability");
  }
  if (mode === "forged-backup-token") {
    if (typeof migration.assertDarwinLegacyLockBackup !== "function") throw new Error("fixed backup verifier is unavailable");
    let accessed = false;
    const fake = Object.defineProperty({}, "dev", { get() { accessed = true; throw new Error("untrusted getter"); } });
    assert.throws(() => migration.assertDarwinLegacyLockBackup(context, fake));
    assert.equal(accessed, false, "backup verifier evaluated an unverified preflight token");
  }
  if (mode === "forged-manifest-authorization") {
    if (typeof migration.writeDarwinMigrationManifest !== "function") throw new Error("fixed manifest writer is unavailable");
    const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
    let accessed = false;
    const fake = Object.defineProperty({}, "stateDir", { get() { accessed = true; throw new Error("untrusted getter"); } });
    assert.throws(() => migration.writeDarwinMigrationManifest(context, token, fake));
    assert.equal(accessed, false, "manifest writer evaluated an unverified offline authorization");
  }
  if (["prepare-conflicting-marker", "prepare-orphan-backup"].includes(mode)) {
    if (typeof migration.prepareDarwinLegacyLockBackup !== "function") throw new Error("fixed backup preparation is unavailable");
    const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
    const marker = path.join(context.migrationDir, "transition.json"), backup = path.join(context.migrationDir, "legacy-state.lock");
    if (mode === "prepare-conflicting-marker") fs.writeFileSync(marker, "{unknown", { mode: 0o600, flag: "wx" });
    if (mode === "prepare-orphan-backup") fs.writeFileSync(backup, "unknown\n", { mode: 0o600, flag: "wx" });
    assert.throws(() => migration.prepareDarwinLegacyLockBackup(context, token));
  }
  if (["prepare-missing-authorization", "prepare-forged-authorization"].includes(mode)) {
    const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
    let accessed = false;
    const fake = Object.defineProperty({}, "stateDir", { get() { accessed = true; throw new Error("untrusted getter"); } });
    assert.throws(() => migration.prepareDarwinLegacyLockBackup(context, token,
      mode === "prepare-missing-authorization" ? undefined : fake));
    assert.equal(accessed, false, "backup preparation evaluated unverified offline authorization");
  }
  if (["release-missing-authorization", "release-forged-authorization", "release-other-guard"].includes(mode)) {
    if (typeof migration.releaseDarwinLegacyLockName !== "function") throw new Error("fixed legacy name release is unavailable");
    const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
    const old = assertDarwinLegacyPreflightToken(token, context);
    const marker = path.join(context.migrationDir, "transition.json"), backup = path.join(context.migrationDir, "legacy-state.lock");
    const transition = { version: 2, stateDir, state: context.directoryIdentity, hostId: context.hostId,
      guardIdentity: context.guardIdentity, migrationDirectoryIdentity: context.migrationDirectoryIdentity, old };
    const fd = fs.openSync(marker, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(transition)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(path.join(stateDir, "state.lock"), backup);
    const directoryFd = fs.openSync(context.migrationDir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    assert.equal(migration.assertDarwinLegacyLockBackup(context, token), true);
    let accessed = false;
    const fake = Object.defineProperty({}, "stateDir", { get() { accessed = true; throw new Error("untrusted getter"); } });
    if (mode === "release-other-guard") {
      const otherDir = path.join(path.dirname(stateDir), "other-state");
      fs.mkdirSync(otherDir, { mode: 0o700 });
      const other = migration.acquireDarwinMigrationGuard(otherDir, 7500);
      try { assert.throws(() => migration.releaseDarwinLegacyLockName(other.context, token, fake)); }
      finally { other.close(); }
    } else assert.throws(() => migration.releaseDarwinLegacyLockName(context, token,
      mode === "release-missing-authorization" ? undefined : fake));
    assert.equal(accessed, false, "release evaluated an unverified offline authorization");
  }
  if (mode === "unauthorized-barrier") {
    const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
    const old = assertDarwinLegacyPreflightToken(token, context);
    const marker = path.join(context.migrationDir, "transition.json"), backup = path.join(context.migrationDir, "legacy-state.lock");
    const transition = { version: 2, stateDir, state: context.directoryIdentity, hostId: context.hostId,
      guardIdentity: context.guardIdentity, migrationDirectoryIdentity: context.migrationDirectoryIdentity, old };
    const fd = fs.openSync(marker, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(transition)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(path.join(stateDir, "state.lock"), backup);
    const guardDir = fs.openSync(context.migrationDir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(guardDir); } finally { fs.closeSync(guardDir); }
    fs.unlinkSync(path.join(stateDir, "state.lock"));
    const rootFd = fs.openSync(stateDir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
    assert.equal(migration.assertDarwinLegacyLockBackup(context, token), true);
    assert.throws(() => prepareDarwinLegacyBarrier({ stateDir, guardContext: context, preflightToken: token,
      expectedStateDir: stateDir, offlineConfirmed: true, localOnly: true }));
    assert.equal(fs.existsSync(path.join(stateDir, "state.lock")), false, "untrusted caller published a barrier");
  }
  if (["backup-valid", "backup-marker-corrupt", "backup-foreign-inode", "backup-expired-token", "backup-budget"].includes(mode)) {
    if (typeof migration.assertDarwinLegacyLockBackup !== "function") throw new Error("fixed backup verifier is unavailable");
    const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
    const old = assertDarwinLegacyPreflightToken(token, context);
    if (mode === "backup-expired-token") {
      guard.close();
      assert.throws(() => migration.assertDarwinLegacyLockBackup(context, token));
    } else {
      const marker = path.join(context.migrationDir, "transition.json");
      const backup = path.join(context.migrationDir, "legacy-state.lock");
      const transition = { version: 2, stateDir, state: context.directoryIdentity, hostId: context.hostId,
        guardIdentity: context.guardIdentity, migrationDirectoryIdentity: context.migrationDirectoryIdentity, old };
      const fd = fs.openSync(marker, "wx", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(transition)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(path.join(stateDir, "state.lock"), backup);
      const directoryFd = fs.openSync(context.migrationDir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      if (mode === "backup-marker-corrupt") fs.writeFileSync(marker, "{corrupt");
      if (mode === "backup-foreign-inode") {
        fs.renameSync(backup, path.join(path.dirname(stateDir), "detached-link"));
        fs.writeFileSync(backup, fs.readFileSync(path.join(stateDir, "state.lock")), { mode: 0o600, flag: "wx" });
      }
      if (mode === "backup-valid") assert.equal(migration.assertDarwinLegacyLockBackup(context, token), true);
      else if (mode === "backup-budget") {
        process.env.BACKUP_VERIFY_DELAY = "1";
        try { assert.throws(() => migration.assertDarwinLegacyLockBackup(context, token, performance.now() + 250), /timed out|deadline/i); }
        finally { delete process.env.BACKUP_VERIFY_DELAY; }
      } else assert.throws(() => migration.assertDarwinLegacyLockBackup(context, token));
    }
  }
  if (mode === "reenter") assert.throws(() => migration.acquireDarwinMigrationGuard(stateDir, 250), /reentr/i);
  fs.writeSync(1, "GUARD_HELD\n");
  if (mode === "hold") process.kill(process.pid, "SIGSTOP");
  guard.close();
  assert.throws(() => migration.assertDarwinLegacyGuardContext(context));
  fs.writeSync(1, "GUARD_EXPIRED\n");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
