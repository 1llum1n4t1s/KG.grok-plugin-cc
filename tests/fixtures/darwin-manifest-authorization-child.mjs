import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { acquireDarwinMigrationGuard } from "../../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";
import * as inventory from "../../plugins/grok/scripts/lib/darwin-migration-inventory.mjs";

const stateDir = process.argv[2], guard = acquireDarwinMigrationGuard(stateDir, 7500);
try {
  const { context } = guard;
  const manifestFile = path.join(context.migrationDir, "manifest.json");
  const brokerCopy = path.join(context.migrationDir, "broker-admission-preserved.jsonl");
  fs.writeFileSync(manifestFile, "manifest-evidence\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(brokerCopy, "broker-evidence\n", { mode: 0o600, flag: "wx" });
  const files = [manifestFile, brokerCopy].map(file => ({ file, bytes: fs.readFileSync(file), stat: fs.lstatSync(file, { bigint: true }) }));
  if (typeof inventory.verifyDarwinMigrationPreservation !== "function") throw new Error("fixed preservation verifier is unavailable");
  let stateAccessed = false, manifestAccessed = false;
  const fakeState = Object.defineProperty({}, "check", { get() { stateAccessed = true; throw new Error("untrusted state getter"); } });
  const options = { guardContext: context, migrationStateContext: fakeState };
  Object.defineProperty(options, "manifest", { get() { manifestAccessed = true; throw new Error("untrusted manifest getter"); } });
  assert.throws(() => inventory.verifyDarwinMigrationPreservation(options));
  assert.equal(stateAccessed, false, "unverified state context was read");
  assert.equal(manifestAccessed, false, "unverified manifest was read");
  for (const item of files) {
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
    assert.equal(fs.lstatSync(item.file, { bigint: true }).ino, item.stat.ino);
  }
  fs.writeSync(1, "FORGED_MANIFEST_REJECTED\n");
} finally { guard.close(); }
