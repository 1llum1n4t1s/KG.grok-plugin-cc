import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac process と CLI を使用するが、boot ID・procfs/mount/flock は模擬する。
// 特に directory flock の Linux kernel / filesystem 契約は別途実機確認が必要。
test("Linux offline history recovery and migration serialize on the same root lock", {
  skip: process.platform !== "darwin", timeout: 180000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-offline-lock-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), barrier = path.join(stateDir, "state.lock");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const boot = fileURLToPath(new URL("./fixtures/linux-history-boot-preload.mjs", import.meta.url));
  const pause = fileURLToPath(new URL("./fixtures/linux-history-offline-lock-pause.mjs", import.meta.url));
  const ready = path.join(root, "offline-lock-ready"), release = path.join(root, "offline-lock-release"), reused = path.join(root, "offline-operation-reused");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(boot)} --import ${JSON.stringify(pause)}`.trim() };
  delete env.PLUGIN_DATA; delete env.GROK_HISTORY_SIM_BOOT;
  delete env.GROK_HISTORY_OFFLINE_LOCK_READY; delete env.GROK_HISTORY_OFFLINE_LOCK_RELEASE;
  delete env.GROK_HISTORY_OFFLINE_REUSED;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = (argv, extra = {}) => spawnSync(process.execPath, [command, ...argv], { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
  let sentinel = false, verifiedDone = false, holder, migration, holderClosed, migrationClosed;
  t.after(async () => {
    try {
      if ((holder || migration) && !fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
      for (const child of [holder, migration]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (holderClosed) await holderClosed;
      if (migrationClosed) await migrationClosed;
      if (sentinel) {
        const stop = run(["state-lock", "stop-sentinel", ...args]);
        assert.equal(stop.status, 0, stop.stderr);
      }
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained offline lock fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const first = run(["state-lock", "migrate", ...args]); assert.equal(first.status, 0, first.stderr); sentinel = true;
  const markerBytes = fs.readFileSync(path.join(barrier, "protocol.json")), marker = JSON.parse(markerBytes), epoch = marker.epoch;
  const journal = path.join(stateDir, "history-journal-v1", epoch), oldJournal = fs.statSync(journal, { bigint: true });
  const ledger = path.join(stateDir, "worker-leases-v1", epoch, "ledger.json"), ledgerBytes = fs.readFileSync(ledger);
  const bootstrap = path.join(journal, "bootstrap");
  const makeBootstrap = () => {
    const fd = fs.openSync(bootstrap, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify({ version: 1, epoch, nonce: randomUUID() }, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const journalFd = fs.openSync(journal, "r"); try { fs.fsyncSync(journalFd); } finally { fs.closeSync(journalFd); }
  };
  makeBootstrap();
  const stop = run(["state-lock", "stop-sentinel", ...args]); assert.equal(stop.status, 0, stop.stderr); sentinel = false;
  const savedBarrier = path.join(stateDir, `state.lock.history-${epoch}`), oldBarrier = fs.statSync(barrier, { bigint: true });
  fs.renameSync(barrier, savedBarrier);
  env.GROK_HISTORY_SIM_BOOT = "33333333-3333-4333-8333-333333333333";
  const recoverArgs = ["state-lock", "recover-history", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", stateDir, "--old-epoch", epoch, "--old-barrier", savedBarrier, "--cwd", workspace];
  const start = (argv, childEnv) => {
    const child = spawn(process.execPath, [command, ...argv], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, closed };
  };
  // 逆順: migrate が先に root lock を取っている間は recover が旧記録に触れない。
  const reverseReady = path.join(root, "migration-lock-ready"), reverseRelease = path.join(root, "migration-lock-release");
  ({ child: migration, closed: migrationClosed } = start(["state-lock", "migrate", ...args], { ...env,
    GROK_HISTORY_OFFLINE_LOCK_CMD: "migrate", GROK_HISTORY_OFFLINE_LOCK_READY: reverseReady, GROK_HISTORY_OFFLINE_LOCK_RELEASE: reverseRelease }));
  let reverseDeadline = Date.now() + 15000;
  while (!fs.existsSync(reverseReady) && migration.exitCode === null && Date.now() < reverseDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(reverseReady), "migration must acquire the shared root lock before journal preflight");
  ({ child: holder, closed: holderClosed } = start(recoverArgs, env));
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.ok(fs.existsSync(bootstrap), "recovery must not change the journal while migration owns the root lock");
  assert.ok(!fs.existsSync(barrier), "migration must not create a barrier before validating the old journal");
  fs.writeFileSync(reverseRelease, "release", { flag: "wx", mode: 0o600 });
  const blocked = await migrationClosed;
  if (blocked.code === 0) sentinel = true;
  assert.notEqual(blocked.code, 0, "migration must refuse the pending old journal");
  assert.ok(!fs.existsSync(barrier), "a refused preflight must not leave a partial barrier");
  let reverseRecovered = await holderClosed;
  if (reverseRecovered.code !== 0 && /lock|timed out/i.test(reverseRecovered.stderr)) {
    const retry = run(recoverArgs); reverseRecovered = { code: retry.status, stderr: retry.stderr };
  }
  assert.equal(reverseRecovered.code, 0, reverseRecovered.stderr);
  assert.ok(!fs.existsSync(bootstrap));
  makeBootstrap();
  // 由来不明の barrier は回復操作でも置換・削除しない。
  fs.mkdirSync(barrier, { mode: 0o700 });
  const unknownBarrierFile = path.join(barrier, "unknown-evidence");
  fs.writeFileSync(unknownBarrierFile, "keep", { flag: "wx", mode: 0o600 });
  const unknownBarrierId = fs.statSync(barrier, { bigint: true }), unknownAttempt = run(recoverArgs);
  assert.notEqual(unknownAttempt.status, 0, "an unknown current barrier must be refused");
  assert.equal(fs.readFileSync(unknownBarrierFile, "utf8"), "keep");
  assert.equal(fs.statSync(barrier, { bigint: true }).ino, unknownBarrierId.ino);
  assert.ok(fs.existsSync(bootstrap));
  fs.renameSync(barrier, path.join(root, "preserved-unknown-barrier"));
  ({ child: holder, closed: holderClosed } = start(recoverArgs, { ...env,
    GROK_HISTORY_OFFLINE_LOCK_READY: ready, GROK_HISTORY_OFFLINE_LOCK_RELEASE: release, GROK_HISTORY_OFFLINE_REUSED: reused }));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && holder.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready), "recover-history must acquire and hold the root directory lock");
  assert.ok(fs.existsSync(reused), "the operation FD must be closed and reopened under the same number");
  ({ child: migration, closed: migrationClosed } = start(["state-lock", "migrate", ...args], env));
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.ok(!fs.existsSync(barrier), "migration must not publish or create a barrier while recovery owns the root lock");
  assert.ok(migration.exitCode === null || migration.exitCode !== 0, "migration must not complete while recovery owns the root lock");
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const recovered = await holderClosed; assert.equal(recovered.code, 0, recovered.stderr);
  let migrated = await migrationClosed;
  if (migrated.code !== 0 && /lock|timed out/i.test(migrated.stderr)) {
    const retry = run(["state-lock", "migrate", ...args]);
    migrated = { code: retry.status, stderr: retry.stderr };
  }
  assert.equal(migrated.code, 0, migrated.stderr); sentinel = true;
  assert.ok(!fs.existsSync(bootstrap), "pre-publication scratch must be safely cleared");
  assert.equal(fs.statSync(savedBarrier, { bigint: true }).dev, oldBarrier.dev);
  assert.equal(fs.statSync(savedBarrier, { bigint: true }).ino, oldBarrier.ino);
  assert.deepEqual(fs.readFileSync(path.join(savedBarrier, "protocol.json")), markerBytes);
  assert.deepEqual(fs.readFileSync(ledger), ledgerBytes);
  assert.equal(fs.statSync(journal, { bigint: true }).dev, oldJournal.dev);
  assert.equal(fs.statSync(journal, { bigint: true }).ino, oldJournal.ino);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8")).epoch, epoch);
  verifiedDone = true;
});

test("Linux concurrent first migrations lock the same newly created root", {
  skip: process.platform !== "darwin", timeout: 180000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-first-root-lock-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), barrier = path.join(stateDir, "state.lock");
  assert.ok(!fs.existsSync(stateDir), "the fixture must start before the first state root exists");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const pause = fileURLToPath(new URL("./fixtures/linux-history-offline-lock-pause.mjs", import.meta.url));
  const ready = path.join(root, "first-root-ready"), release = path.join(root, "first-root-release");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(pause)}`.trim() };
  delete env.PLUGIN_DATA; delete env.GROK_HISTORY_OFFLINE_LOCK_READY; delete env.GROK_HISTORY_OFFLINE_LOCK_RELEASE;
  delete env.GROK_HISTORY_OFFLINE_LOCK_CMD;
  const args = ["state-lock", "migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let first, second, firstClosed, secondClosed, sentinel = false, verifiedDone = false;
  t.after(async () => {
    try {
      if ((first || second) && !fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
      for (const child of [first, second]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (firstClosed) await firstClosed;
      if (secondClosed) await secondClosed;
      if (sentinel) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
      }
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained first-root fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const start = childEnv => {
    const child = spawn(process.execPath, [command, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
    return { child, closed };
  };
  ({ child: first, closed: firstClosed } = start({ ...env, GROK_HISTORY_OFFLINE_LOCK_CMD: "migrate",
    GROK_HISTORY_OFFLINE_LOCK_READY: ready, GROK_HISTORY_OFFLINE_LOCK_RELEASE: release }));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && first.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready), "first migration must lock the newly created root before publishing a barrier");
  const rootIdentity = fs.statSync(stateDir, { bigint: true });
  assert.equal(rootIdentity.mode & 0o777n, 0o700n);
  ({ child: second, closed: secondClosed } = start(env));
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.ok(!fs.existsSync(barrier), "a competing first migration must not create a barrier while the root is locked");
  assert.notEqual(second.exitCode, 0, "a competing first migration must not complete before the lock is released");
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const firstResult = await firstClosed; assert.equal(firstResult.code, 0, firstResult.stderr); sentinel = true;
  const secondResult = await secondClosed;
  assert.ok(secondResult.code === 0 || /lock|timed out/i.test(secondResult.stderr), secondResult.stderr);
  const after = fs.statSync(stateDir, { bigint: true });
  assert.equal(after.dev, rootIdentity.dev); assert.equal(after.ino, rootIdentity.ino);
  assert.ok(fs.existsSync(path.join(barrier, "protocol.json")));
  verifiedDone = true;
});

test("Linux offline recovery refuses a same-inode named mount change", {
  skip: process.platform !== "darwin", timeout: 180000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-offline-mount-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), barrier = path.join(stateDir, "state.lock"), stateFile = path.join(stateDir, "state.json");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const boot = fileURLToPath(new URL("./fixtures/linux-history-boot-preload.mjs", import.meta.url));
  const pause = fileURLToPath(new URL("./fixtures/linux-history-offline-lock-pause.mjs", import.meta.url));
  const mount = fileURLToPath(new URL("./fixtures/linux-history-offline-mount-preload.mjs", import.meta.url));
  const ready = path.join(root, "mount-lock-ready"), release = path.join(root, "mount-lock-release"), switchFile = path.join(root, "mount-switch");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_HISTORY_MOUNT_SWITCH: switchFile,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(boot)} --import ${JSON.stringify(mount)} --import ${JSON.stringify(pause)}`.trim() };
  delete env.PLUGIN_DATA; delete env.GROK_HISTORY_SIM_BOOT;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = argv => spawnSync(process.execPath, [command, ...argv], { env, encoding: "utf8", timeout: 30000 });
  let sentinel = false, holder, closed, verifiedDone = false;
  t.after(async () => {
    try {
      if (holder && !fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM");
      if (closed) await closed;
      if (sentinel) {
        const stop = run(["state-lock", "stop-sentinel", ...args]); assert.equal(stop.status, 0, stop.stderr);
      }
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained named mount fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const migration = run(["state-lock", "migrate", ...args]); assert.equal(migration.status, 0, migration.stderr); sentinel = true;
  const markerBytes = fs.readFileSync(path.join(barrier, "protocol.json")), epoch = JSON.parse(markerBytes).epoch;
  const journal = path.join(stateDir, "history-journal-v1", epoch), bootstrap = path.join(journal, "bootstrap");
  const bootBytes = Buffer.from(`${JSON.stringify({ version: 1, epoch, nonce: randomUUID() }, null, 2)}\n`);
  const fd = fs.openSync(bootstrap, "wx", 0o600); try { fs.writeFileSync(fd, bootBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const journalFd = fs.openSync(journal, "r"); try { fs.fsyncSync(journalFd); } finally { fs.closeSync(journalFd); }
  const indexBytes = fs.readFileSync(stateFile), rootIdentity = fs.statSync(stateDir, { bigint: true });
  const stop = run(["state-lock", "stop-sentinel", ...args]); assert.equal(stop.status, 0, stop.stderr); sentinel = false;
  const savedBarrier = path.join(stateDir, `state.lock.history-${epoch}`); fs.renameSync(barrier, savedBarrier);
  env.GROK_HISTORY_SIM_BOOT = "33333333-3333-4333-8333-333333333333";
  const recoverArgs = ["state-lock", "recover-history", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
    "--expected-state-dir", stateDir, "--old-epoch", epoch, "--old-barrier", savedBarrier, "--cwd", workspace];
  holder = spawn(process.execPath, [command, ...recoverArgs], { env: { ...env, GROK_HISTORY_OFFLINE_LOCK_READY: ready,
    GROK_HISTORY_OFFLINE_LOCK_RELEASE: release }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; holder.stderr.on("data", chunk => { stderr += chunk; });
  closed = new Promise(resolve => holder.once("close", (code, signal) => resolve({ code, signal, stderr })));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && holder.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready), "recovery must hold the root lock before the simulated mount change");
  fs.writeFileSync(switchFile, "changed", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const result = await closed;
  assert.notEqual(result.code, 0, "changed named mount must refuse recovery");
  assert.match(result.stderr, /mount boundary/i);
  const after = fs.statSync(stateDir, { bigint: true });
  assert.equal(after.dev, rootIdentity.dev); assert.equal(after.ino, rootIdentity.ino);
  assert.deepEqual(fs.readFileSync(stateFile), indexBytes);
  assert.deepEqual(fs.readFileSync(bootstrap), bootBytes);
  assert.deepEqual(fs.readFileSync(path.join(savedBarrier, "protocol.json")), markerBytes);
  verifiedDone = true;
});
