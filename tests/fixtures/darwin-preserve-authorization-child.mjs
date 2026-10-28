import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { acquireDarwinMigrationGuard } from "../../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";
import { verifyDarwinLegacyPreflight } from "../../plugins/grok/scripts/lib/state.mjs";
import * as inventory from "../../plugins/grok/scripts/lib/darwin-migration-inventory.mjs";

const stateDir = process.argv[2], guard = acquireDarwinMigrationGuard(stateDir, 7500);
try {
  const { context } = guard, generation = "274a4b2b-2f6b-40f8-ae75-472dd409728a";
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
  const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  const source = fs.lstatSync(marker, { bigint: true });
  const token = verifyDarwinLegacyPreflight({ stateDir, guardContext: context });
  if (typeof inventory.preserveDarwinMigrationInventory !== "function") throw new Error("fixed authorized inventory preservation is unavailable");
  let accessed = false;
  const fake = Object.defineProperty({}, "stateDir", { get() { accessed = true; throw new Error("untrusted getter"); } });
  assert.throws(() => inventory.preserveDarwinMigrationInventory({ stateDir, guardContext: context, preflightToken: token, offlineAuthorization: fake }));
  assert.equal(accessed, false, "unverified offline authorization getter was evaluated");
  assert.equal(fs.existsSync(path.join(context.migrationDir, "direct-start-v1-preserved")), false);
  assert.deepEqual(fs.readFileSync(marker), bytes);
  assert.equal(fs.lstatSync(marker, { bigint: true }).ino, source.ino);
  fs.writeSync(1, "UNAUTHORIZED_COPY_REJECTED\n");
} finally { guard.close(); }
