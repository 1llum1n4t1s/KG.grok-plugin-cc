import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { updateState, withStateSnapshot, writeJobFile } from "../../plugins/grok/scripts/lib/state.mjs";
import { assertLinuxHistoryUnreferenced, filterLinuxHistoryUnreferenced, publishLinuxLeaseSlot, reserveLinuxLeaseSlot } from "../../plugins/grok/scripts/lib/linux-lease-ledger.mjs";
import { releaseLinuxWorkerLease } from "../../plugins/grok/scripts/lib/linux-worker-lease.mjs";

const spawn = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  const result = spawn.call(this, command, args, options);
  if (command === "/usr/bin/flock" && result.status === 75) result.status = 1;
  return result;
};
syncBuiltinESMExports();
const workspace = process.argv[2], root = process.env.GROK_LINUX_SIM_ROOT;
const jobId = "ledger-owner", claimToken = randomUUID(), createdAt = new Date().toISOString();
const unrelated = { jobId: "history-other", claimToken: randomUUID(), workerStopLeaseId: randomUUID() };
let owned, queued, expired;
withStateSnapshot(workspace, (_state, context) => {
  expired = context;
  assert.equal(assertLinuxHistoryUnreferenced({ context, ...unrelated }), true);
  assert.throws(() => assertLinuxHistoryUnreferenced({ context: { ...context, check() {} }, ...unrelated }));
  assert.throws(() => filterLinuxHistoryUnreferenced({ context: { ...context, check() {} }, candidates: [unrelated] }));
  let invoked = false;
  const forged = { context: { ...context, check() {} }, get candidates() { invoked = true; return [unrelated]; } };
  assert.throws(() => filterLinuxHistoryUnreferenced(forged));
  assert.equal(invoked, false, "fake capability must be rejected before reading candidate accessors");
  const accessorCandidate = { jobId: "accessor", get claimToken() { invoked = true; return unrelated.claimToken; }, workerStopLeaseId: unrelated.workerStopLeaseId };
  assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates: [accessorCandidate] }));
  assert.equal(invoked, false, "candidate accessors must not be executed");
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, workerStopLeaseId: "invalid" }));
  assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates: [unrelated, unrelated] }));
  const maximum = Array.from({ length: 4096 }, (_, i) => ({ ...unrelated, jobId: `candidate-${i}` }));
  assert.equal(filterLinuxHistoryUnreferenced({ context, candidates: maximum }).size, 4096);
  assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates: [...maximum, { ...unrelated, jobId: "overflow" }] }));
  queued = { id: jobId, createdAt, epoch: context.epoch, claimToken, status: "queued", phase: "queued",
    pid: null, processStartKey: null, grokPromptState: "not-sent", logFile: null };
  owned = reserveLinuxLeaseSlot({ context, jobId, claimToken, createdAt, queuedRecord: queued });
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, jobId }));
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, claimToken }));
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, workerStopLeaseId: owned.lease.id }));
  assert.equal(assertLinuxHistoryUnreferenced({ context, ...unrelated }), true);
  const candidates = [unrelated, { ...unrelated, jobId }, { ...unrelated, jobId: "same-claim", claimToken },
    { ...unrelated, jobId: "same-lease", workerStopLeaseId: owned.lease.id }];
  assert.deepEqual([...filterLinuxHistoryUnreferenced({ context, candidates })], [unrelated.jobId]);
  const held = path.join(root, "lease-held");
  fs.renameSync(owned.lease.path, held);
  try {
    assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated }));
    assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates }));
  }
  finally { fs.renameSync(held, owned.lease.path); }
});
assert.throws(() => assertLinuxHistoryUnreferenced({ context: expired, ...unrelated }));
assert.throws(() => filterLinuxHistoryUnreferenced({ context: expired, candidates: [unrelated] }));
const record = { ...queued, workerLease: owned.lease };
updateState(workspace, state => {
  writeJobFile(workspace, jobId, record);
  state.jobs.push(record);
}, { afterSave(_state, context) {
  publishLinuxLeaseSlot({ context, jobId, claimToken, lease: owned.lease, owner: owned.owner });
} });
withStateSnapshot(workspace, (_state, context) => {
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, jobId }));
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, claimToken }));
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, workerStopLeaseId: owned.lease.id }));
  assert.equal(assertLinuxHistoryUnreferenced({ context, ...unrelated }), true);
  assert.deepEqual([...filterLinuxHistoryUnreferenced({ context, candidates: [unrelated,
    { ...unrelated, jobId: "same-published-claim", claimToken }] })], [unrelated.jobId]);
  const ledgerPath = path.join(path.dirname(owned.lease.path), "ledger.json");
  const original = fs.readFileSync(ledgerPath);
  const ledger = JSON.parse(original);
  ledger.slots[owned.lease.slot] = { ...ledger.slots[owned.lease.slot], state: "reclaiming", reclaimKind: "terminal" };
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
  try {
    assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated, workerStopLeaseId: owned.lease.id }));
    assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates: [unrelated] }));
  }
  finally { fs.writeFileSync(ledgerPath, original); }
});
releaseLinuxWorkerLease(owned.owner);
withStateSnapshot(workspace, (_state, context) => {
  const stray = path.join(path.dirname(owned.lease.path), "slot-255.lease");
  fs.writeFileSync(stray, "unknown", { flag: "wx", mode: 0o600 });
  try {
    assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated }));
    assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates: [unrelated] }));
  }
  finally { fs.renameSync(stray, path.join(root, "stray-held")); }
  const claim = randomUUID(), date = new Date().toISOString(), id = "unbound-slot";
  const q = { id, claimToken: claim, createdAt: date, epoch: context.epoch, status: "queued", phase: "queued", grokPromptState: "not-sent" };
  const open = fs.openSync;
  fs.openSync = function (target, ...args) {
    if (typeof target === "string" && /\/slot-\d{3}\.lease$/.test(target) && (args[0] & fs.constants.O_CREAT)) throw new Error("fixture unbound reservation");
    return open.call(this, target, ...args);
  };
  try { assert.throws(() => reserveLinuxLeaseSlot({ context, jobId: id, claimToken: claim, createdAt: date, queuedRecord: q })); }
  finally { fs.openSync = open; }
  assert.throws(() => assertLinuxHistoryUnreferenced({ context, ...unrelated }));
  assert.throws(() => filterLinuxHistoryUnreferenced({ context, candidates: [unrelated] }));
});
process.stdout.write("history ledger checks passed\n");
