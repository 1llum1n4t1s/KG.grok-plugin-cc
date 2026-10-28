import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPosixStateLockScope } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { verifyDarwinMigrationInventory } from "../plugins/grok/scripts/lib/darwin-migration-inventory.mjs";
import { acquireDarwinMigrationGuard } from "../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";
import { removeTempFixture } from "./helpers.mjs";

// 起こり得る失敗: 未確定・破損・未知の記録の受入れ、別ホストや別 state の証拠の受入れ、
// 別 inode の保存前の証拠消失、journal の改変、リンクや不正権限を通じた対象のすり替え。
const darwin = { skip: process.platform !== "darwin", timeout: 30000 };
const markerName = "e958695e-fdbc-4295-8ae8-419cedb35436.jsonl";
const generation = markerName.slice(0, -6);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "grok-inventory-"));
  const stateDir = path.join(root, "state"), migrationDir = path.join(stateDir, ".darwin-legacy-migration");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const guard = acquireDarwinMigrationGuard(stateDir);
  let guardActive = true;
  const closeGuard = () => { if (guardActive) { guard.close(); guardActive = false; } };
  t.after(() => { closeGuard(); removeTempFixture(root, { recursive: true, force: true }); });
  const scope = inspectPosixStateLockScope(stateDir);
  const stat = fs.lstatSync(migrationDir, { bigint: true });
  const context = { stateDir, scope, migrationDir, migrationDirectoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, guardContext: guard.context };
  return { root, stateDir, migrationDir, scope, context, closeGuard };
}

function journal(f, confirmed = true) {
  const dir = path.join(f.stateDir, "broker-v2"), file = path.join(dir, "broker-admission.jsonl");
  fs.mkdirSync(dir, { mode: 0o700 });
  const records = [
    { version: 2, event: "pending", generation: "old-generation", ownerPid: process.pid, platform: "darwin", lockToken: "old-owner", endpoint: "unix:/old/b", sessionDir: f.root, pidFile: path.join(f.root, "pid"), logFile: path.join(f.root, "log") },
    { version: 2, event: "spawned", generation: "old-generation", pid: null, pgid: null },
    { version: 2, event: "settled", generation: "old-generation", pid: null, outcome: "stopped" },
  ];
  if (confirmed) records.push({ version: 2, event: "confirmed", generation: "old-generation", pid: null, outcome: "stopped" });
  const bytes = Buffer.from(records.map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { dir, file, bytes };
}

function marker(f, confirmed = true, mutate = () => {}) {
  const dir = path.join(f.stateDir, "direct-start-v1"), file = path.join(dir, markerName);
  fs.mkdirSync(dir, { mode: 0o700 });
  const records = [{ version: 1, event: "pending", generation, ownerPid: process.pid,
    ownerIdentity: { stateDir: f.stateDir, directoryIdentity: f.scope.directoryIdentity, hostId: f.scope.hostId, volumeGuid: null } }];
  if (confirmed) records.push({ version: 1, event: "released", generation, proof: "never-started" },
    { version: 1, event: "confirmed", generation, proof: "never-started" });
  mutate(records);
  const bytes = Buffer.from(records.map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { dir, file, bytes };
}

test("offline inventory reads confirmed admission and journal without creating copies", darwin, t => {
  const f = fixture(t), j = journal(f), m = marker(f);
  const original = fs.lstatSync(j.file, { bigint: true });
  assert.equal(verifyDarwinMigrationInventory(f.context), true);
  assert.equal(verifyDarwinMigrationInventory(f.context), true, "recovery must be idempotent");
  assert.deepEqual(fs.readFileSync(j.file), j.bytes);
  assert.equal(fs.lstatSync(j.file, { bigint: true }).ino, original.ino);
  const preserved = path.join(f.migrationDir, "direct-start-v1-preserved", markerName);
  assert.equal(fs.existsSync(preserved), false);
  assert.deepEqual(fs.readFileSync(m.file), m.bytes);
});

for (const invalid of ["missing", "forged", "expired"]) test(`offline inventory refuses ${invalid} guard before copying evidence`, darwin, t => {
  const f = fixture(t), m = marker(f);
  const context = { ...f.context };
  if (invalid === "missing") delete context.guardContext;
  if (invalid === "forged") context.guardContext = { ...context.guardContext };
  if (invalid === "expired") f.closeGuard();
  assert.throws(() => verifyDarwinMigrationInventory(context), /guard|capability/i);
  assert.deepEqual(fs.readFileSync(m.file), m.bytes);
  assert.equal(fs.existsSync(path.join(f.migrationDir, "direct-start-v1-preserved")), false, "untrusted caller copied an admission record");
});

for (const kind of ["pending-broker", "pending-direct", "foreign-host", "foreign-state", "foreign-broker-platform", "unknown-direct", "corrupt-direct", "linked-direct", "unsafe-mode", "oversized-broker", "duplicate-generation"]) {
  test(`offline inventory rejects and preserves ${kind}`, darwin, t => {
    const f = fixture(t), j = journal(f, kind !== "pending-broker"), m = marker(f, kind !== "pending-direct", records => {
      if (kind === "foreign-host") records[0].ownerIdentity.hostId += "-foreign";
      if (kind === "foreign-state") records[0].ownerIdentity.directoryIdentity = { ...records[0].ownerIdentity.directoryIdentity, ino: String(BigInt(f.scope.directoryIdentity.ino) + 1n) };
    });
    if (kind === "unknown-direct") fs.writeFileSync(path.join(m.dir, "unexpected"), "preserve", { mode: 0o600 });
    if (kind === "corrupt-direct") fs.writeFileSync(m.file, "{\"version\":1");
    if (kind === "linked-direct") fs.linkSync(m.file, path.join(f.root, "alias"));
    if (kind === "unsafe-mode") fs.chmodSync(m.file, 0o644);
    if (kind === "oversized-broker") fs.writeFileSync(j.file, Buffer.alloc(4 * 1024 * 1024 + 1, 120));
    if (kind === "duplicate-generation") fs.appendFileSync(j.file, j.bytes);
    if (kind === "foreign-broker-platform") fs.writeFileSync(j.file, j.bytes.toString().replace('"platform":"darwin"', '"platform":"linux"'));
    const beforeJournal = fs.readFileSync(j.file), beforeMarker = fs.readFileSync(m.file);
    assert.throws(() => verifyDarwinMigrationInventory(f.context));
    assert.deepEqual(fs.readFileSync(j.file), beforeJournal);
    assert.deepEqual(fs.readFileSync(m.file), beforeMarker);
  });
}

test("offline inventory rejects a symlinked admission directory without changing its target", darwin, t => {
  const f = fixture(t), target = path.join(f.root, "external");
  fs.mkdirSync(target, { mode: 0o700 });
  const evidence = path.join(target, "evidence");
  fs.writeFileSync(evidence, "preserve", { mode: 0o600 });
  const link = path.join(f.stateDir, "direct-start-v1");
  fs.symlinkSync(target, link);
  const original = fs.lstatSync(link, { bigint: true });
  try {
    assert.throws(() => verifyDarwinMigrationInventory(f.context));
    assert.equal(fs.readFileSync(evidence, "utf8"), "preserve");
  } finally {
    const current = fs.lstatSync(link, { bigint: true });
    assert.equal(path.dirname(link), f.stateDir);
    assert.ok(current.isSymbolicLink());
    assert.equal(current.dev, original.dev);
    assert.equal(current.ino, original.ino);
    assert.equal(fs.readlinkSync(link), target);
    fs.unlinkSync(link);
  }
});

test("offline inventory rejects mismatched state and migration identities", darwin, t => {
  const f = fixture(t), j = journal(f);
  const wrongScope = { ...f.scope, directoryIdentity: { ...f.scope.directoryIdentity,
    ino: String(BigInt(f.scope.directoryIdentity.ino) + 1n) } };
  assert.throws(() => verifyDarwinMigrationInventory({ ...f.context, scope: wrongScope }));
  assert.throws(() => verifyDarwinMigrationInventory({ ...f.context, migrationDirectoryIdentity: { dev: "1", ino: "1" } }));
  assert.deepEqual(fs.readFileSync(j.file), j.bytes);
});

test("offline inventory preserves an incomplete prior copy for inspection", darwin, t => {
  const f = fixture(t), m = marker(f);
  const preserved = path.join(f.migrationDir, "direct-start-v1-preserved");
  fs.mkdirSync(preserved, { mode: 0o700 });
  const copy = path.join(preserved, markerName), incomplete = m.bytes.subarray(0, 8);
  fs.writeFileSync(copy, incomplete, { mode: 0o600 });
  assert.throws(() => verifyDarwinMigrationInventory(f.context));
  assert.deepEqual(fs.readFileSync(copy), incomplete);
  assert.deepEqual(fs.readFileSync(m.file), m.bytes);
});
