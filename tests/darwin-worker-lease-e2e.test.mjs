import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { buildStatusSnapshot, resolveResultJob } from "../plugins/grok/scripts/lib/job-control.mjs";
import { getProcessSnapshot } from "../plugins/grok/scripts/lib/process.mjs";
import { createStateJobReader, loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, resolveStateFile, updateState, upsertJob, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

// 故障条件: 停止中 worker を終了と断定する、PID 再利用で停止を見逃す、
// 片側の記録から所有権を補う、実子を残したまま fixture を引き上げる。
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };

function fixture(t, id) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(makeTempDir("grok-lease-state-"));
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-lease-workspace-"));
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true });
  return { workspace, job: { id, workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "lease-e2e-session", grokPromptState: "not-sent" } };
}

function manage(t, child) {
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // SIGSTOP 中なら終了シグナルを処理可能な状態に戻す。
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }
    await closed;
  });
  return { child, closed };
}

async function startWorker(t, job, options = { syntheticStartKey: true }) {
  const worker = manage(t, fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  worker.child.send({ job, ...options });
  const [message] = await once(worker.child, "message");
  assert.equal(message.type, "started", JSON.stringify(message));
  return { ...worker, message };
}

function status(workspace) {
  return buildStatusSnapshot(workspace, { all: true, env: {} });
}

function leaseRecord(workspace, id) {
  const indexed = loadState(workspace).jobs.find(entry => entry.id === id);
  const stored = readJobFile(resolveJobFile(workspace, id));
  assert.ok(indexed?.workerLease, "new Darwin worker must record its lease");
  assert.deepEqual(indexed.workerLease, stored.workerLease);
  assert.match(indexed.workerLease.id, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof indexed.workerLease.path, "string");
  assert.equal(path.isAbsolute(indexed.workerLease.path), true);
  const relative = path.relative(resolveStateDir(workspace), indexed.workerLease.path);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.ok(indexed.workerLease.dev && indexed.workerLease.ino && indexed.workerLease.stateGeneration);
  return indexed.workerLease;
}

test("a naturally identified stopped worker owns the same lease in both records", darwin, async t => {
  const { workspace, job } = fixture(t, "natural-stop");
  const worker = await startWorker(t, job, {});
  worker.child.kill("SIGSTOP");
  const before = leaseRecord(workspace, job.id);
  status(workspace);
  assert.deepEqual(leaseRecord(workspace, job.id), before);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
});

test("an empty ledger admits the first worker without an unnecessary sweep", darwin, async t => {
  const { workspace, job } = fixture(t, "first-slot-without-sweep");
  await startWorker(t, job, {});
  const lease = leaseRecord(workspace, job.id);
  const ledger = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "darwin-lease-ledger.json"), "utf8"));
  assert.equal(lease.slot, 0);
  assert.equal(ledger.cursor, 1);
});

test("lockf distinguishes a live owner and competing observer FDs", darwin, async t => {
  const { workspace, job } = fixture(t, "lockf-observers");
  const worker = await startWorker(t, job, {});
  const lease = leaseRecord(workspace, job.id);
  const open = () => fs.openSync(lease.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const probe = fd => {
    const result = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 2000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result.status;
  };
  worker.child.kill("SIGSTOP");
  const liveProbe = open();
  try { assert.equal(probe(liveProbe), 75); } finally { fs.closeSync(liveProbe); }
  worker.child.kill("SIGKILL");
  await worker.closed;
  const observer = open();
  const competingObserver = open();
  let firstClosed = false;
  try {
    assert.equal(probe(observer), 0);
    assert.equal(probe(competingObserver), 75);
    fs.closeSync(observer);
    firstClosed = true;
    assert.equal(probe(competingObserver), 0);
  } finally {
    if (!firstClosed) fs.closeSync(observer);
    fs.closeSync(competingObserver);
  }
});

test("a killed worker releases its lease even while its child is still running", darwin, async t => {
  const { workspace, job } = fixture(t, "child-does-not-inherit");
  const marker = path.join(workspace, "descendant-exited");
  const worker = await startWorker(t, job, { childMarker: marker });
  // 孫プロセスは自ら終了し、上位の cleanup が開始する前に終了印を待つ。
  t.after(async () => {
    fs.writeFileSync(`${marker}.release`, "release");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), "descendant did not finish");
  });
  assert.ok(worker.message.descendantPid);
  leaseRecord(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  assert.equal(fs.existsSync(marker), false, "the child must still be running during the probe");
  status(workspace);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "failed");
});

test("SIGSTOP worker remains running even when the PID snapshot reports another start key", darwin, async t => {
  const { workspace, job } = fixture(t, "stopped-owner");
  const worker = await startWorker(t, job);
  worker.child.kill("SIGSTOP");
  status(workspace);
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(indexed.status, "running");
  assert.equal(stored.status, "running");
  assert.equal(indexed.pid, worker.child.pid);
});

test("dead worker is reconciled even when its numeric PID and start key appear to match another process", darwin, async t => {
  const { workspace, job } = fixture(t, "reused-pid");
  const worker = await startWorker(t, job);
  worker.child.kill("SIGKILL");
  await worker.closed;
  const other = manage(t, spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  await once(other.child, "spawn");
  const snapshot = getProcessSnapshot(other.child.pid);
  assert.ok(snapshot?.startKey);
  // 置換PIDに同じ開始キーが見える状況を、両原本に反映して模擬する。
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    Object.assign(indexed, { pid: other.child.pid, processStartKey: snapshot.startKey });
    writeJobFile(workspace, job.id, { ...stored, pid: other.child.pid, processStartKey: snapshot.startKey });
  });
  status(workspace);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "failed");
  assert.equal(other.child.exitCode, null);
});

test("a partially saved lease reconciliation is repaired or reports the preserved records", darwin, async t => {
  const { workspace, job } = fixture(t, "partial-status-save");
  const worker = await startWorker(t, job, {});
  leaseRecord(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  const failure = manage(t, fork(new URL("./fixtures/darwin-status-write-failure-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  failure.child.send({ workspace, stateDir: resolveStateDir(workspace) });
  const [result] = await once(failure.child, "message");
  assert.equal(result.type, "rejected");
  assert.equal(result.injected, true);
  const detail = resolveJobFile(workspace, job.id);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(readJobFile(detail).status, "failed");
  const before = fs.readFileSync(detail, "utf8");
  let error;
  try { status(workspace); } catch (caught) { error = caught; }
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const stored = readJobFile(detail);
  if (indexed.status === "running") {
    assert.match(error?.message ?? "", /partial|inconsistent|recover/i);
    assert.equal(fs.readFileSync(detail, "utf8"), before);
  } else {
    assert.equal(indexed.status, "failed");
    assert.equal(stored.status, "failed");
  }
});

test("a missing detail record does not turn an uncertain worker into a confirmed exit", darwin, async t => {
  const { workspace, job } = fixture(t, "missing-detail");
  await startWorker(t, job);
  fs.writeFileSync(resolveJobFile(workspace, job.id), "null\n");
  try { status(workspace); } catch { /* 不明な状態はエラーでも保留でもよい。 */ }
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"), "null\n");
});

test("a delayed claim cannot replace cancellation published after lease acquisition", darwin, async t => {
  const { workspace, job } = fixture(t, "delayed-claim");
  const worker = await pauseBeforeClaim(t, job);
  const cancelled = { ...job, status: "cancelled", phase: "cancelled", createdAt: new Date().toISOString() };
  writeJobFile(workspace, job.id, cancelled);
  upsertJob(workspace, cancelled);
  const before = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");
  releasePaused(worker);
  const [result] = await once(worker.child, "message");
  assert.equal(result.type, "rejected");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"), before);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "cancelled");
});

test("queued cancellation rejects a delayed claimant and waits for the worker to exit", darwin, async t => {
  const { workspace, job } = fixture(t, "queued-never-started");
  const worker = await pauseBeforeClaim(t, job);
  const queued = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(queued.status, "queued");
  assert.equal(queued.pid, null);
  assert.equal(queued.processStartKey, null);
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  await runCommand(t, cli, ["cancel", "--cwd", workspace, "--json", job.id]);
  const cancelled = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(cancelled.status, "cancelled");
  assert.notEqual(cancelled.workerStopConfirmed, true);
  assert.equal(cancelled.terminationPending, true);
  releasePaused(worker);
  const [result] = await once(worker.child, "message");
  assert.equal(result.type, "rejected");
  await worker.closed;
  await runCommand(t, cli, ["cancel", "--cwd", workspace, "--json", job.id]);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).terminationPending, false);
});

test("a delayed claimant stays rejected even after cancellation and history pruning", darwin, async t => {
  const { workspace, job } = fixture(t, "pruned-cancel-before-claim");
  const worker = await pauseBeforeClaim(t, job);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "queued");
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  await runCommand(t, cli, ["cancel", "--cwd", workspace, "--json", job.id]);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "cancelled");
  updateState(workspace, state => {
    // 旧版の誤った never-started 確定を模擬し、上限整理が対象にできる状態にする。
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    const legacyProof = { phase: "cancelled", terminationPending: false, workerStopConfirmed: true,
      workerStopProof: "never-started", workerStopProcessStartKey: null };
    Object.assign(indexed, legacyProof);
    writeJobFile(workspace, job.id, { ...stored, ...legacyProof });
    for (let i = 0; i < 55; i += 1) state.jobs.push({ id: `later-${i}`, status: "completed", updatedAt: `9999-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
  });
  releasePaused(worker);
  const [result] = await once(worker.child, "message");
  assert.equal(result.type, "rejected");
  const remaining = loadState(workspace).jobs.find(entry => entry.id === job.id);
  assert.ok(!remaining || remaining.status === "cancelled");
});

test("two processes racing to claim the same ID preserve the winner's lease", darwin, async t => {
  const { workspace, job } = fixture(t, "simultaneous-claim");
  const launch = () => manage(t, fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  const first = launch(), second = launch();
  first.child.send({ job });
  second.child.send({ job });
  const [a, b] = await Promise.all([once(first.child, "message"), once(second.child, "message")]);
  assert.deepEqual([a[0].type, b[0].type].sort(), ["rejected", "started"]);
  const lease = leaseRecord(workspace, job.id);
  assert.equal(fs.statSync(lease.path).isFile(), true);
  assert.equal(loadState(workspace).jobs.filter(entry => entry.id === job.id).length, 1);
});

for (const kind of ["missing", "different-id"]) test(`partial lease ${kind} remains unconfirmed`, darwin, async t => {
  const { workspace, job } = fixture(t, `partial-${kind}`);
  await startWorker(t, job);
  const lease = leaseRecord(workspace, job.id);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  stored.workerLease = kind === "missing" ? null : { ...lease, id: "00000000-0000-4000-8000-000000000000" };
  writeJobFile(workspace, job.id, stored);
  const before = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");
  try { status(workspace); } catch { /* 矛盾は失敗または保留として扱う。 */ }
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"), before);
});

test("loss of both lease attributes with a present PID cannot turn a start-key mismatch into exit proof", darwin, async t => {
  const { workspace, job } = fixture(t, "both-leases-missing");
  await startWorker(t, job);
  leaseRecord(workspace, job.id);
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    indexed.workerLease = null;
    writeJobFile(workspace, job.id, { ...stored, workerLease: null });
  });
  try { status(workspace); } catch { /* 新旧を識別できなければエラーでも保留でもよい。 */ }
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "running");
});

test("ESRCH permits an unidentified worker to be reconciled when both records agree", darwin, async t => {
  const { workspace, job } = fixture(t, "unleased-absent");
  const worker = await startWorker(t, job, {});
  leaseRecord(workspace, job.id);
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    indexed.workerLease = null;
    writeJobFile(workspace, job.id, { ...stored, workerLease: null });
  });
  worker.child.kill("SIGKILL");
  await worker.closed;
  status(workspace);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "failed");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "failed");
});

test("ESRCH is not accepted when the two job records disagree about the owner PID", darwin, async t => {
  const { workspace, job } = fixture(t, "unleased-pid-mismatch");
  const worker = await startWorker(t, job, {});
  leaseRecord(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    Object.assign(indexed, { pid: 2147483647, workerLease: null });
    writeJobFile(workspace, job.id, { ...stored, workerLease: null });
  });
  const before = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");
  try { status(workspace); } catch { /* 元ownerが一意でなければエラーでも保留でもよい。 */ }
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"), before);
});

test("legacy completed results remain readable without a worker lease", darwin, t => {
  const { workspace, job } = fixture(t, "legacy-finished");
  const completed = { ...job, status: "completed", phase: "done", rendered: "legacy result" };
  writeJobFile(workspace, job.id, completed);
  upsertJob(workspace, completed);
  assert.equal(resolveResultJob(workspace, job.id).job.status, "completed");
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).rendered, "legacy result");
});

for (const command of ["status", "SessionEnd"]) for (const damage of ["missing", "non-array jobs"]) test(`${command} refuses ${damage} state while a leased worker is alive`, darwin, async t => {
  const { workspace, job } = fixture(t, `state-${damage.replaceAll(" ", "-")}`);
  const worker = await startWorker(t, job, {});
  const lease = leaseRecord(workspace, job.id);
  const reader = createStateJobReader(workspace, job.id);
  const stateFile = resolveStateFile(workspace);
  const detailFile = resolveJobFile(workspace, job.id);
  const detailBefore = fs.readFileSync(detailFile, "utf8");
  let damaged;
  if (damage === "missing") {
    // 検証用 root 内の原本を保全し、state の欠落だけを模擬する。
    fs.renameSync(stateFile, `${stateFile}.preserved-test-original`);
  } else {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.jobs = { unexpected: true };
    damaged = `${JSON.stringify(state)}\n`;
    fs.writeFileSync(stateFile, damaged);
  }
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  const hook = new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
  const result = command === "status"
    ? await runCommand(t, cli, ["status", "--cwd", workspace, "--json"])
    : await runCommand(t, hook, ["SessionEnd"], JSON.stringify({ cwd: workspace, session_id: job.sessionId }));
  assert.notEqual(result.code, 0, `${command} must refuse uncertain state: ${result.stdout} ${result.stderr}`);
  assert.throws(() => reader.read());
  if (damage === "missing") assert.equal(fs.existsSync(stateFile), false);
  else assert.equal(fs.readFileSync(stateFile, "utf8"), damaged);
  assert.equal(fs.readFileSync(detailFile, "utf8"), detailBefore);
  assert.equal(fs.statSync(lease.path).isFile(), true);
  assert.equal(worker.child.exitCode, null);
});

test("history pruning preserves a live lease when only detail still references it", darwin, async t => {
  const { workspace, job } = fixture(t, "detail-only-lease");
  const worker = await startWorker(t, job, {});
  const lease = leaseRecord(workspace, job.id);
  const detailFile = resolveJobFile(workspace, job.id);
  const detailBefore = fs.readFileSync(detailFile, "utf8");
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    Object.assign(indexed, { status: "completed", terminationPending: false, workerLease: null, updatedAt: "2000-01-01T00:00:00.000Z" });
    for (let i = 0; i < 55; i += 1) state.jobs.push({ id: `detail-only-history-${i}`, status: "completed", updatedAt: "9999-01-01T00:00:00.000Z" });
  });
  assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id), "the inconsistent index must be preserved");
  assert.equal(fs.readFileSync(detailFile, "utf8"), detailBefore);
  assert.equal(fs.statSync(lease.path).isFile(), true);
  assert.equal(worker.child.exitCode, null);
});

test("an explicit index removal preserves a detail-only live lease when its ledger is inconsistent", darwin, async t => {
  const { workspace, job } = fixture(t, "detail-only-explicit-removal");
  const worker = await startWorker(t, job, {});
  const lease = leaseRecord(workspace, job.id);
  const detailFile = resolveJobFile(workspace, job.id);
  const detailBefore = fs.readFileSync(detailFile, "utf8");
  updateState(workspace, state => {
    state.jobs.find(entry => entry.id === job.id).workerLease = null;
  });
  // 不整合を隔離 test root 内で模擬し、片側 lease を ledger の空きだけで捨てない。
  const ledgerFile = path.join(resolveStateDir(workspace), "darwin-lease-ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(ledger.slots[lease.slot].jobId, job.id);
  ledger.slots[lease.slot] = { slot: lease.slot, state: "free" };
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger)}\n`);
  try {
    updateState(workspace, state => { state.jobs = state.jobs.filter(entry => entry.id !== job.id); });
  } catch { /* 不整合を明示的に拒否する動作も許す。 */ }
  assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id));
  assert.equal(fs.readFileSync(detailFile, "utf8"), detailBefore);
  assert.equal(fs.statSync(lease.path).isFile(), true);
  assert.equal(worker.child.exitCode, null);
});

for (const kind of ["oversized state", "oversized detail", "FIFO detail", "symlink detail", "hardlink state", "hardlink detail", "world-writable state", "world-writable detail"]) test(`state operations reject ${kind} before an unsafe read`, darwin, async t => {
  const { workspace, job } = fixture(t, `read-${kind.replaceAll(" ", "-")}`);
  const completed = { ...job, status: "completed", phase: "done", rendered: "preserve" };
  writeJobFile(workspace, job.id, completed);
  upsertJob(workspace, completed);
  const isState = kind.endsWith(" state");
  const probePath = isState ? resolveStateFile(workspace) : resolveJobFile(workspace, job.id);
  fs.renameSync(probePath, `${probePath}.preserved-test-original`);
  if (kind === "FIFO detail") {
    const result = spawnSync("/usr/bin/mkfifo", [probePath], { timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
  } else if (kind === "symlink detail") {
    const target = path.join(workspace, "unrelated-record.json");
    fs.writeFileSync(target, JSON.stringify(completed));
    fs.symlinkSync(target, probePath);
  } else if (kind.startsWith("hardlink")) {
    fs.linkSync(`${probePath}.preserved-test-original`, probePath);
  } else if (kind.startsWith("world-writable")) {
    fs.copyFileSync(`${probePath}.preserved-test-original`, probePath);
    fs.chmodSync(probePath, 0o666);
  } else {
    const fd = fs.openSync(probePath, "wx", 0o600);
    try { fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  }
  const probe = manage(t, fork(new URL("./fixtures/darwin-state-read-probe.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  probe.child.send({ workspace, probePath, mode: isState ? "state" : "detail" });
  let timer;
  const [result] = await Promise.race([
    once(probe.child, "message"),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("record read held the state mutex past the deadline")), 5000); })
  ]).finally(() => clearTimeout(timer));
  await probe.closed;
  assert.equal(result.unsafeRead, false, JSON.stringify(result));
  if (isState) assert.equal(result.type, "rejected");
  else assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id));
  assert.ok(fs.lstatSync(probePath));
});

for (const kind of ["different-inode", "directory"]) test(`lease path ${kind} does not prove worker exit`, darwin, async t => {
  const { workspace, job } = fixture(t, `lease-${kind}`);
  await startWorker(t, job);
  const lease = leaseRecord(workspace, job.id);
  fs.renameSync(lease.path, `${lease.path}.preserved`);
  if (kind === "directory") fs.mkdirSync(lease.path);
  else fs.writeFileSync(lease.path, "replacement");
  const before = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");
  try { status(workspace); } catch { /* I/O 不明や inode 不一致は終了証拠ではない。 */ }
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"), before);
  assert.equal(fs.statSync(`${lease.path}.preserved`).isFile(), true);
});

async function pauseBeforeClaim(t, job) {
  const ready = path.join(job.workspaceRoot, `${job.id}-claim-ready`), release = path.join(job.workspaceRoot, `${job.id}-claim-release`);
  const worker = manage(t, fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  worker.child.send({ job, delayClaim: true, gateReady: ready, gateRelease: release });
  const lease = await waitGate(worker, ready);
  assert.equal(typeof lease?.path, "string");
  assert.equal(path.isAbsolute(lease.path), true);
  const relative = path.relative(resolveStateDir(job.workspaceRoot), lease.path);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return { ...worker, lease, release };
}

async function pauseAfterLeaseCreation(t, job) {
  const ready = path.join(job.workspaceRoot, `${job.id}-lease-ready`), release = path.join(job.workspaceRoot, `${job.id}-lease-release`);
  const worker = manage(t, fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-lockf-test-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_TEST_STATE_DIR: resolveStateDir(job.workspaceRoot), GROK_TEST_LEASE_READY: ready, GROK_TEST_LEASE_RELEASE: release }
  }));
  worker.child.send({ job });
  const lease = await waitGate(worker, ready);
  assert.equal(typeof lease?.path, "string");
  assert.equal(path.isAbsolute(lease.path), true);
  const relative = path.relative(resolveStateDir(job.workspaceRoot), lease.path);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return { ...worker, lease, release };
}

async function waitGate(worker, ready) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && worker.child.exitCode === null && worker.child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(ready), "fixture did not reach its external gate");
  return JSON.parse(fs.readFileSync(ready, "utf8"));
}

function releasePaused(worker) { fs.writeFileSync(worker.release, "release"); }

async function sweep(workspace) {
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  return sweepDarwinWorkerLeases(workspace, { maxEntries: 256, timeoutMs: 30000 });
}

test("sweep preserves a pre-claim lease held by a delayed live worker", darwin, async t => {
  const { workspace, job } = fixture(t, "sweep-live-claim");
  const worker = await pauseBeforeClaim(t, job);
  const before = fs.statSync(worker.lease.path, { bigint: true });
  await sweep(workspace);
  const after = fs.statSync(worker.lease.path, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  releasePaused(worker);
  const [started] = await once(worker.child, "message");
  assert.equal(started.type, "started");
  assert.equal(leaseRecord(workspace, job.id).id, worker.lease.id);
});

test("sweep reclaims an unreferenced pre-claim lease after its worker dies", darwin, async t => {
  const { workspace, job } = fixture(t, "sweep-dead-claim");
  const worker = await pauseAfterLeaseCreation(t, job);
  assert.equal(fs.statSync(worker.lease.path).isFile(), true);
  worker.child.kill("SIGKILL");
  await worker.closed;
  await sweep(workspace);
  assert.equal(fs.existsSync(worker.lease.path), false);
  assert.equal(loadState(workspace).jobs.some(entry => entry.id === job.id), false);
});

test("a late lease claimant cannot publish an inode already reclaimed by sweep", darwin, async t => {
  const { workspace, job } = fixture(t, "sweep-wins-before-lock");
  const worker = await pauseAfterLeaseCreation(t, job);
  const leasePath = worker.lease.path;
  const relative = path.relative(resolveStateDir(workspace), leasePath);
  assert.ok(path.isAbsolute(leasePath) && relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  await sweep(workspace);
  assert.equal(fs.existsSync(leasePath), false);
  releasePaused(worker);
  const [result] = await once(worker.child, "message");
  assert.equal(result.type, "rejected");
  assert.equal(loadState(workspace).jobs.some(entry => entry.id === job.id), false);
});

test("sweep preserves an orphan when the state marker changes", darwin, async t => {
  const { workspace, job } = fixture(t, "sweep-invalid-marker");
  const worker = await pauseAfterLeaseCreation(t, job);
  worker.child.kill("SIGKILL");
  await worker.closed;
  const marker = path.join(resolveStateDir(workspace), "state.lock", "protocol.json");
  fs.renameSync(marker, `${marker}.preserved`);
  fs.writeFileSync(marker, "{}\n", { mode: 0o600 });
  await assert.rejects(sweep(workspace));
  assert.equal(fs.statSync(worker.lease.path).isFile(), true);
});

test("free capacity starts a new job while an incomplete old reservation remains preserved", darwin, async t => {
  const { workspace, job } = fixture(t, "abandoned-lease");
  const abandoned = await pauseAfterLeaseCreation(t, job);
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  const active = await startWorker(t, { ...job, id: "next-job" }, {});
  assert.ok(active.child.pid);
  const current = leaseRecord(workspace, "next-job");
  // 身元未確定の予約は回収せず、free slot がある間は不要な sweep をしない。
  assert.equal(fs.existsSync(abandoned.lease.path), true);
  assert.notEqual(current.path, abandoned.lease.path);
  assert.equal(fs.statSync(current.path).isFile(), true);
});

test("lease sweep respects its deadline while another process holds the state mutex", darwin, async t => {
  const { workspace, job } = fixture(t, "sweep-deadline");
  const abandoned = await pauseAfterLeaseCreation(t, job);
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  const ready = path.join(workspace, "state-lock-held");
  const holder = manage(t, fork(new URL("./fixtures/darwin-state-lock-holder.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  holder.child.send({ workspace, ready });
  const waitDeadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < waitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready));
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  const started = Date.now();
  await assert.rejects(Promise.resolve().then(() => sweepDarwinWorkerLeases(workspace, { maxEntries: 100, timeoutMs: 200 })));
  assert.ok(Date.now() - started < 2000, "sweep exceeded its deadline");
  assert.equal(fs.statSync(abandoned.lease.path).isFile(), true);
});

test("a completed record and lease survive history pruning while its worker still holds the lease", darwin, async t => {
  const { workspace, job } = fixture(t, "completed-still-alive");
  const worker = await startWorker(t, job, { keepOpenAfterCompletion: true });
  const lease = leaseRecord(workspace, job.id);
  worker.child.send("finish");
  const [completed] = await once(worker.child, "message");
  assert.equal(completed.type, "completed");
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "completed");
  updateState(workspace, state => {
    for (let i = 0; i < 50; i += 1) {
      const record = { id: `new-finished-${i}`, status: "completed", updatedAt: `9999-01-01T00:00:${String(i).padStart(2, "0")}.000Z` };
      writeJobFile(workspace, record.id, record);
      state.jobs.push(record);
    }
  });
  await sweep(workspace);
  assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id));
  assert.equal(fs.statSync(lease.path).isFile(), true);
  worker.child.send("exit");
  await worker.closed;
});

test("history pruning reclaims a completed worker lease only after the worker exits", darwin, async t => {
  const { workspace, job } = fixture(t, "completed-worker-exited");
  const worker = await startWorker(t, job, {});
  const lease = leaseRecord(workspace, job.id);
  worker.child.send("finish");
  const [completed] = await once(worker.child, "message");
  assert.equal(completed.type, "completed");
  await worker.closed;
  await sweep(workspace);
  assert.equal(fs.statSync(lease.path).isFile(), true, "referenced history keeps its lease");
  updateState(workspace, state => {
    for (let i = 0; i < 50; i += 1) {
      const record = { id: `new-completed-${i}`, status: "completed", updatedAt: `9999-01-01T00:00:${String(i).padStart(2, "0")}.000Z` };
      writeJobFile(workspace, record.id, record);
      state.jobs.push(record);
    }
  });
  await sweep(workspace);
  updateState(workspace, () => {});
  assert.equal(loadState(workspace).jobs.some(entry => entry.id === job.id), false);
  assert.equal(fs.existsSync(lease.path), false);
});

async function runCommand(t, script, args, input = "") {
  const proc = manage(t, spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] }));
  let stdout = "", stderr = "";
  proc.child.stdout.on("data", chunk => { stdout += chunk; });
  proc.child.stderr.on("data", chunk => { stderr += chunk; });
  proc.child.stdin.end(input);
  await proc.closed;
  return { code: proc.child.exitCode, stdout, stderr };
}

test("a full lease ledger rejects foreground CLI without creating an unreferenced log", { ...darwin, timeout: 180000 }, async t => {
  const { workspace } = fixture(t, "full-cli");
  const capacity = manage(t, fork(new URL("./fixtures/darwin-sweep-capacity-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  capacity.child.send({ workspace });
  const [message] = await once(capacity.child, "message");
  assert.equal(message.type, "full", JSON.stringify(message));
  assert.equal(message.leases.length, 256);
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  const before = fs.readdirSync(jobsDir).filter(name => name.endsWith(".log")).sort();
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  const result = await runCommand(t, cli, ["task", "--cwd", workspace, "--json", "check capacity"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /full|uncertain/i);
  assert.deepEqual(fs.readdirSync(jobsDir).filter(name => name.endsWith(".log")).sort(), before);
  capacity.child.send("stop");
  await capacity.closed;
});

for (const mode of ["eio", "collision", "pause"]) test(`foreground log ${mode} preserves its published reservation`, darwin, async t => {
  const { workspace } = fixture(t, `cli-log-${mode}`);
  const ready = path.join(workspace, `log-${mode}-ready.json`);
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  const gate = fileURLToPath(new URL("./fixtures/darwin-cli-log-gate.cjs", import.meta.url));
  const processHandle = manage(t, spawn(process.execPath, ["--require", gate, cli, "task", "--cwd", workspace, "--json", "check log"], {
    env: { ...process.env, GROK_TEST_LOG_READY: ready, GROK_TEST_LOG_MODE: mode }, stdio: ["ignore", "pipe", "pipe"]
  }));
  let stderr = "";
  processHandle.child.stderr.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline && processHandle.child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready), `log gate was not reached: ${stderr}`);
  if (mode === "pause") processHandle.child.kill("SIGKILL");
  await processHandle.closed;
  assert.notEqual(processHandle.child.exitCode, 0);
  const { file } = JSON.parse(fs.readFileSync(ready, "utf8"));
  const ledger = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "darwin-lease-ledger.json"), "utf8"));
  const published = ledger.slots.filter(entry => entry.state === "published");
  assert.equal(published.length, 1, "a log failure or interrupted creation must retain its reservation");
  const indexed = loadState(workspace).jobs.find(entry => entry.id === published[0].jobId);
  const stored = readJobFile(resolveJobFile(workspace, published[0].jobId));
  assert.equal(indexed.status, "queued");
  assert.equal(indexed.logFile, file);
  assert.equal(stored.logFile, file);
  if (mode === "collision") assert.equal(fs.readFileSync(file, "utf8"), "existing log preserved\n");
  if (mode === "pause") assert.equal(fs.statSync(file).isFile(), true);
});

test("cancel keeps a stopped live worker pending instead of claiming it exited", darwin, async t => {
  const { workspace, job } = fixture(t, "cancel-stopped");
  const worker = await startWorker(t, job);
  worker.child.kill("SIGSTOP");
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  await runCommand(t, cli, ["cancel", "--cwd", workspace, "--json", job.id]);
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  assert.ok(indexed);
  assert.notEqual(indexed.workerStopConfirmed, true);
  assert.notEqual(indexed.workerStopProof, "process-exited");
  assert.equal(indexed.terminationPending, true);
});

test("cancel does not trust a legacy process-exited proof with no PID or lease", darwin, async t => {
  const { workspace, job } = fixture(t, "unverified-old-proof");
  await startWorker(t, job);
  leaseRecord(workspace, job.id);
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    const patch = { status: "cancelled", phase: "termination-pending", terminationPending: true,
      pid: null, workerLease: null, workerStopConfirmed: true, workerStopProof: "process-exited",
      workerStopProcessStartKey: indexed.processStartKey };
    Object.assign(indexed, patch);
    writeJobFile(workspace, job.id, { ...stored, ...patch });
  });
  const cli = new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname;
  await runCommand(t, cli, ["cancel", "--cwd", workspace, "--json", job.id]);
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  assert.ok(indexed);
  assert.equal(indexed.terminationPending, true);
});

test("SessionEnd retains a stopped live worker until its own exit is proved", darwin, async t => {
  const { workspace, job } = fixture(t, "session-stopped");
  const worker = await startWorker(t, job);
  worker.child.kill("SIGSTOP");
  const hook = new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
  await runCommand(t, hook, ["SessionEnd"], JSON.stringify({ cwd: workspace, session_id: job.sessionId }));
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  assert.ok(indexed, "SessionEnd must retain an unconfirmed live worker");
  assert.notEqual(indexed.workerStopConfirmed, true);
  assert.equal(indexed.terminationPending, true);
});
