import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { verifyDarwinLegacyPreflight } from "../plugins/grok/scripts/lib/state.mjs";
import { acquireDarwinMigrationGuard } from "../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs";

// The real guard and filesystem are used; the old lock is fixture evidence,
// never a signal target. Unknown records and external links must be preserved.
const mac = { skip: process.platform !== "darwin", timeout: 60000 };
function fixture(t) {
  const root = fs.realpathSync(makeTempDir("grok-darwin-preflight-bounds-")), stateDir = path.join(root, "state"), jobs = path.join(stateDir, "jobs");
  fs.mkdirSync(stateDir, { mode: 0o700 }); fs.mkdirSync(jobs, { mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "state.lock"), "12345\n", { flag: "wx", mode: 0o600 });
  const log = path.join(jobs, "old-job.log"), detail = path.join(jobs, "old-job.json"), index = path.join(stateDir, "state.json");
  const job = { id: "old-job", status: "completed", createdAt: "2020-01-01T00:00:00.000Z", logFile: log };
  fs.writeFileSync(index, JSON.stringify({ version: 1, config: {}, jobs: [job], reviewGateSessions: [] }), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(detail, JSON.stringify(job), { flag: "wx", mode: 0o600 });
  const guard = acquireDarwinMigrationGuard(stateDir);
  let active = true;
  const closeGuard = () => { if (active) { guard.close(); active = false; } };
  t.after(() => { closeGuard(); t.diagnostic(`Legacy log fixture retained: ${root}`); });
  return { root, stateDir, jobs, log, detail, index, guard, closeGuard };
}

test("Darwin legacy preflight rejects an externally hardlinked job log", mac, t => {
  const f = fixture(t), outside = path.join(f.root, "outside-evidence");
  fs.writeFileSync(outside, "outside evidence\n", { flag: "wx", mode: 0o600 });
  fs.linkSync(outside, f.log);
  const before = fs.readFileSync(f.index), inode = fs.lstatSync(outside, { bigint: true });
  assert.throws(() => verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: f.guard.context }));
  assert.deepEqual(fs.readFileSync(f.index), before);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside evidence\n");
  assert.equal(fs.lstatSync(f.log, { bigint: true }).ino, inode.ino);
});

test("Darwin legacy preflight rejects an oversized log without reading or removing it", mac, t => {
  const f = fixture(t), fd = fs.openSync(f.log, "wx", 0o600);
  try { fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  assert.throws(() => verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: f.guard.context }), /limit|capacity|budget|size/i);
  assert.equal(fs.statSync(f.log, { bigint: true }).size, 64n * 1024n * 1024n + 1n);
});

test("Darwin legacy preflight rejects excessive inventory without removing entries", mac, t => {
  const f = fixture(t);
  fs.writeFileSync(f.log, "log", { flag: "wx", mode: 0o600 });
  for (let n = 0; n < 4097; n++) fs.writeFileSync(path.join(f.jobs, `unclaimed-${n}.json`), "{}", { flag: "wx", mode: 0o600 });
  assert.throws(() => verifyDarwinLegacyPreflight({ stateDir: f.stateDir, guardContext: f.guard.context }), /limit|capacity|budget|excess/i);
  assert.equal(fs.readdirSync(f.jobs).length, 4099);
});

test("Darwin preflight enforces one deadline across state and broker inspection", mac, t => {
  const f = fixture(t), brokerDir = path.join(f.stateDir, "broker-v2"), brokerFile = path.join(brokerDir, "broker-admission.jsonl");
  fs.writeFileSync(f.log, "log", { flag: "wx", mode: 0o600 });
  fs.mkdirSync(brokerDir, { mode: 0o700 });
  const records = [
    { version: 2, event: "pending", generation: "old-generation", ownerPid: process.pid, platform: "darwin", lockToken: "old-owner", endpoint: "unix:/old/b", sessionDir: f.root, pidFile: path.join(f.root, "pid"), logFile: path.join(f.root, "broker-log") },
    { version: 2, event: "spawned", generation: "old-generation", pid: null, pgid: null },
    { version: 2, event: "settled", generation: "old-generation", pid: null, outcome: "stopped" },
    { version: 2, event: "confirmed", generation: "old-generation", pid: null, outcome: "stopped" }
  ];
  const before = Buffer.from(records.map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(brokerFile, before, { flag: "wx", mode: 0o600 });
  f.closeGuard();
  const preload = fileURLToPath(new URL("./fixtures/darwin-preflight-delay.cjs", import.meta.url));
  const guardModule = new URL("../plugins/grok/scripts/lib/darwin-legacy-lock-migration.mjs", import.meta.url).href;
  const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import {acquireDarwinMigrationGuard} from ${JSON.stringify(guardModule)};
    import {verifyDarwinLegacyPreflight} from ${JSON.stringify(stateModule)}; const dir=${JSON.stringify(f.stateDir)};
    const guard=acquireDarwinMigrationGuard(dir); try { assert.throws(()=>verifyDarwinLegacyPreflight({stateDir:dir,guardContext:guard.context}), /time|deadline/i); } finally { guard.close(); }`;
  const child = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", script], {
    env: { ...process.env, GROK_TEST_DELAY_BROKER_FILE: brokerFile }, encoding: "utf8", timeout: 25000
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readFileSync(brokerFile), before);
});
