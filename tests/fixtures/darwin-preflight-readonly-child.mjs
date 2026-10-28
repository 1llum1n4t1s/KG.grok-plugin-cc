import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { acquireDarwinMigrationGuard } from "../../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";
import { verifyDarwinLegacyPreflight, assertDarwinLegacyPreflightToken } from "../../plugins/grok/scripts/lib/state.mjs";

const stateDir = process.argv[2], guard = acquireDarwinMigrationGuard(stateDir, 7500);
try {
  const { context } = guard, generation = "37f9f126-3cb7-4eb8-9afa-9b65a450b7c8";
  const dir = path.join(stateDir, "direct-start-v1");
  fs.mkdirSync(dir, { mode: 0o700 });
  const marker = path.join(dir, `${generation}.jsonl`);
  const ownerIdentity = { stateDir, directoryIdentity: context.directoryIdentity, hostId: context.hostId, volumeGuid: null };
  const records = [
    { version: 1, event: "pending", generation, ownerPid: process.pid, ownerIdentity },
    { version: 1, event: "released", generation, proof: "never-started" },
    { version: 1, event: "confirmed", generation, proof: "never-started" }
  ];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const fd = fs.openSync(marker, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directoryFd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  const before = fs.lstatSync(marker, { bigint: true });
  const migrationEntries = fs.readdirSync(context.migrationDir).sort();
  const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
  assert.ok(assertDarwinLegacyPreflightToken(token, context));
  assert.deepEqual(fs.readdirSync(context.migrationDir).sort(), migrationEntries,
    "preflight changed the migration directory before offline authorization");
  assert.equal(fs.existsSync(path.join(context.migrationDir, "direct-start-v1-preserved")), false);
  assert.deepEqual(fs.readFileSync(marker), bytes);
  assert.equal(fs.lstatSync(marker, { bigint: true }).ino, before.ino);
  fs.writeSync(1, "PREFLIGHT_READ_ONLY\n");
} finally { guard.close(); }
