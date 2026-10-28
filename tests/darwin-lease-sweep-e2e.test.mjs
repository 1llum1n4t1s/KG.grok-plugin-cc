import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, resolveStateFile, updateState, withStateSnapshot, writeJobFile
} from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

// 故障条件: 不明な state を空の参照集合として扱う、片側の record を
// 無視する、実 worker の生存中に lease を回収する。
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };

function fixture(t, id) {
  const old = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(makeTempDir("grok-sweep-state-"));
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-sweep-workspace-"));
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true });
  return { workspace, job: { id, workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "sweep-e2e-session", grokPromptState: "not-sent" } };
}

async function attemptWorker(t, job) {
  const child = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ job });
  const [message] = await once(child, "message");
  return { child, closed, message };
}

async function startWorker(t, job) {
  const worker = await attemptWorker(t, job);
  const { message } = worker;
  assert.equal(message.type, "started", JSON.stringify(message));
  return worker;
}

async function pausePublishedBeforeClaim(t, job) {
  const ready = path.join(job.workspaceRoot, `${job.id}-published-claim-ready`);
  const release = path.join(job.workspaceRoot, `${job.id}-published-claim-release`);
  const child = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ job, delayClaim: true, gateReady: ready, gateRelease: release });
  const deadline = Date.now() + 10000;
  let lease;
  while (!lease && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    try { lease = JSON.parse(fs.readFileSync(ready, "utf8")); }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(lease?.path, "worker did not reach published pre-claim gate");
  const indexed = loadState(job.workspaceRoot).jobs.find(entry => entry.id === job.id);
  const stored = readJobFile(resolveJobFile(job.workspaceRoot, job.id));
  assert.equal(indexed?.status, "queued");
  assert.equal(stored?.status, "queued");
  assert.equal(indexed.grokPromptState, "not-sent");
  assert.deepEqual(indexed.workerLease, lease);
  assert.deepEqual(stored.workerLease, lease);
  assert.equal(findLedger(job.workspaceRoot).value.slots[lease.slot].state, "published");
  return { child, closed, lease, release };
}

async function startFsyncGatedWorker(t, job, mode) {
  const ready = path.join(job.workspaceRoot, `${job.id}-binding-fsync-ready`);
  const release = path.join(job.workspaceRoot, `${job.id}-binding-fsync-release`);
  const child = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-sweep-fsync-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_SWEEP_TEST_ROOT: resolveStateDir(job.workspaceRoot), GROK_SWEEP_TEST_JOB: job.id,
      GROK_SWEEP_TEST_MODE: mode, GROK_SWEEP_TEST_READY: ready, GROK_SWEEP_TEST_RELEASE: release }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const message = once(child, "message");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ job });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(ready), "binding fsync was not observed");
  return { child, closed, message, ...JSON.parse(fs.readFileSync(ready, "utf8")) };
}

function recordedLease(workspace, id) {
  const indexed = loadState(workspace).jobs.find(job => job.id === id);
  const stored = readJobFile(resolveJobFile(workspace, id));
  assert.ok(indexed?.workerLease);
  assert.deepEqual(indexed.workerLease, stored.workerLease);
  return indexed.workerLease;
}

function assertSameFile(file, expected) {
  const actual = fs.lstatSync(file, { bigint: true });
  assert.equal(actual.isFile(), true);
  assert.equal(String(actual.dev), expected.dev);
  assert.equal(String(actual.ino), expected.ino);
}

function assertNoRecords(workspace, id) {
  assert.equal(loadState(workspace).jobs.some(entry => entry.id === id), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, id)), false);
}

function findLedger(workspace) {
  const pending = [resolveStateDir(workspace)];
  const matches = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile() && fs.statSync(name).size < 1024 * 1024) {
        try {
          const value = JSON.parse(fs.readFileSync(name, "utf8"));
          if (value?.protocol === "darwin-lease-ledger-v1") matches.push({ name, value });
        } catch { /* ledger 以外のファイル。 */ }
      }
    }
  }
  assert.equal(matches.length, 1, "exactly one durable ledger is required");
  return matches[0];
}

function setCursor(workspace, slot) {
  const ledger = findLedger(workspace);
  ledger.value.cursor = slot;
  fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
  const file = fs.openSync(ledger.name, "r");
  try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
  const directory = fs.openSync(path.dirname(ledger.name), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestRecord(record) { return createHash("sha256").update(canonicalJson(record)).digest("hex"); }

function proofFile(workspace, id) {
  return path.join(resolveStateDir(workspace), "jobs", `${id}.worker-stop-proof`);
}

test("sweep keeps the exact lease while a real worker holds its FD", darwin, async t => {
  const { workspace, job } = fixture(t, "live-owner");
  await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  assertSameFile(lease.path, lease);
  assert.deepEqual(recordedLease(workspace, job.id), lease);
});

test("sweep keeps a published queued reservation while its worker can still claim", darwin, async t => {
  const { workspace, job } = fixture(t, "published-queued-live");
  const worker = await pausePublishedBeforeClaim(t, job);
  setCursor(workspace, worker.lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  assertSameFile(worker.lease.path, worker.lease);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "queued");
  const started = once(worker.child, "message");
  fs.writeFileSync(worker.release, "release", { mode: 0o600 });
  assert.equal((await started)[0].type, "started");
});

test("sweep recovers a published queued reservation after its worker dies before claim", darwin, async t => {
  const { workspace, job } = fixture(t, "published-queued-dead");
  const worker = await pausePublishedBeforeClaim(t, job);
  worker.child.kill("SIGKILL");
  await worker.closed;
  setCursor(workspace, worker.lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  assert.equal(fs.existsSync(worker.lease.path), false, "released queued lease was not reclaimed");
  assert.equal(fs.existsSync(worker.lease.path.replace(/\.lease$/, ".binding")), false);
  assert.equal(findLedger(workspace).value.slots[worker.lease.slot].state, "free");
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.ok(indexed && stored, "queued history must remain available");
  assert.equal(indexed.status, "failed");
  assert.equal(stored.status, "failed");
  assert.equal(indexed.terminationPending, false);
  assert.equal(stored.terminationPending, false);
  assert.equal(indexed.grokPromptState, "not-sent");
  assert.equal(stored.grokPromptState, "not-sent");
  assert.equal(indexed.workerLease, null);
  assert.equal(stored.workerLease, null);
});

for (const [kind, patch] of [
  ["pending-prompt", { grokPromptState: "pending" }],
  ["direct-transport", { grokTransport: "direct" }],
  ["known-session", { grokSessionId: "unconfirmed-session" }],
  ["started-at", { startedAt: "2026-01-01T00:00:00.000Z" }],
  ["phase", { phase: "starting" }],
  ["completed-at", { completedAt: "2026-01-01T00:00:00.000Z" }],
  ["pid", { pid: 42 }]
]) {
  test(`published queued ${kind} is not treated as never started`, darwin, async t => {
    const { workspace, job } = fixture(t, `queued-uncertain-${kind}`);
    const worker = await pausePublishedBeforeClaim(t, job);
    worker.child.kill("SIGKILL");
    await worker.closed;
    updateState(workspace, state => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(workspace, job.id));
      Object.assign(indexed, patch);
      writeJobFile(workspace, job.id, { ...stored, ...patch });
    });
    setCursor(workspace, worker.lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
    catch { /* 不完全な予約の拒否も安全な結果。 */ }
    assertSameFile(worker.lease.path, worker.lease);
    assert.deepEqual(recordedLease(workspace, job.id), worker.lease);
  });
}

test("a published queued reservation with only detail completedAt is preserved", darwin, async t => {
  const { workspace, job } = fixture(t, "queued-detail-completed-at");
  const worker = await pausePublishedBeforeClaim(t, job);
  worker.child.kill("SIGKILL");
  await worker.closed;
  updateState(workspace, () => {
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    writeJobFile(workspace, job.id, { ...stored, completedAt: "2026-01-01T00:00:00.000Z" });
  });
  setCursor(workspace, worker.lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
  catch { /* 片側の完了日時は不明として拒否してよい。 */ }
  assertSameFile(worker.lease.path, worker.lease);
  assert.deepEqual(recordedLease(workspace, job.id), worker.lease);
});

test("all 256 live slots make the next reservation fail without changing records", { ...darwin, timeout: 240000 }, async t => {
  const { workspace } = fixture(t, "capacity");
  const child = fork(new URL("./fixtures/darwin-sweep-capacity-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const firstMessage = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("close", (code, signal) => reject(new Error(`capacity worker closed: ${code ?? signal}`)));
  });
  child.send({ workspace });
  const full = await firstMessage;
  assert.equal(full.type, "full", JSON.stringify(full));
  assert.equal(full.leases.length, 256);
  const paths = new Set(full.leases.map(lease => lease.path));
  assert.equal(paths.size, 256);
  for (let i = 0; i < 256; i += 1) {
    assert.ok([...paths].some(name => path.basename(name) === `slot-${String(i).padStart(3, "0")}.lease`));
  }
  for (const lease of full.leases) assertSameFile(lease.path, lease);
  const before = fs.readFileSync(resolveStateFile(workspace), "utf8");
  assert.equal(loadState(workspace).jobs.length, 256);
  const nextMessage = once(child, "message");
  child.send("overflow");
  const [extra] = await nextMessage;
  assert.equal(extra.type, "rejected", JSON.stringify(extra));
  assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8"), before);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "capacity-overflow")), false);
  for (const lease of full.leases) assertSameFile(lease.path, lease);
  child.send("exit");
  await closed;
});

test("a new worker recovers capacity after 256 published queued reservations lose their owner", { ...darwin, timeout: 480000 }, async t => {
  const { workspace, job } = fixture(t, "queued-capacity-next");
  const child = fork(new URL("./fixtures/darwin-sweep-capacity-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const ready = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("close", (code, signal) => reject(new Error(`capacity worker closed: ${code ?? signal}`)));
  });
  child.send({ workspace });
  const filled = await ready;
  assert.equal(filled.type, "full", JSON.stringify(filled));
  assert.equal(filled.leases.length, 256);
  assert.equal(loadState(workspace).jobs.filter(entry => entry.status === "queued").length, 256);
  child.kill("SIGKILL");
  await closed;
  const next = await attemptWorker(t, job);
  assert.equal(next.message.type, "started", JSON.stringify(next.message));
  const replacement = recordedLease(workspace, job.id);
  const previousIndex = filled.leases.findIndex(lease => lease.slot === replacement.slot);
  assert.ok(previousIndex >= 0, "new worker must reuse one of the released slots");
  assert.notEqual(replacement.id, filled.leases[previousIndex].id);
  const previousId = `capacity-${previousIndex}`;
  const indexed = loadState(workspace).jobs.find(entry => entry.id === previousId);
  const stored = readJobFile(resolveJobFile(workspace, previousId));
  assert.ok(indexed && stored);
  assert.equal(indexed.status, "failed");
  assert.equal(stored.status, "failed");
  assert.equal(indexed.terminationPending, false);
  assert.equal(stored.terminationPending, false);
  assert.equal(indexed.workerLease, null);
  assert.equal(stored.workerLease, null);
});

test("at capacity repeated reservations visit all slots and recover an orphan without touching an incomplete slot", { ...darwin, timeout: 480000 }, async t => {
  const { workspace, job } = fixture(t, "capacity-orphan");
  const orphan = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  orphan.child.kill("SIGKILL");
  await orphan.closed;
  assertNoRecords(workspace, job.id);
  const incomplete = await startFsyncGatedWorker(t, { ...job, id: "capacity-incomplete" }, "kill-after-file-sync");
  incomplete.child.kill("SIGKILL");
  await incomplete.closed;
  assertNoRecords(workspace, "capacity-incomplete");
  assert.equal(incomplete.binding.slot, (orphan.binding.slot + 1) % 256);
  const child = fork(new URL("./fixtures/darwin-sweep-capacity-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const first = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("close", (code, signal) => reject(new Error(`capacity worker closed: ${code ?? signal}`)));
  });
  child.send({ workspace, count: 254 });
  const filled = await first;
  assert.equal(filled.type, "full", JSON.stringify(filled));
  assert.equal(filled.leases.length, 254);
  setCursor(workspace, (incomplete.binding.slot + 1) % 256);
  let accepted;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const response = once(child, "message");
    child.send("overflow");
    const [result] = await response;
    if (result.type === "accepted") { accepted = result; break; }
    assert.equal(result.type, "rejected", JSON.stringify(result));
  }
  assert.ok(accepted, "bounded sweeps did not revisit the orphan within one full rotation");
  assert.equal(accepted.lease.slot, orphan.binding.slot);
  assert.notEqual(accepted.lease.id, orphan.binding.lease.id);
  assertSameFile(incomplete.binding.lease.path, incomplete.binding.lease);
  assert.equal(fs.existsSync(incomplete.name), true);
  child.send("stop");
  await closed;
});

for (const extension of ["lease", "binding"]) {
  test(`an unexpected ${extension} in a free slot is not overwritten or treated as empty`, darwin, async t => {
    const { workspace, job } = fixture(t, `free-remnant-${extension}`);
    await startWorker(t, job);
    const live = recordedLease(workspace, job.id);
    const directory = path.dirname(live.path);
    const occupiedSlot = Number(path.basename(live.path).slice(5, 8));
    assert.ok(Number.isInteger(occupiedSlot));
    const blockedSlot = (occupiedSlot + 1) % 256;
    const target = path.join(directory, `slot-${String(blockedSlot).padStart(3, "0")}.${extension}`);
    fs.writeFileSync(target, "unrecognised remnant", { flag: "wx", mode: 0o600 });
    const initial = fs.lstatSync(target, { bigint: true });
    const next = await attemptWorker(t, { ...job, id: `free-remnant-next-${extension}` });
    assert.ok(["started", "rejected"].includes(next.message.type), JSON.stringify(next.message));
    if (next.message.type === "started") {
      const lease = recordedLease(workspace, `free-remnant-next-${extension}`);
      assert.notEqual(path.basename(lease.path), `slot-${String(blockedSlot).padStart(3, "0")}.lease`);
    }
    assertSameFile(target, { dev: String(initial.dev), ino: String(initial.ino) });
    assert.equal(fs.readFileSync(target, "utf8"), "unrecognised remnant");
    assertSameFile(live.path, live);
  });
}

test("a legacy UUID lease is preserved and blocks new reservations", darwin, async t => {
  const { workspace, job } = fixture(t, "legacy-remnant");
  await startWorker(t, job);
  const live = recordedLease(workspace, job.id);
  const id = "00000000-0000-4000-8000-000000000000";
  const legacyDirectory = path.join(resolveStateDir(workspace), "worker-leases");
  if (!fs.existsSync(legacyDirectory)) fs.mkdirSync(legacyDirectory, { mode: 0o700 });
  const legacy = path.join(legacyDirectory, `${id}.lease`);
  fs.writeFileSync(legacy, id, { flag: "wx", mode: 0o600 });
  const initial = fs.lstatSync(legacy, { bigint: true });
  const next = await attemptWorker(t, { ...job, id: "legacy-remnant-next" });
  assert.equal(next.message.type, "rejected", JSON.stringify(next.message));
  assertSameFile(legacy, { dev: String(initial.dev), ino: String(initial.ino) });
  assert.equal(fs.readFileSync(legacy, "utf8"), id);
  assertSameFile(live.path, live);
});

for (const damage of ["missing", "old-epoch", "malformed"]) {
  test(`${damage} ledger blocks reservation and preserves an existing lease`, darwin, async t => {
    const { workspace, job } = fixture(t, `ledger-${damage}`);
    await startWorker(t, job);
    const live = recordedLease(workspace, job.id);
    const ledger = findLedger(workspace);
    if (damage === "missing") fs.renameSync(ledger.name, path.join(workspace, "preserved-ledger"));
    else if (damage === "old-epoch") {
      fs.writeFileSync(ledger.name, JSON.stringify({ ...ledger.value, epoch: "00000000-0000-4000-8000-000000000000" }), { mode: 0o600 });
    } else fs.writeFileSync(ledger.name, "{broken", { mode: 0o600 });
    const next = await attemptWorker(t, { ...job, id: `ledger-next-${damage}` });
    assert.equal(next.message.type, "rejected", JSON.stringify(next.message));
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 256, timeoutMs: 5000 }); }
    catch { /* ledger の不確かさは拒否でもよい。 */ }
    assertSameFile(live.path, live);
    assert.equal(fs.existsSync(resolveJobFile(workspace, `ledger-next-${damage}`)), false);
  });
}

for (const duplicate of ["slot", "claimToken", "path"]) {
  test(`duplicate ledger ${duplicate} rejects new reservations and retains both owners`, darwin, async t => {
    const { workspace, job } = fixture(t, `duplicate-a-${duplicate}`);
    await startWorker(t, job);
    const secondId = `duplicate-b-${duplicate}`;
    await startWorker(t, { ...job, id: secondId });
    const firstLease = recordedLease(workspace, job.id);
    const secondLease = recordedLease(workspace, secondId);
    const ledger = findLedger(workspace);
    const first = ledger.value.slots.find(entry => entry.jobId === job.id);
    const second = ledger.value.slots.find(entry => entry.jobId === secondId);
    assert.equal(first?.state, "published");
    assert.equal(second?.state, "published");
    if (duplicate === "path") second.lease.path = first.lease.path;
    else second[duplicate] = first[duplicate];
    fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
    const nextId = `duplicate-next-${duplicate}`;
    const next = await attemptWorker(t, { ...job, id: nextId });
    assert.equal(next.message.type, "rejected", JSON.stringify(next.message));
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 256, timeoutMs: 5000 }); }
    catch { /* 重複 ledger は拒否してよい。 */ }
    assertSameFile(firstLease.path, firstLease);
    assertSameFile(secondLease.path, secondLease);
    assert.equal(fs.existsSync(resolveJobFile(workspace, nextId)), false);
  });
}

for (const damage of ["not-published", "changed-token"]) {
  test(`owner cannot commit output or log with ${damage} ledger`, darwin, async t => {
    const { workspace, job } = fixture(t, `owner-${damage}`);
    const logFile = path.join(workspace, "owner.log");
    fs.writeFileSync(logFile, "existing log\n", { mode: 0o600 });
    const worker = await startWorker(t, { ...job, logFile });
    const lease = recordedLease(workspace, job.id);
    const ledger = findLedger(workspace);
    const slot = ledger.value.slots.find(entry => entry.jobId === job.id);
    assert.equal(slot?.state, "published");
    if (damage === "not-published") slot.state = "reserved";
    else slot.claimToken = "00000000-0000-4000-8000-000000000000";
    fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
    const stateBefore = fs.readFileSync(resolveStateFile(workspace), "utf8");
    const detailBefore = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");
    const logBefore = fs.readFileSync(logFile, "utf8");
    const message = once(worker.child, "message");
    worker.child.send("finish");
    const [result] = await message;
    assert.equal(result.type, "rejected", JSON.stringify(result));
    assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8"), stateBefore);
    assert.equal(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"), detailBefore);
    assert.equal(fs.readFileSync(logFile, "utf8"), logBefore);
    assertSameFile(lease.path, lease);
  });
}

for (const damage of ["missing-index", "corrupt-index", "malformed-index", "missing-detail", "corrupt-detail"]) {
  test(`sweep retains the lease when ${damage} makes references uncertain`, darwin, async t => {
    const { workspace, job } = fixture(t, `uncertain-${damage}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    worker.child.kill("SIGKILL");
    await worker.closed;
    setCursor(workspace, lease.slot);
    const target = damage.endsWith("index") ? resolveStateFile(workspace) : resolveJobFile(workspace, job.id);
    fs.renameSync(target, `${target}.preserved`);
    if (damage.startsWith("corrupt")) fs.writeFileSync(target, "{broken", { mode: 0o600 });
    if (damage === "malformed-index") fs.writeFileSync(target, JSON.stringify({ version: 1, jobs: null }), { mode: 0o600 });
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try {
      await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
    } catch {
      // 不確かな state の明示拒否も安全な結果。
    }
    assertSameFile(lease.path, lease);
    assert.equal(fs.existsSync(`${target}.preserved`), true);
  });
}

// binding の候補形式は設計審査中: { jobId, claimToken, epoch, slot, lease }。
// SIGKILL と EIO はプロセス中断と syscall 失敗の試験であり、電源断の証明ではない。
test("binding file is synced before either record is published", darwin, async t => {
  const { workspace, job } = fixture(t, "binding-interrupted");
  const worker = await startFsyncGatedWorker(t, job, "kill-after-file-sync");
  assert.equal(worker.binding.epoch, worker.binding.lease.stateGeneration);
  assert.equal(worker.binding.jobId, job.id);
  assert.ok(worker.binding.claimToken);
  assertSameFile(worker.binding.lease.path, worker.binding.lease);
  assertNoRecords(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  assert.equal(fs.existsSync(worker.name), true);
  assertSameFile(worker.binding.lease.path, worker.binding.lease);
  setCursor(workspace, worker.binding.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
  catch { /* directory の耐久性が不明なら拒否または保全する。 */ }
  assert.equal(fs.existsSync(worker.name), true);
  assertSameFile(worker.binding.lease.path, worker.binding.lease);
});

test("binding fsync failure rejects the worker before publishing records", darwin, async t => {
  const { workspace, job } = fixture(t, "binding-sync-failure");
  const worker = await startFsyncGatedWorker(t, job, "fail-file-sync");
  const [result] = await worker.message;
  assert.equal(result.type, "rejected", JSON.stringify(result));
  assertNoRecords(workspace, job.id);
  assert.equal(fs.existsSync(worker.name), true);
  assertSameFile(worker.binding.lease.path, worker.binding.lease);
});

test("lease unlink directory fsync failure retains the binding", { ...darwin, timeout: 180000 }, async t => {
  const { workspace, job } = fixture(t, "unlink-sync-failure");
  const abandoned = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  assertNoRecords(workspace, job.id);
  const ready = path.join(workspace, "unlink-fsync-ready");
  const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-sweep-fsync-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_SWEEP_TEST_ROOT: resolveStateDir(workspace), GROK_SWEEP_TEST_MODE: "fail-unlink-directory-sync",
      GROK_SWEEP_TEST_UNLINK: abandoned.binding.lease.path, GROK_SWEEP_TEST_READY: ready }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const message = new Promise((resolve, reject) => {
    child.once("message", value => resolve([value]));
    child.once("close", (code, signal) => reject(new Error(`observer closed before responding: ${code ?? signal}`)));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ workspace });
  const [result] = await message;
  assert.ok(fs.existsSync(ready), "lease unlink directory fsync was not observed");
  assert.ok(["rejected", "uncertain"].includes(result.type), JSON.stringify(result));
  assert.equal(fs.existsSync(abandoned.name), true, "binding must survive an uncertain unlink");
});

test("prune retains completed detail and log while reclaim unlink durability is uncertain", { ...darwin, timeout: 180000 }, async t => {
  const { workspace, job } = fixture(t, "prune-reclaim-failure");
  const logFile = path.join(workspace, "completed.log");
  fs.writeFileSync(logFile, "existing log\n", { mode: 0o600 });
  const worker = await startWorker(t, { ...job, logFile });
  const lease = recordedLease(workspace, job.id);
  const completion = once(worker.child, "message");
  worker.child.send("finish");
  assert.equal((await completion)[0].type, "completed");
  await worker.closed;
  const detailBefore = readJobFile(resolveJobFile(workspace, job.id));
  const logBefore = fs.readFileSync(logFile, "utf8");
  updateState(workspace, state => {
    for (let i = 0; i < 50; i += 1) {
      const record = { id: `prune-new-${i}`, status: "completed", updatedAt: `9999-01-01T00:00:${String(i).padStart(2, "0")}.000Z` };
      writeJobFile(workspace, record.id, record);
      state.jobs.push(record);
    }
  });
  assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id));
  const ready = path.join(workspace, "prune-unlink-fsync-ready");
  const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-sweep-fsync-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_SWEEP_TEST_ROOT: resolveStateDir(workspace), GROK_SWEEP_TEST_MODE: "fail-unlink-directory-sync",
      GROK_SWEEP_TEST_UNLINK: lease.path, GROK_SWEEP_TEST_READY: ready }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const message = new Promise((resolve, reject) => {
    child.once("message", value => resolve([value]));
    child.once("close", (code, signal) => reject(new Error(`observer closed before responding: ${code ?? signal}`)));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ workspace });
  const [result] = await message;
  assert.ok(fs.existsSync(ready), "lease unlink directory fsync was not observed");
  assert.ok(["rejected", "uncertain"].includes(result.type), JSON.stringify(result));
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const detail = readJobFile(resolveJobFile(workspace, job.id));
  assert.ok(indexed && detail, "reclaiming job must remain protected from prune");
  assert.equal(detail.rendered, detailBefore.rendered);
  assert.equal(fs.readFileSync(logFile, "utf8"), logBefore);
});

test("observer death during unlink keeps reclaiming ledger and completed artifacts", { ...darwin, timeout: 180000 }, async t => {
  const { workspace, job } = fixture(t, "prune-reclaim-killed");
  const logFile = path.join(workspace, "completed-killed.log");
  fs.writeFileSync(logFile, "existing log\n", { mode: 0o600 });
  const worker = await startWorker(t, { ...job, logFile });
  const lease = recordedLease(workspace, job.id);
  const completion = once(worker.child, "message");
  worker.child.send("finish");
  assert.equal((await completion)[0].type, "completed");
  await worker.closed;
  const detailBefore = readJobFile(resolveJobFile(workspace, job.id));
  const logBefore = fs.readFileSync(logFile, "utf8");
  updateState(workspace, state => {
    for (let i = 0; i < 50; i += 1) {
      const record = { id: `prune-killed-new-${i}`, status: "completed", updatedAt: `9999-01-01T00:00:${String(i).padStart(2, "0")}.000Z` };
      writeJobFile(workspace, record.id, record);
      state.jobs.push(record);
    }
  });
  const ready = path.join(workspace, "prune-unlink-kill-ready");
  const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-sweep-fsync-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_SWEEP_TEST_ROOT: resolveStateDir(workspace), GROK_SWEEP_TEST_MODE: "kill-before-unlink-directory-sync",
      GROK_SWEEP_TEST_UNLINK: lease.path, GROK_SWEEP_TEST_READY: ready, GROK_SWEEP_TEST_RELEASE: path.join(workspace, "unused-release") }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ workspace });
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready), "lease unlink directory fsync was not observed");
  child.kill("SIGKILL");
  await closed;
  const ledger = findLedger(workspace);
  assert.equal(ledger.value.slots.find(entry => entry.jobId === job.id)?.state, "reclaiming");
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const detail = readJobFile(resolveJobFile(workspace, job.id));
  assert.ok(indexed && detail, "reclaiming job must remain protected from prune");
  assert.equal(detail.rendered, detailBefore.rendered);
  assert.equal(fs.readFileSync(logFile, "utf8"), logBefore);
  assert.equal(fs.existsSync(lease.path.replace(/\.lease$/, ".binding")), true);
});

for (const [kind, altered] of [["queued", false], ["terminal", false], ["queued", true], ["terminal", true]]) {
  test(`observer death between ${kind} detail and index commits ${altered ? "preserves altered detail" : "resumes from durable reclaim intent"}`, darwin, async t => {
    const { workspace, job } = fixture(t, `detail-index-crash-${kind}-${altered}`);
    let lease;
    if (kind === "queued") {
      const worker = await pausePublishedBeforeClaim(t, job);
      lease = worker.lease;
      worker.child.kill("SIGKILL");
      await worker.closed;
    } else {
      const worker = await startWorker(t, job);
      lease = recordedLease(workspace, job.id);
      const completed = once(worker.child, "message");
      worker.child.send("finish");
      assert.equal((await completed)[0].type, "completed");
      await worker.closed;
    }
    setCursor(workspace, lease.slot);
    const detailPath = resolveJobFile(workspace, job.id);
    const gate = path.join(workspace, "detail-index-crash-gate.cjs");
    const ready = path.join(workspace, "detail-index-crash-ready");
    fs.writeFileSync(gate, String.raw`
      const fs = require("node:fs");
      const path = require("node:path");
      const { syncBuiltinESMExports } = require("node:module");
      const originalOpen = fs.openSync, originalClose = fs.closeSync;
      const originalRename = fs.renameSync, originalSync = fs.fsyncSync;
      const names = new Map();
      let pending = false, gated = false;
      fs.openSync = function(name, ...args) {
        const fd = originalOpen.call(this, name, ...args);
        if (typeof name === "string") names.set(fd, path.resolve(name));
        return fd;
      };
      fs.closeSync = function(fd) {
        try { return originalClose.call(this, fd); } finally { names.delete(fd); }
      };
      fs.renameSync = function(from, to, ...args) {
        const result = originalRename.call(this, from, to, ...args);
        if (typeof to === "string" && path.resolve(to) === process.env.GROK_DETAIL_TARGET) pending = true;
        return result;
      };
      fs.fsyncSync = function(fd) {
        const result = originalSync.call(this, fd);
        if (!gated && pending && names.get(fd) === path.dirname(process.env.GROK_DETAIL_TARGET)) {
          gated = true;
          fs.writeFileSync(process.env.GROK_DETAIL_READY, "ready", { mode: 0o600 });
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          throw new Error("detail/index crash gate timed out");
        }
        return result;
      };
      syncBuiltinESMExports();
    `, { mode: 0o600 });
    const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: ["--require", gate],
      env: { ...process.env, GROK_DETAIL_TARGET: detailPath, GROK_DETAIL_READY: ready }
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    child.send({ workspace, iterations: 1 });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(ready), "detail directory fsync was not observed");
    child.kill("SIGKILL");
    await closed;
    assert.equal(findLedger(workspace).value.slots[lease.slot].state, "reclaiming");
    const beforeIndex = loadState(workspace).jobs.find(entry => entry.id === job.id);
    const beforeDetail = readJobFile(detailPath);
    assert.deepEqual(beforeIndex.workerLease, lease);
    assert.equal(beforeDetail.workerLease, null);
    if (altered) writeJobFile(workspace, job.id, { ...beforeDetail, rendered: "unexpected alteration" });
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    if (altered) {
      try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); } catch { /* 不一致は拒否してよい。 */ }
      assertSameFile(lease.path, lease);
      assert.equal(fs.existsSync(lease.path.replace(/\.lease$/, ".binding")), true);
      assert.equal(findLedger(workspace).value.slots[lease.slot].state, "reclaiming");
      assert.deepEqual(loadState(workspace).jobs.find(entry => entry.id === job.id).workerLease, lease);
      assert.equal(readJobFile(detailPath).rendered, "unexpected alteration");
      return;
    }
    await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
    assert.equal(fs.existsSync(lease.path), false);
    assert.equal(fs.existsSync(lease.path.replace(/\.lease$/, ".binding")), false);
    assert.equal(findLedger(workspace).value.slots[lease.slot].state, "free");
    const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(detailPath);
    assert.equal(indexed.workerLease, null);
    assert.equal(stored.workerLease, null);
    assert.equal(indexed.workerStopProof, "darwin-lease-released");
    assert.equal(stored.workerStopProof, "darwin-lease-released");
    const { verifyDarwinStopCertificate } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    withStateSnapshot(workspace, (_state, context) => verifyDarwinStopCertificate({ context, indexed, stored }));
  });
}

test("reader directory fsync failure cannot authorize reclaim", { ...darwin, timeout: 180000 }, async t => {
  const { workspace, job } = fixture(t, "reader-sync-failure");
  const abandoned = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  assertNoRecords(workspace, job.id);
  const ready = path.join(workspace, "reader-fsync-ready");
  const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-sweep-fsync-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_SWEEP_TEST_ROOT: resolveStateDir(workspace), GROK_SWEEP_TEST_MODE: "fail-reader-sync",
      GROK_SWEEP_TEST_DIRECTORY: path.dirname(abandoned.name), GROK_SWEEP_TEST_READY: ready }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const message = new Promise((resolve, reject) => {
    child.once("message", value => resolve([value]));
    child.once("close", (code, signal) => reject(new Error(`observer closed before responding: ${code ?? signal}`)));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ workspace });
  const [result] = await message;
  assert.ok(fs.existsSync(ready), "reader directory fsync was not observed");
  assert.ok(["rejected", "uncertain"].includes(result.type), JSON.stringify(result));
  assert.equal(fs.existsSync(abandoned.name), true);
  assertSameFile(abandoned.binding.lease.path, abandoned.binding.lease);
});

test("a durable detail without an index remains uncertain after worker death", { ...darwin, timeout: 180000 }, async t => {
  const { workspace, job } = fixture(t, "partial-reservation");
  const worker = await startFsyncGatedWorker(t, job, "kill-after-detail-sync");
  assert.ok(fs.existsSync(resolveJobFile(workspace, job.id)));
  assert.equal(loadState(workspace).jobs.some(entry => entry.id === job.id), false);
  worker.child.kill("SIGKILL");
  await worker.closed;
  const { DARWIN_LEASE_SLOT_COUNT } = await import("../plugins/grok/scripts/lib/darwin-worker-lease.mjs");
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  for (let i = 0; i < DARWIN_LEASE_SLOT_COUNT * 2; i += 1) {
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
    catch { /* 片側 record の拒否も保全として扱う。 */ }
  }
  assertSameFile(worker.binding.lease.path, worker.binding.lease);
  assert.equal(fs.existsSync(worker.name), true);
  assert.ok(fs.existsSync(resolveJobFile(workspace, job.id)));
});

test("a second job referencing a reserved lease prevents reclamation", darwin, async t => {
  const { workspace, job } = fixture(t, "reverse-owner-a");
  const abandoned = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  assertNoRecords(workspace, job.id);
  const other = { ...job, id: "reverse-owner-b", createdAt: new Date().toISOString(), status: "queued", phase: "queued", pid: null,
    epoch: abandoned.binding.epoch, claimToken: "00000000-0000-4000-8000-000000000000", workerLease: abandoned.binding.lease };
  updateState(workspace, state => {
    writeJobFile(workspace, other.id, other);
    state.jobs.push(other);
  });
  setCursor(workspace, abandoned.binding.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
  catch { /* 不一致を拒否することも安全な結果。 */ }
  assertSameFile(abandoned.binding.lease.path, abandoned.binding.lease);
  assert.equal(fs.existsSync(abandoned.name), true);
  assert.equal(readJobFile(resolveJobFile(workspace, other.id)).workerLease.ino, abandoned.binding.lease.ino);
});

test("lockf probe respects the remaining sweep time budget", darwin, async t => {
  const { workspace, job } = fixture(t, "bounded-lockf");
  const abandoned = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  assertNoRecords(workspace, job.id);
  setCursor(workspace, abandoned.binding.slot);
  const ready = path.join(workspace, "slow-lockf-ready");
  const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: ["--require", fileURLToPath(new URL("./fixtures/darwin-sweep-slow-lockf-gate.cjs", import.meta.url))],
    env: { ...process.env, GROK_SWEEP_SLOW_READY: ready }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const message = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("close", (code, signal) => reject(new Error(`observer closed before responding: ${code ?? signal}`)));
  });
  const started = Date.now();
  child.send({ workspace, iterations: 1, timeoutMs: 300 });
  const result = await message;
  assert.ok(["completed", "rejected"].includes(result.type), JSON.stringify(result));
  assert.ok(fs.existsSync(ready), "lockf boundary was not reached");
  const observed = JSON.parse(fs.readFileSync(ready, "utf8"));
  assert.ok(observed.timeout > 0 && observed.timeout <= 300, JSON.stringify(observed));
  assert.ok(Date.now() - started < 1500, "observer exceeded the bounded probe time");
  assertSameFile(abandoned.binding.lease.path, abandoned.binding.lease);
});

test("reverse-reference scanning checks the deadline between detail files", darwin, async t => {
  const { workspace, job } = fixture(t, "reverse-scan-deadline");
  const abandoned = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  assertNoRecords(workspace, job.id);
  updateState(workspace, state => {
    for (let i = 0; i < 12; i += 1) {
      const record = { id: `deadline-detail-${i}`, status: "completed" };
      writeJobFile(workspace, record.id, record);
      state.jobs.push(record);
    }
  });
  setCursor(workspace, abandoned.binding.slot);
  const gate = path.join(workspace, "slow-detail-read-gate.cjs");
  const reads = path.join(workspace, "slow-detail-read-count");
  fs.writeFileSync(gate, String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { syncBuiltinESMExports } = require("node:module");
    const originalOpen = fs.openSync, originalClose = fs.closeSync, originalRead = fs.readFileSync;
    const names = new Map();
    fs.openSync = function(name, ...args) {
      const fd = originalOpen.call(this, name, ...args);
      if (typeof name === "string") names.set(fd, path.resolve(name));
      return fd;
    };
    fs.closeSync = function(fd) {
      try { return originalClose.call(this, fd); } finally { names.delete(fd); }
    };
    fs.readFileSync = function(file, ...args) {
      const name = typeof file === "number" ? names.get(file) : null;
      if (name && path.dirname(name) === process.env.GROK_SWEEP_SLOW_JOBS && name.endsWith(".json")) {
        fs.appendFileSync(process.env.GROK_SWEEP_READS, "1\n", { mode: 0o600 });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
      }
      return originalRead.call(this, file, ...args);
    };
    syncBuiltinESMExports();
  `, { mode: 0o600 });
  const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: ["--require", gate],
    env: { ...process.env, GROK_SWEEP_SLOW_JOBS: path.join(resolveStateDir(workspace), "jobs"), GROK_SWEEP_READS: reads }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const response = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("close", (code, signal) => reject(new Error(`observer closed before responding: ${code ?? signal}`)));
  });
  child.send({ workspace, iterations: 1, timeoutMs: 900 });
  const result = await response;
  assert.ok(["completed", "rejected"].includes(result.type), JSON.stringify(result));
  assert.ok(fs.existsSync(reads), "reverse-reference detail read was not reached");
  const count = fs.readFileSync(reads, "utf8").trim().split(/\s+/).length;
  assert.ok(count <= 6, `deadline expired but ${count} detail files were read`);
  assertSameFile(abandoned.binding.lease.path, abandoned.binding.lease);
  assert.equal(fs.existsSync(abandoned.name), true);
});

test("reverse-reference scan over 64 MiB preserves the reserved slot", { ...darwin, timeout: 120000 }, async t => {
  const { workspace, job } = fixture(t, "reverse-scan-byte-limit");
  const abandoned = await startFsyncGatedWorker(t, job, "kill-after-reserved-identity");
  abandoned.child.kill("SIGKILL");
  await abandoned.closed;
  assertNoRecords(workspace, job.id);
  const padding = "x".repeat(8 * 1024 * 1024);
  updateState(workspace, state => {
    for (let i = 0; i < 9; i += 1) {
      const record = { id: `large-detail-${i}`, status: "completed" };
      writeJobFile(workspace, record.id, { ...record, padding });
      state.jobs.push(record);
    }
  });
  setCursor(workspace, abandoned.binding.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 30000 }); }
  catch { /* 総読取上限超過の拒否も安全な結果。 */ }
  assertSameFile(abandoned.binding.lease.path, abandoned.binding.lease);
  assert.equal(fs.existsSync(abandoned.name), true);
});

for (const invalidId of ["job A", ".hidden", "日本語"]) {
  test(`invalid job ID ${invalidId} is rejected before publishing state`, darwin, async t => {
    const { workspace, job } = fixture(t, "invalid-id");
    const ledger = findLedger(workspace);
    const slotsBefore = ledger.value.slots;
    const stateBefore = fs.readFileSync(resolveStateFile(workspace), "utf8");
    const worker = await attemptWorker(t, { ...job, id: invalidId });
    assert.equal(worker.message.type, "rejected", JSON.stringify(worker.message));
    assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8"), stateBefore);
    assert.deepEqual(findLedger(workspace).value.slots, slotsBefore);
    assert.equal(fs.existsSync(resolveJobFile(workspace, invalidId)), false);
    await startWorker(t, { ...job, id: "valid-after-invalid" });
  });
}

test("oversized reservation metadata is rejected before any ledger update", darwin, async t => {
  const { workspace, job } = fixture(t, "oversized-metadata");
  await startWorker(t, job);
  const ledger = findLedger(workspace);
  const before = ledger.value.slots;
  const next = await attemptWorker(t, { ...job, id: "oversized-next", createdAt: "x".repeat(1024 * 1024) });
  assert.equal(next.message.type, "rejected", JSON.stringify(next.message));
  assert.deepEqual(findLedger(workspace).value.slots, before);
  assert.equal(fs.existsSync(path.join(path.dirname(ledger.name), "darwin-lease-ledger.prepared")), false);
});

for (const patch of [{ pid: 42 }, { processStartKey: "unexpected" }, { terminationPending: true }, { grokPromptState: "pending" }]) {
  test(`publish rejects queued reservation with ${Object.keys(patch)[0]} already set`, darwin, async t => {
    const { workspace, job } = fixture(t, `bad-queued-${Object.keys(patch)[0]}`);
    const worker = await startFsyncGatedWorker(t, job, "pause-after-queued-index-sync");
    const indexPath = resolveStateFile(workspace);
    const detailPath = resolveJobFile(workspace, job.id);
    const state = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const detail = JSON.parse(fs.readFileSync(detailPath, "utf8"));
    assert.equal(indexed.status, "queued");
    assert.equal(detail.status, "queued");
    Object.assign(indexed, patch);
    Object.assign(detail, patch);
    fs.writeFileSync(indexPath, JSON.stringify(state), { mode: 0o600 });
    fs.writeFileSync(detailPath, JSON.stringify(detail), { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, `${job.id}-binding-fsync-release`), "release", { mode: 0o600 });
    const [result] = await worker.message;
    assert.equal(result.type, "rejected", JSON.stringify(result));
    assertSameFile(worker.binding.lease.path, worker.binding.lease);
  });
}

test("bounded sweeps revisit a later orphan despite live and malformed slots", { ...darwin, timeout: 180000 }, async t => {
  const { workspace, job } = fixture(t, "fair-live");
  await startWorker(t, job);
  const live = recordedLease(workspace, job.id);
  const first = await startFsyncGatedWorker(t, { ...job, id: "fair-uncertain" }, "kill-after-reserved-identity");
  first.child.kill("SIGKILL");
  await first.closed;
  assertNoRecords(workspace, "fair-uncertain");
  fs.renameSync(first.name, path.join(workspace, "fair-uncertain-binding-preserved"));
  fs.writeFileSync(first.name, "{broken", { mode: 0o600 });
  const later = await startFsyncGatedWorker(t, { ...job, id: "fair-orphan" }, "kill-after-reserved-identity");
  later.child.kill("SIGKILL");
  await later.closed;
  assertNoRecords(workspace, "fair-orphan");
  assertSameFile(later.binding.lease.path, later.binding.lease);
  const { DARWIN_LEASE_SLOT_COUNT } = await import("../plugins/grok/scripts/lib/darwin-worker-lease.mjs");
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  assert.ok(Number.isSafeInteger(DARWIN_LEASE_SLOT_COUNT) && DARWIN_LEASE_SLOT_COUNT >= 3);
  for (let i = 0; i < DARWIN_LEASE_SLOT_COUNT * 2 && fs.existsSync(later.binding.lease.path); i += 1) {
    await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  }
  assert.equal(fs.existsSync(later.binding.lease.path), false, "cursor did not reach the later orphan");
  assertSameFile(live.path, live);
  assertSameFile(first.binding.lease.path, first.binding.lease);
  assert.equal(fs.readFileSync(first.name, "utf8"), "{broken");
});

test("cursor survives observer restarts and advances past live, malformed and empty slots", darwin, async t => {
  const { workspace, job } = fixture(t, "cursor-live");
  await startWorker(t, job);
  const live = recordedLease(workspace, job.id);
  const slot = Number(path.basename(live.path).slice(5, 8));
  const invalidSlot = (slot + 1) % 256;
  const emptySlot = (slot + 2) % 256;
  const invalid = path.join(path.dirname(live.path), `slot-${String(invalidSlot).padStart(3, "0")}.binding`);
  fs.writeFileSync(invalid, "{broken", { flag: "wx", mode: 0o600 });
  const ledger = findLedger(workspace);
  assert.equal(ledger.value.slots[invalidSlot].state, "free");
  assert.equal(ledger.value.slots[emptySlot].state, "free");
  ledger.value.cursor = slot;
  fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
  const ledgerFd = fs.openSync(ledger.name, "r");
  try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }
  const dirFd = fs.openSync(path.dirname(ledger.name), "r");
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  for (const expected of [invalidSlot, emptySlot, (emptySlot + 1) % 256]) {
    const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    const response = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("close", (code, signal) => reject(new Error(`cursor observer closed: ${code ?? signal}`)));
    });
    child.send({ workspace, iterations: 1 });
    const result = await response;
    assert.ok(["completed", "rejected"].includes(result.type), JSON.stringify(result));
    await closed;
    assert.equal(findLedger(workspace).value.cursor, expected);
  }
  assert.equal(fs.readFileSync(invalid, "utf8"), "{broken");
  assertSameFile(live.path, live);
});

test("a corrupt detail preserves its slot but does not stop the bounded sweep", darwin, async t => {
  const { workspace, job } = fixture(t, "cursor-corrupt-detail-first");
  await startWorker(t, job);
  const first = recordedLease(workspace, job.id);
  const secondJob = { ...job, id: "cursor-corrupt-detail-second" };
  await startWorker(t, secondJob);
  const second = recordedLease(workspace, secondJob.id);
  assert.equal(second.slot, (first.slot + 1) % 256);
  const detailPath = resolveJobFile(workspace, job.id);
  fs.renameSync(detailPath, path.join(workspace, "preserved-corrupt-detail"));
  fs.writeFileSync(detailPath, "{broken", { mode: 0o600 });
  setCursor(workspace, first.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 2, timeoutMs: 5000 }); }
  catch { /* slot 不明で失敗を返しても cursor の進行は必要。 */ }
  assert.equal(findLedger(workspace).value.cursor, (second.slot + 1) % 256);
  assertSameFile(first.path, first);
  assertSameFile(second.path, second);
});

for (const transport of ["broker", "direct"]) {
  test(`worker exit does not erase pending ${transport} turn evidence`, darwin, async t => {
    const { workspace, job } = fixture(t, `pending-${transport}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    worker.child.kill("SIGKILL");
    await worker.closed;
    const evidence = {
      status: "failed", phase: "termination-pending", terminationPending: true,
      grokPromptState: "pending", grokSessionId: "pending-session", grokTransport: transport,
      ...(transport === "broker" ? { grokBrokerGeneration: "broker-generation" }
        : { grokDirectGeneration: "direct-generation", grokDirectOwnerPid: 12345,
          grokDirectOwnerStartKey: "darwin-lstart-utc-v1:Thu Jan  1 00:00:00 1970" })
    };
    updateState(workspace, state => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const detail = readJobFile(resolveJobFile(workspace, job.id));
      Object.assign(indexed, evidence);
      writeJobFile(workspace, job.id, { ...detail, ...evidence });
      for (let i = 0; i < 50; i += 1) {
        const record = { id: `finished-${i}`, status: "completed", updatedAt: `9999-01-01T00:00:${String(i).padStart(2, "0")}.000Z` };
        writeJobFile(workspace, record.id, record);
        state.jobs.push(record);
      }
    });
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
    const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
    const detail = readJobFile(resolveJobFile(workspace, job.id));
    assert.ok(indexed && detail, "pending turn must remain available for retry");
    assertSameFile(lease.path, lease);
    assert.deepEqual(indexed.workerLease, lease);
    assert.deepEqual(detail.workerLease, lease);
    for (const [key, value] of Object.entries(evidence)) {
      assert.equal(indexed[key], value, `index lost ${key}`);
      assert.equal(detail[key], value, `detail lost ${key}`);
    }
  });
}

test("a terminal worker record without turn-stop evidence is not reclaimable", darwin, async t => {
  const { workspace, job } = fixture(t, "turn-not-confirmed");
  const worker = await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  const patch = {
    status: "failed", phase: "failed", terminationPending: false,
    grokPromptState: "pending", grokSessionId: "unconfirmed-turn", grokTransport: "broker", grokBrokerGeneration: "generation"
  };
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const detail = readJobFile(resolveJobFile(workspace, job.id));
    Object.assign(indexed, patch);
    writeJobFile(workspace, job.id, { ...detail, ...patch });
  });
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  assertSameFile(lease.path, lease);
  assert.deepEqual(recordedLease(workspace, job.id), lease);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).grokPromptState, "pending");
});

test("terminal lease reclaim durably records worker stop proof in both retained records", darwin, async t => {
  const { workspace, job } = fixture(t, "terminal-persist-worker-proof");
  const worker = await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  const completed = once(worker.child, "message");
  worker.child.send("finish");
  assert.equal((await completed)[0].type, "completed");
  await worker.closed;
  const before = readJobFile(resolveJobFile(workspace, job.id));
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  assert.equal(fs.existsSync(lease.path), false);
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.ok(indexed && stored, "finished history must survive lease reclaim");
  for (const record of [indexed, stored]) {
    assert.equal(record.workerLease, null);
    assert.equal(record.workerStopConfirmed, true);
    assert.equal(record.workerStopProof, "darwin-lease-released");
    assert.equal(record.workerStopLeaseId, lease.id);
    assert.equal(record.workerStopProcessStartKey, before.processStartKey ?? null);
  }
  assert.equal(stored.rendered, before.rendered);
});

for (const mode of ["issue", "validate"]) {
  test(`a v3 marker cannot ${mode} a Darwin stop certificate`, darwin, async t => {
    const { workspace, job } = fixture(t, `certificate-v3-${mode}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completed = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completed)[0].type, "completed");
    await worker.closed;
    const { sweepDarwinWorkerLeases, verifyDarwinStopCertificate } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    if (mode === "validate") {
      // 旧 protocol の証明を fixture で再現し、製品の発行経路に依存しない。
      const bindingIno = findLedger(workspace).value.slots[lease.slot].bindingIno;
      updateState(workspace, state => {
        const indexed = state.jobs.find(entry => entry.id === job.id);
        const stored = readJobFile(resolveJobFile(workspace, job.id));
        const patch = { workerLease: null, workerStopConfirmed: true, workerStopProof: "darwin-lease-released",
          workerStopLeaseId: lease.id, workerStopProcessStartKey: indexed.processStartKey ?? null };
        Object.assign(indexed, patch);
        writeJobFile(workspace, job.id, { ...stored, ...patch });
      });
      const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(workspace, job.id));
      const proofFd = fs.openSync(proofFile(workspace, job.id), "wx", 0o600);
      try {
        const stat = fs.fstatSync(proofFd, { bigint: true });
        const keys = ["grokPromptState", "grokSessionId", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration",
          "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
        const certificate = { protocol: "darwin-worker-stop-certificate-v1", epoch: indexed.epoch, jobId: job.id,
          claimToken: indexed.claimToken, createdAt: indexed.createdAt, slot: lease.slot, lease, bindingIno,
          file: { dev: String(stat.dev), ino: String(stat.ino) }, indexedSha256: digestRecord(indexed), storedSha256: digestRecord(stored),
          worker: { confirmed: true, proof: "darwin-lease-released", leaseId: lease.id, processStartKey: indexed.processStartKey ?? null },
          turn: Object.fromEntries(keys.map(key => [key, indexed[key] ?? null])) };
        fs.writeFileSync(proofFd, JSON.stringify(certificate));
        fs.fsyncSync(proofFd);
      } finally { fs.closeSync(proofFd); }
    }
    if (mode === "issue") setCursor(workspace, lease.slot);
    const markerPath = path.join(resolveStateDir(workspace), "state.lock", "protocol.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    marker.protocol = "posix-local-v3";
    const fd = fs.openSync(markerPath, "r+");
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, JSON.stringify(marker));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (mode === "issue") {
      try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); } catch { /* 旧 protocol は拒否してよい。 */ }
      assertSameFile(lease.path, lease);
      assert.equal(fs.existsSync(proofFile(workspace, job.id)), false);
    } else {
      assert.throws(() => withStateSnapshot(workspace, (state, context) => {
        const indexed = state.jobs.find(entry => entry.id === job.id);
        const stored = readJobFile(resolveJobFile(workspace, job.id));
        verifyDarwinStopCertificate({ context, indexed, stored });
      }));
      assert.equal(fs.existsSync(proofFile(workspace, job.id)), true);
    }
  });
}

for (const transport of ["none", "direct"]) {
  test(`terminal ${transport} reclaim writes a durable certificate bound to both records and the lease`, darwin, async t => {
    const { workspace, job } = fixture(t, `certificate-${transport}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completed = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completed)[0].type, "completed");
    await worker.closed;
    if (transport === "direct") {
      updateState(workspace, state => {
        const indexed = state.jobs.find(entry => entry.id === job.id);
        const stored = readJobFile(resolveJobFile(workspace, job.id));
        const direct = {
          grokPromptState: "terminal",
          grokTransport: "direct", grokDirectGeneration: "direct-generation", grokDirectOwnerPid: worker.child.pid,
          grokDirectOwnerStartKey: indexed.processStartKey, grokDirectStopGeneration: "direct-generation",
          grokDirectStopKind: "posix-group-empty", grokDirectStopConfirmedAt: "2026-01-01T00:00:00.000Z"
        };
        Object.assign(indexed, direct);
        writeJobFile(workspace, job.id, { ...stored, ...direct });
      });
    }
    const bindingIno = findLedger(workspace).value.slots[lease.slot].bindingIno;
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
    assert.equal(fs.existsSync(lease.path), false);
    const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    const file = proofFile(workspace, job.id);
    const stat = fs.lstatSync(file, { bigint: true });
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1n);
    const certificate = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(certificate.protocol, "darwin-worker-stop-certificate-v1");
    assert.equal(certificate.epoch, indexed.epoch);
    assert.equal(certificate.jobId, job.id);
    assert.equal(certificate.claimToken, indexed.claimToken);
    assert.equal(certificate.createdAt, indexed.createdAt);
    assert.equal(certificate.slot, lease.slot);
    assert.deepEqual(certificate.lease, lease);
    assert.equal(certificate.bindingIno, bindingIno);
    assert.deepEqual(certificate.file, { dev: String(stat.dev), ino: String(stat.ino) });
    assert.equal(certificate.indexedSha256, digestRecord(indexed));
    assert.equal(certificate.storedSha256, digestRecord(stored));
    assert.deepEqual(certificate.worker, { confirmed: true, proof: "darwin-lease-released", leaseId: lease.id,
      processStartKey: indexed.processStartKey ?? null });
    assert.equal(certificate.turn.grokPromptState, indexed.grokPromptState);
    assert.equal(certificate.turn.grokTransport, indexed.grokTransport ?? null);
    if (transport === "direct") {
      assert.equal(certificate.turn.grokDirectGeneration, "direct-generation");
      assert.equal(certificate.turn.grokDirectStopKind, "posix-group-empty");
      assert.equal(certificate.turn.grokDirectStopConfirmedAt, "2026-01-01T00:00:00.000Z");
    }
    const { verifyDarwinStopCertificate, verifyDarwinStopCertificateSnapshot } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    const verified = withStateSnapshot(workspace, (state, context) => verifyDarwinStopCertificate({
      context, indexed: state.jobs.find(entry => entry.id === job.id), stored
    }));
    assert.deepEqual(verified, { path: file, dev: String(stat.dev), ino: String(stat.ino),
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    updateState(workspace, state => { state.config.stopReviewGate = !state.config.stopReviewGate; });
    let expiredContext;
    withStateSnapshot(workspace, (state, context) => {
      const current = state.jobs.find(entry => entry.id === job.id);
      assert.deepEqual(verifyDarwinStopCertificate({ context, indexed: current, stored, expectedCertificate: verified }), verified);
      assert.throws(() => verifyDarwinStopCertificate({ context, indexed: current, stored: { ...stored, rendered: "changed" } }));
      const forged = { ...context, check() {} };
      assert.throws(() => verifyDarwinStopCertificate({ context: forged, indexed: current, stored }));
      assert.throws(() => verifyDarwinStopCertificateSnapshot({ context: forged, indexed: current, stored,
        certificateBytes: fs.readFileSync(file), expectedCertificate: verified }));
      expiredContext = context;
    });
    assert.throws(() => verifyDarwinStopCertificate({ context: expiredContext, indexed, stored }));
    assert.throws(() => verifyDarwinStopCertificateSnapshot({ context: expiredContext, indexed, stored,
      certificateBytes: fs.readFileSync(file), expectedCertificate: verified }));
  });
}

for (const damage of ["missing", "old-epoch", "wrong-claim", "wrong-inode"]) {
  test(`certificate validator rejects ${damage} without deleting history`, darwin, async t => {
    const { workspace, job } = fixture(t, `certificate-${damage}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completed = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completed)[0].type, "completed");
    await worker.closed;
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases, verifyDarwinStopCertificate } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
    const proof = proofFile(workspace, job.id);
    const detailPath = resolveJobFile(workspace, job.id);
    const stored = readJobFile(detailPath);
    if (damage === "missing") fs.renameSync(proof, path.join(workspace, "preserved-proof"));
    else {
      const certificate = JSON.parse(fs.readFileSync(proof, "utf8"));
      if (damage === "old-epoch") certificate.epoch = "00000000-0000-4000-8000-000000000000";
      if (damage === "wrong-claim") certificate.claimToken = "00000000-0000-4000-8000-000000000000";
      if (damage === "wrong-inode") certificate.file.ino = "1";
      fs.writeFileSync(proof, JSON.stringify(certificate), { mode: 0o600 });
    }
    withStateSnapshot(workspace, (state, context) => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      assert.throws(() => verifyDarwinStopCertificate({ context, indexed, stored }));
    });
    assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id));
    assert.equal(fs.existsSync(detailPath), true);
  });
}

test("the fixed certificate snapshot validator checks retained WAL bytes without authorizing missing-file prune", darwin, async t => {
  const { workspace, job } = fixture(t, "certificate-wal-snapshot");
  const worker = await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  const completed = once(worker.child, "message");
  worker.child.send("finish");
  assert.equal((await completed)[0].type, "completed");
  await worker.closed;
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases, verifyDarwinStopCertificate, verifyDarwinStopCertificateSnapshot } =
    await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  const target = proofFile(workspace, job.id);
  const bytes = fs.readFileSync(target);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  let indexed, expected;
  withStateSnapshot(workspace, (state, context) => {
    indexed = state.jobs.find(entry => entry.id === job.id);
    expected = verifyDarwinStopCertificate({ context, indexed, stored });
  });
  fs.renameSync(target, path.join(workspace, "preserved-snapshot-proof"));
  withStateSnapshot(workspace, (_state, context) => {
    assert.throws(() => verifyDarwinStopCertificate({ context, indexed, stored, expectedCertificate: expected }));
    assert.deepEqual(verifyDarwinStopCertificateSnapshot({ context, indexed, stored, certificateBytes: bytes,
      expectedCertificate: expected }), expected);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    assert.throws(() => verifyDarwinStopCertificateSnapshot({ context, indexed, stored, certificateBytes: changed,
      expectedCertificate: expected }));
  });
  // snapshot の照合だけでは prune を許可しない。WAL の durable phase は別途必要。
  assert.ok(loadState(workspace).jobs.some(entry => entry.id === job.id));
  assert.equal(fs.existsSync(resolveJobFile(workspace, job.id)), true);
});

for (const mode of ["kill-before-create", "fail-file-sync", "fail-directory-sync", "kill-after-directory-sync", "kill-after-directory-sync-wrong-binding"]) {
  test(`certificate ${mode} keeps reclaiming ownership until durability is known`, darwin, async t => {
    const { workspace, job } = fixture(t, `certificate-boundary-${mode}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completed = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completed)[0].type, "completed");
    await worker.closed;
    setCursor(workspace, lease.slot);
    const target = proofFile(workspace, job.id);
    const gate = path.join(workspace, "certificate-boundary-gate.cjs");
    const ready = path.join(workspace, "certificate-boundary-ready");
    fs.writeFileSync(gate, String.raw`
      const fs = require("node:fs");
      const path = require("node:path");
      const { syncBuiltinESMExports } = require("node:module");
      const originalOpen = fs.openSync, originalClose = fs.closeSync, originalSync = fs.fsyncSync;
      const names = new Map();
      let gated = false, proofSynced = false;
      function markAndPause() {
        gated = true;
        fs.writeFileSync(process.env.GROK_CERT_READY, "ready", { mode: 0o600 });
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        throw new Error("certificate boundary gate timed out");
      }
      function fail() {
        gated = true;
        fs.writeFileSync(process.env.GROK_CERT_READY, "ready", { mode: 0o600 });
        const error = new Error("injected certificate fsync failure");
        error.code = "EIO";
        throw error;
      }
      fs.openSync = function(name, flags, ...args) {
        if (!gated && typeof name === "string" && path.resolve(name) === process.env.GROK_CERT_TARGET
            && process.env.GROK_CERT_MODE === "kill-before-create"
            && ((typeof flags === "number" && (flags & fs.constants.O_CREAT)) || (typeof flags === "string" && flags.includes("w")))) {
          markAndPause();
        }
        const fd = originalOpen.call(this, name, flags, ...args);
        if (typeof name === "string") names.set(fd, path.resolve(name));
        return fd;
      };
      fs.closeSync = function(fd) {
        try { return originalClose.call(this, fd); } finally { names.delete(fd); }
      };
      fs.fsyncSync = function(fd) {
        const name = names.get(fd);
        if (!gated && name === process.env.GROK_CERT_TARGET) {
          if (process.env.GROK_CERT_MODE === "fail-file-sync") fail();
          const result = originalSync.call(this, fd);
          proofSynced = true;
          return result;
        }
        if (!gated && proofSynced && name === path.dirname(process.env.GROK_CERT_TARGET)) {
          if (process.env.GROK_CERT_MODE === "fail-directory-sync") fail();
          const result = originalSync.call(this, fd);
          if (process.env.GROK_CERT_MODE.startsWith("kill-after-directory-sync")) markAndPause();
          return result;
        }
        return originalSync.call(this, fd);
      };
      syncBuiltinESMExports();
    `, { mode: 0o600 });
    const child = fork(new URL("./fixtures/darwin-sweep-observer.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: ["--require", gate],
      env: { ...process.env, GROK_CERT_TARGET: target, GROK_CERT_READY: ready, GROK_CERT_MODE: mode }
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    const response = once(child, "message");
    child.send({ workspace, iterations: 1 });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(ready), "certificate boundary was not reached");
    if (mode.startsWith("kill")) {
      child.kill("SIGKILL");
      await closed;
    } else {
      const [result] = await response;
      assert.ok(["rejected", "uncertain"].includes(result.type), JSON.stringify(result));
      await closed;
    }
    assertSameFile(lease.path, lease);
    assert.equal(fs.existsSync(lease.path.replace(/\.lease$/, ".binding")), true);
    assert.equal(findLedger(workspace).value.slots[lease.slot].state, "reclaiming");
    const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    assert.equal(indexed.workerLease, null);
    assert.equal(stored.workerLease, null);
    if (mode === "kill-before-create") assert.equal(fs.existsSync(target), false);
    if (mode === "kill-after-directory-sync") {
      const before = fs.lstatSync(target, { bigint: true });
      setCursor(workspace, lease.slot);
      const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
      await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
      assert.equal(fs.existsSync(lease.path), false);
      assert.equal(findLedger(workspace).value.slots[lease.slot].state, "free");
      assertSameFile(target, { dev: String(before.dev), ino: String(before.ino) });
    }
    if (mode === "kill-after-directory-sync-wrong-binding") {
      const proof = JSON.parse(fs.readFileSync(target, "utf8"));
      const bindingIno = findLedger(workspace).value.slots[lease.slot].bindingIno;
      proof.bindingIno = bindingIno === "1" ? "2" : "1";
      fs.writeFileSync(target, JSON.stringify(proof), { mode: 0o600 });
      setCursor(workspace, lease.slot);
      const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
      try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); } catch { /* 不一致は拒否してよい。 */ }
      assertSameFile(lease.path, lease);
      assert.equal(fs.existsSync(lease.path.replace(/\.lease$/, ".binding")), true);
      assert.equal(findLedger(workspace).value.slots[lease.slot].state, "reclaiming");
    }
  });
}

for (const kind of ["proof", "lease-id", "start-key", "unconfirmed-residual"]) {
  test(`matching but invalid existing worker stop ${kind} is preserved`, darwin, async t => {
    const { workspace, job } = fixture(t, `terminal-invalid-stop-${kind}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completed = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completed)[0].type, "completed");
    await worker.closed;
    updateState(workspace, state => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(workspace, job.id));
      const evidence = {
        workerStopConfirmed: true, workerStopProof: "darwin-lease-released", workerStopLeaseId: lease.id,
        workerStopProcessStartKey: indexed.processStartKey ?? null
      };
      if (kind === "proof") evidence.workerStopProof = "process-exited";
      if (kind === "lease-id") evidence.workerStopLeaseId = "00000000-0000-4000-8000-000000000000";
      if (kind === "start-key") evidence.workerStopProcessStartKey = "different";
      if (kind === "unconfirmed-residual") evidence.workerStopConfirmed = false;
      Object.assign(indexed, evidence);
      writeJobFile(workspace, job.id, { ...stored, ...evidence });
    });
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
    catch { /* 既存停止証拠が矛盾すれば拒否してよい。 */ }
    assertSameFile(lease.path, lease);
    assert.deepEqual(recordedLease(workspace, job.id), lease);
  });
}

test("matching valid existing worker stop proof permits terminal reclaim", darwin, async t => {
  const { workspace, job } = fixture(t, "terminal-valid-existing-stop");
  const worker = await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  const completed = once(worker.child, "message");
  worker.child.send("finish");
  assert.equal((await completed)[0].type, "completed");
  await worker.closed;
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    const evidence = {
      workerStopConfirmed: true, workerStopProof: "darwin-lease-released", workerStopLeaseId: lease.id,
      workerStopProcessStartKey: indexed.processStartKey ?? null
    };
    Object.assign(indexed, evidence);
    writeJobFile(workspace, job.id, { ...stored, ...evidence });
  });
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
  assert.equal(fs.existsSync(lease.path), false);
  const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(indexed.workerStopProof, "darwin-lease-released");
  assert.equal(stored.workerStopProof, "darwin-lease-released");
  assert.equal(indexed.workerStopLeaseId, lease.id);
  assert.equal(stored.workerStopLeaseId, lease.id);
});

for (const [name, evidence] of [
  ["session", { grokSessionId: "unexpected-session" }],
  ["broker transport", { grokTransport: "broker", grokBrokerGeneration: "unexpected-generation" }],
  ["direct transport", { grokTransport: "direct" }]
]) {
  test(`not-sent terminal records with ${name} do not authorize a stop certificate`, darwin, async t => {
    const { workspace, job } = fixture(t, `not-sent-contradiction-${name.replaceAll(" ", "-")}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completion = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completion)[0].type, "completed");
    await worker.closed;
    updateState(workspace, state => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(workspace, job.id));
      const patch = { grokPromptState: "not-sent", ...evidence };
      Object.assign(indexed, patch);
      writeJobFile(workspace, job.id, { ...stored, ...patch });
    });
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); } catch { /* 矛盾した証拠は拒否してよい。 */ }
    assertSameFile(lease.path, lease);
    assert.deepEqual(recordedLease(workspace, job.id), lease);
    assert.equal(fs.existsSync(proofFile(workspace, job.id)), false);
  });
}

test("direct terminal records with no generation or stop proof do not authorize reclaim", darwin, async t => {
  const { workspace, job } = fixture(t, "direct-terminal-no-evidence");
  const worker = await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  // 通常の direct 起動では generation を spawn 前に保存する。ここでは
  // 両 record の証拠が欠落した不明状態を注入し、worker 死亡だけで回収しない。
  const patch = {
    status: "failed", phase: "failed", pid: null, terminationPending: false,
    grokPromptState: "terminal", grokTransport: "direct", grokSessionId: "unconfirmed-direct-session",
    grokDirectGeneration: null, grokDirectOwnerPid: null, grokDirectOwnerStartKey: null,
    grokDirectStopGeneration: null, grokDirectStopKind: null, grokDirectStopConfirmedAt: null
  };
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    Object.assign(indexed, patch);
    writeJobFile(workspace, job.id, { ...stored, ...patch });
  });
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
  catch { /* 証拠が不明な record の拒否も安全な結果。 */ }
  assertSameFile(lease.path, lease);
  assert.deepEqual(recordedLease(workspace, job.id), lease);
  assert.equal(findLedger(workspace).value.slots[lease.slot].state, "published");
});

test("a Windows job-empty proof cannot establish Darwin direct agent stop", darwin, async t => {
  const { workspace, job } = fixture(t, "direct-windows-stop-proof");
  const worker = await startWorker(t, job);
  const lease = recordedLease(workspace, job.id);
  worker.child.kill("SIGKILL");
  await worker.closed;
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    const evidence = {
      status: "failed", phase: "failed", pid: null, terminationPending: false, grokPromptState: "terminal",
      grokTransport: "direct", grokDirectGeneration: "direct-generation", grokDirectOwnerPid: worker.child.pid,
      grokDirectOwnerStartKey: indexed.processStartKey, grokDirectStopGeneration: "direct-generation",
      grokDirectStopKind: "job-empty", grokDirectStopConfirmedAt: "2026-01-01T00:00:00.000Z"
    };
    Object.assign(indexed, evidence);
    writeJobFile(workspace, job.id, { ...stored, ...evidence });
  });
  setCursor(workspace, lease.slot);
  const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
  try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
  catch { /* 対象 OS にない停止証拠は拒否してよい。 */ }
  assertSameFile(lease.path, lease);
  assert.deepEqual(recordedLease(workspace, job.id), lease);
});

for (const field of ["pid", "processStartKey", "startedAt", "phase", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt",
  "workerStopConfirmed", "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey", "completedAt"]) {
  test(`terminal ${field} disagreement preserves the lease`, darwin, async t => {
    const { workspace, job } = fixture(t, `terminal-mismatch-${field}`);
    const worker = await startWorker(t, job);
    const lease = recordedLease(workspace, job.id);
    const completion = once(worker.child, "message");
    worker.child.send("finish");
    assert.equal((await completion)[0].type, "completed");
    await worker.closed;
    updateState(workspace, state => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(workspace, job.id));
      const evidence = {
        grokTransport: "direct", grokDirectGeneration: "direct-generation", grokDirectOwnerPid: worker.child.pid,
        grokDirectOwnerStartKey: indexed.processStartKey, grokDirectStopGeneration: "direct-generation",
        grokDirectStopKind: "posix-group-empty", grokDirectStopConfirmedAt: "2026-01-01T00:00:00.000Z"
      };
      Object.assign(indexed, evidence);
      const inconsistent = { ...stored, ...evidence, [field]: field === "pid" ? 1 : field === "workerStopConfirmed" ? true : "different" };
      writeJobFile(workspace, job.id, inconsistent);
    });
    setCursor(workspace, lease.slot);
    const { sweepDarwinWorkerLeases } = await import("../plugins/grok/scripts/lib/darwin-lease-sweep.mjs");
    try { await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }); }
    catch { /* record の矛盾は拒否してよい。 */ }
    assertSameFile(lease.path, lease);
    assert.equal(fs.existsSync(resolveJobFile(workspace, job.id)), true);
  });
}
