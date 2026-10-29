import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";

// preload の lockf 競合終了値を Linux flock の競合終了値へ変換する。
const spawn = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  const result = spawn.call(this, command, args, options);
  if (command === "/usr/bin/flock" && result.status === 75) result.status = 1;
  return result;
};
syncBuiltinESMExports();
const { initializeLinuxLeaseLedger, reserveLinuxLeaseSlot, publishLinuxLeaseSlot,
  verifyPublishedLinuxLease, verifyPublishedLinuxLeaseRecords, getProtectedLinuxJobIds } = await import("../../plugins/grok/scripts/lib/linux-lease-ledger.mjs");
const { releaseLinuxWorkerLease, withAvailableLinuxLease } = await import("../../plugins/grok/scripts/lib/linux-worker-lease.mjs");

const stateDir = process.env.GROK_LINUX_SIM_STATE_DIR;
const epoch = process.env.GROK_LEDGER_TEST_EPOCH || randomUUID();
const mode = process.env.GROK_LEDGER_TEST_MODE;
const namespace = path.join(stateDir, "worker-leases-v1");
const epochDir = path.join(namespace, epoch);
if (!mode?.startsWith("verify-crash")) {
  fs.mkdirSync(namespace, { mode: 0o700 });
  fs.mkdirSync(epochDir, { mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, "jobs"), { mode: 0o700 });
}
const identity = p => {
  const stat = fs.lstatSync(p, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
};
const rootFd = fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const context = { stateDir, rootFd, directoryIdentity: identity(stateDir),
  expectedDirectoryIdentity: identity(epochDir), epoch, protocol: "posix-linux-worker-lease-v6", check() {} };
const writeRecords = (index, detail) => {
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ jobs: index ? [index] : [] })}\n`, { mode: 0o600 });
  if (detail) fs.writeFileSync(path.join(stateDir, "jobs", `${detail.id}.json`), `${JSON.stringify(detail)}\n`, { mode: 0o600 });
};
const jobId = "ledger-job";
const claimToken = randomUUID();
const createdAt = new Date().toISOString();
const reserve = (id, claim, date, extra = {}) => reserveLinuxLeaseSlot({ context, jobId: id, claimToken: claim, createdAt: date,
  queuedRecord: { id, claimToken: claim, createdAt: date, epoch, status: "queued", phase: "queued", grokPromptState: "not-sent", ...extra } });
if (mode === "verify-crash-reserved") {
  assert.ok(getProtectedLinuxJobIds({ context }).has(jobId));
  assert.throws(() => reserve(jobId, claimToken, createdAt));
  fs.closeSync(rootFd);
  process.stdout.write("crash preserved\n");
  process.exit(0);
}
if (mode === "verify-crash-published") {
  const indexed = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0];
  const stored = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
  assert.throws(() => verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease }));
  let protectedIds;
  try { protectedIds = getProtectedLinuxJobIds({ context }); }
  catch { /* 不完全な prepared が namespace 全体を保留するのも安全。 */ }
  if (protectedIds) assert.ok(protectedIds.has(jobId));
  fs.closeSync(rootFd);
  process.stdout.write("publication crash preserved\n");
  process.exit(0);
}
if (mode === "verify-crash-bound") {
  assert.throws(() => getProtectedLinuxJobIds({ context }), "unconfirmed prepared ledger must be retained");
  assert.ok(fs.existsSync(path.join(epochDir, "slot-000.lease")));
  assert.ok(fs.existsSync(path.join(epochDir, "slot-000.binding")));
  fs.closeSync(rootFd);
  process.stdout.write("bound crash preserved\n");
  process.exit(0);
}
if (mode === "verify-crash-reserved-complete") {
  assert.ok(getProtectedLinuxJobIds({ context }).has(jobId));
  assert.ok(fs.existsSync(path.join(epochDir, "slot-000.lease")));
  assert.ok(fs.existsSync(path.join(epochDir, "slot-000.binding")));
  fs.closeSync(rootFd);
  process.stdout.write("completed reservation preserved\n");
  process.exit(0);
}
assert.throws(() => initializeLinuxLeaseLedger({ context: { ...context, protocol: "posix-linux-worker-lease-v4" } }));
assert.throws(() => initializeLinuxLeaseLedger({ context: { ...context, protocol: "posix-linux-worker-lease-v5" } }));
assert.equal(fs.existsSync(path.join(epochDir, "ledger.json")), false);
initializeLinuxLeaseLedger({ context });
writeRecords(null, null);
if (mode === "pending-bytes") {
  const padding = "x".repeat(34 * 1024 * 1024);
  const first = reserve("pending-first", randomUUID(), createdAt, { padding });
  const before = fs.readFileSync(path.join(epochDir, "ledger.json"));
  const names = fs.readdirSync(epochDir).sort();
  assert.throws(() => reserve("pending-second", randomUUID(), createdAt, { padding }));
  assert.deepEqual(fs.readFileSync(path.join(epochDir, "ledger.json")), before);
  assert.deepEqual(fs.readdirSync(epochDir).sort(), names);
  releaseLinuxWorkerLease(first.owner);
  fs.closeSync(rootFd);
  process.stdout.write("pending bytes preserved\n");
  process.exit(0);
}
if (mode === "occupied-capacity") {
  const index = [], owners = [];
  for (let i = 0; i < 248; i++) {
    const id = `occupied-${i}`, claim = randomUUID(), date = new Date().toISOString();
    const logFile = path.join(stateDir, "jobs", `${id}.log`);
    const acquired = reserve(id, claim, date, { logFile });
    owners.push(acquired.owner);
    const item = { id, createdAt: date, status: "queued", phase: "queued", grokPromptState: "not-sent",
      epoch, claimToken: claim, workerLease: acquired.lease, logFile };
    index.push(item);
    fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ jobs: index })}\n`);
    fs.writeFileSync(path.join(stateDir, "jobs", `${id}.json`), `${JSON.stringify(item)}\n`, { mode: 0o600 });
    fs.writeFileSync(logFile, "", { mode: 0o600 });
    publishLinuxLeaseSlot({ context, jobId: id, claimToken: claim, lease: acquired.lease, owner: acquired.owner });
  }
  for (let i = 0; i < 3104; i++) fs.writeFileSync(path.join(stateDir, "jobs", `extra-${i}.log`), "", { flag: "wx", mode: 0o600 });
  assert.equal(fs.readdirSync(path.join(stateDir, "jobs")).length, 3600);
  const extra = reserve(jobId, claimToken, createdAt);
  releaseLinuxWorkerLease(extra.owner);
  for (const owner of owners) releaseLinuxWorkerLease(owner);
  fs.closeSync(rootFd);
  process.stdout.write("existing records counted once\n");
  process.exit(0);
}
if (mode === "index-capacity" || mode === "index-bytes-capacity" || mode === "jobs-capacity" || mode === "jobs-temp-budget" || mode === "bytes-capacity" || mode === "control-capacity" || mode === "staging-capacity") {
  if (mode === "index-capacity") {
    fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ jobs: Array.from({ length: 4096 }, (_, i) => ({ id: `history-${i}` })) })}\n`);
  } else if (mode === "index-bytes-capacity") {
    const prefix = '{"version":1,"config":{"padding":"', suffix = '"},"jobs":[],"reviewGateSessions":[]}\n';
    const length = 64 * 1024 * 1024 - 8192;
    fs.writeFileSync(path.join(stateDir, "state.json"), `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`);
  } else if (mode === "jobs-capacity" || mode === "jobs-temp-budget") {
    const count = mode === "jobs-capacity" ? 4096 : 4094;
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(stateDir, "jobs", `history-${i}.log`), "", { flag: "wx", mode: 0o600 });
  } else {
    fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ jobs: [{ id: "near-limit", status: "completed" }] })}\n`);
    const prefix = '{"id":"near-limit","status":"completed","padding":"', suffix = '"}\n';
    const margin = mode === "bytes-capacity" ? 128 : mode === "control-capacity" ? 8192 : 18 * 1024;
    const length = 64 * 1024 * 1024 - margin;
    fs.writeFileSync(path.join(stateDir, "jobs", "near-limit.json"), `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`, { flag: "wx", mode: 0o600 });
  }
  const ledgerFile = path.join(epochDir, "ledger.json");
  const before = fs.readFileSync(ledgerFile);
  const entries = fs.readdirSync(epochDir).sort();
  assert.throws(() => reserve(jobId, claimToken, createdAt));
  assert.deepEqual(fs.readFileSync(ledgerFile), before, "rejected reservation must not change ledger");
  assert.deepEqual(fs.readdirSync(epochDir).sort(), entries, "rejected reservation must not create lease or binding");
  fs.closeSync(rootFd);
  process.stdout.write("capacity rejected without side effects\n");
  process.exit(0);
}
if (mode === "crash-reserved") {
  const open = fs.openSync;
  fs.openSync = function (target, ...args) {
    if (typeof target === "string" && /\/slot-\d{3}\.lease$/.test(target)
        && (args[0] & fs.constants.O_CREAT)) process.exit(71);
    return open.call(this, target, ...args);
  };
}
if (mode === "crash-bound") {
  const rename = fs.renameSync;
  let publications = 0;
  fs.renameSync = function (...args) {
    if (String(args[0]).endsWith(".prepared") && ++publications === 2) process.exit(74);
    return rename.apply(this, args);
  };
}
const reservation = reserve(jobId, claimToken, createdAt);
if (mode === "crash-reserved-complete") process.exit(75);
assert.equal(reservation.claimToken, claimToken);
assert.equal(reservation.createdAt, createdAt);
assert.equal(Object.hasOwn(reservation, "fd"), false);
assert.ok(getProtectedLinuxJobIds({ context }).has(jobId));
const record = { id: jobId, status: "queued", workerLease: reservation.lease, claimToken, epoch, createdAt,
  grokPromptState: "not-sent" };
const publish = () => publishLinuxLeaseSlot({ context, jobId, claimToken, lease: reservation.lease, owner: reservation.owner });
writeRecords(record, null);
assert.throws(publish);
writeRecords(record, { ...record, claimToken: randomUUID() });
assert.throws(publish);
writeRecords(record, { ...record, epoch: randomUUID() });
assert.throws(publish);
writeRecords(record, record);
if (mode === "crash-published") {
  const rename = fs.renameSync;
  fs.renameSync = function (...args) {
    if (String(args[0]).endsWith(".prepared")) process.exit(72);
    return rename.apply(this, args);
  };
}
publish();
assert.equal(verifyPublishedLinuxLease({ context, indexed: record, stored: record,
  owner: reservation.owner, lease: reservation.lease, claimToken }), true);
assert.equal(verifyPublishedLinuxLeaseRecords({ context, indexed: record, stored: record, lease: reservation.lease }), true);
const stateFile = path.join(stateDir, "state.json");
const originalState = fs.readFileSync(stateFile);
try {
  for (const tail of [null, { ...record }]) {
    const malformed = Buffer.from(`${JSON.stringify({ jobs: [record, tail] })}\n`);
    fs.writeFileSync(stateFile, malformed, { mode: 0o600 });
    assert.throws(() => verifyPublishedLinuxLeaseRecords({ context, indexed: record, stored: record, lease: reservation.lease }), /invalid job IDs/);
    assert.deepEqual(fs.readFileSync(stateFile), malformed);
    assert.equal(fs.existsSync(reservation.lease.path), true);
  }
} finally { fs.writeFileSync(stateFile, originalState, { mode: 0o600 }); }
const bindingPath = reservation.lease.path.replace(/\.lease$/, ".binding");
const binding = fs.readFileSync(bindingPath);
const changedBinding = JSON.parse(binding);
changedBinding.claimToken = randomUUID();
fs.writeFileSync(bindingPath, JSON.stringify(changedBinding));
assert.throws(() => verifyPublishedLinuxLeaseRecords({ context, indexed: record, stored: record, lease: reservation.lease }));
fs.writeFileSync(bindingPath, binding);
const readFile = fs.readFileSync;
fs.readFileSync = function (target, ...args) {
  if (typeof target === "string" && /^\/proc\/self\/fdinfo\/\d+$/.test(target)
      && target !== `/proc/self/fdinfo/${rootFd}`) return "mnt_id:\t42\n";
  return readFile.call(this, target, ...args);
};
try {
  assert.throws(() => verifyPublishedLinuxLeaseRecords({ context, indexed: record, stored: record, lease: reservation.lease }),
    "a different mount ID must be rejected");
} finally { fs.readFileSync = readFile; }
let commits = 0;
assert.deepEqual(withAvailableLinuxLease(reservation.lease, context, () => { commits++; }), { status: "unknown" });
assert.equal(commits, 0, "live owner must prevent an observer commit");
assert.throws(() => verifyPublishedLinuxLease({ context, indexed: record, stored: record,
  owner: {}, lease: reservation.lease, claimToken }));
assert.throws(() => reserve(jobId, randomUUID(), createdAt));
releaseLinuxWorkerLease(reservation.owner);
const observed = withAvailableLinuxLease(reservation.lease, context, () => {
  commits++;
  const competing = withAvailableLinuxLease(reservation.lease, context, () => { commits++; });
  assert.deepEqual(competing, { status: "unknown" }, "observer must keep its lock throughout commit");
  return true;
});
assert.deepEqual(observed, { status: "available", value: true });
assert.equal(commits, 1);
fs.closeSync(rootFd);
process.stdout.write("ledger scenarios passed\n");
