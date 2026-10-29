import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// Linux履歴transactionのcrash再開は未統合。これは実crashの再開試験ではなく、
// 未確認の合成journalを現行CLIが保全して拒否する経路を確認する。
test("Linux CLI preserves unconfirmed history journal and refuses unavailable recovery", {
  skip: process.platform !== "darwin", timeout: 120000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-unconfirmed-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), stateFile = path.join(stateDir, "state.json"), barrier = path.join(stateDir, "state.lock");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const boot = fileURLToPath(new URL("./fixtures/linux-history-boot-preload.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(boot)}`.trim() };
  delete env.PLUGIN_DATA; delete env.GROK_HISTORY_SIM_BOOT;
  const lockArgs = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = args => spawnSync(process.execPath, [command, ...args], { env, encoding: "utf8", timeout: 30000 });
  let sentinel = false, verifiedDone = false;
  t.after(() => {
    try {
      if (sentinel) {
        const stop = run(["state-lock", "stop-sentinel", ...lockArgs]);
        assert.equal(stop.status, 0, stop.stderr);
      }
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained unconfirmed history fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const first = run(["state-lock", "migrate", ...lockArgs]);
  assert.equal(first.status, 0, first.stderr); sentinel = true;
  const marker = fs.readFileSync(path.join(barrier, "protocol.json")), epoch = JSON.parse(marker).epoch;
  const journal = path.join(stateDir, "history-journal-v1", epoch);
  const bootstrap = path.join(journal, "bootstrap"), intent = path.join(journal, "intent.json");
  const bootstrapBytes = Buffer.from(`${JSON.stringify({ version: 1, epoch, nonce: randomUUID() })}\n`);
  const intentBytes = Buffer.from('{"fixture":"unconfirmed history transaction"}\n');
  for (const [file, contents] of [[bootstrap, bootstrapBytes], [intent, intentBytes]]) {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const dirFd = fs.openSync(journal, "r"); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const id = "preserved-history", detailFile = path.join(jobsDir, `${id}.json`), logFile = path.join(jobsDir, `${id}.log`);
  const job = { id, status: "completed", epoch, logFile };
  const detailBytes = Buffer.from(JSON.stringify(job)), logBytes = Buffer.from("preserve history\n");
  fs.writeFileSync(detailFile, detailBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(logFile, logBytes, { flag: "wx", mode: 0o600 });
  const index = JSON.parse(fs.readFileSync(stateFile, "utf8")); index.jobs.push(job);
  fs.writeFileSync(stateFile, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  const stateBytes = fs.readFileSync(stateFile), journalIdentity = fs.statSync(journal, { bigint: true });
  const stop = run(["state-lock", "stop-sentinel", ...lockArgs]); assert.equal(stop.status, 0, stop.stderr); sentinel = false;
  const savedBarrier = path.join(stateDir, `state.lock.history-${epoch}`);
  const barrierIdentity = fs.statSync(barrier, { bigint: true }); fs.renameSync(barrier, savedBarrier);
  env.GROK_HISTORY_SIM_BOOT = "33333333-3333-4333-8333-333333333333";
  const preserved = () => {
    const currentJournal = fs.statSync(journal, { bigint: true }), currentBarrier = fs.statSync(savedBarrier, { bigint: true });
    assert.equal(currentJournal.dev, journalIdentity.dev); assert.equal(currentJournal.ino, journalIdentity.ino);
    assert.equal(currentBarrier.dev, barrierIdentity.dev); assert.equal(currentBarrier.ino, barrierIdentity.ino);
    for (const [file, bytes] of [[bootstrap, bootstrapBytes], [intent, intentBytes], [stateFile, stateBytes],
      [detailFile, detailBytes], [logFile, logBytes], [path.join(savedBarrier, "protocol.json"), marker]]) {
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
  };
  const unsupported = run(["state-lock", "recover-history", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", stateDir, "--old-epoch", epoch, "--old-barrier", savedBarrier, "--cwd", workspace]);
  assert.equal(unsupported.error, undefined); assert.equal(unsupported.signal, null); assert.equal(unsupported.status, 1); assert.match(unsupported.stderr, /Invalid state-lock arguments\/options/); preserved();
  const migration = run(["state-lock", "migrate", ...lockArgs]);
  if (migration.status === 0) sentinel = true;
  assert.equal(migration.error, undefined); assert.equal(migration.signal, null); assert.equal(migration.status, 1); assert.match(migration.stderr, /Old Linux history journal contains unconfirmed evidence/); preserved();
  const entries = fs.readdirSync(barrier).sort(), prepared = entries.filter(name => /^prepared-.*\.json$/.test(name));
  assert.equal(entries.includes("protocol.json"), false); assert.equal(prepared.length, 1);
  const preparedPath = path.join(barrier, prepared[0]), preparedBytes = fs.readFileSync(preparedPath);
  const preparedIdentity = fs.statSync(preparedPath, { bigint: true });
  const recover = run(["state-lock", "recover", ...lockArgs, "--all-old-processes-stopped"]);
  assert.equal(recover.error, undefined); assert.equal(recover.signal, null); assert.equal(recover.status, 1); assert.match(recover.stderr, /state lock migration is incomplete or invalid/i);
  assert.deepEqual(fs.readdirSync(barrier).sort(), entries); assert.deepEqual(fs.readFileSync(preparedPath), preparedBytes);
  const afterPrepared = fs.statSync(preparedPath, { bigint: true });
  assert.equal(afterPrepared.dev, preparedIdentity.dev); assert.equal(afterPrepared.ino, preparedIdentity.ino); preserved();
  const retry = run(["state-lock", "migrate", ...lockArgs]);
  if (retry.status === 0) sentinel = true;
  assert.equal(retry.error, undefined); assert.equal(retry.signal, null); assert.equal(retry.status, 1); assert.match(retry.stderr, /state lock migration is incomplete or invalid/i);
  assert.deepEqual(fs.readdirSync(barrier).sort(), entries); assert.deepEqual(fs.readFileSync(preparedPath), preparedBytes); preserved();
  const status = run(["status", "--cwd", workspace, "--json", "--all"]);
  assert.equal(status.error, undefined); assert.equal(status.signal, null); assert.equal(status.status, 1); assert.match(status.stderr, /state lock migration is incomplete or invalid/i); preserved();
  verifiedDone = true;
});
