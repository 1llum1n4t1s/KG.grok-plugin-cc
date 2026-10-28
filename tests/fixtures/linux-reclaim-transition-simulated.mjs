import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspectLinuxReclaimFixedTransition } from "../../plugins/grok/scripts/lib/linux-reclaim-journal.mjs";

// 実 CLI が保存した index/detail と 256 slot ledger を使う。
// この検査結果は真正 mutex、flock、durability の capability ではない。
const [stateDir, jobId] = process.argv.slice(2);
const oldState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
const oldDetail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
const oldIndex = oldState.jobs.find(job => job.id === jobId);
assert.ok(oldIndex?.workerLease);
const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(oldIndex.workerLease.path), "ledger.json"), "utf8"));
assert.equal(ledger.slots.length, 256);
assert.equal(ledger.slots[oldIndex.workerLease.slot].state, "published");
assert.equal(oldIndex.grokDirectStopKind, "posix-group-empty");
assert.ok(oldIndex.grokDirectStopConfirmedAt && oldIndex.claimToken && oldIndex.createdAt && oldIndex.epoch);
const proof = { workerStopConfirmed: true, workerStopProof: "linux-lease-released",
  workerStopLeaseId: oldIndex.workerLease.id, workerStopProcessStartKey: oldIndex.processStartKey ?? null, workerLease: null };
const newState = structuredClone(oldState), nextIndex = newState.jobs.find(job => job.id === jobId);
Object.assign(nextIndex, proof);
const newDetail = { ...oldDetail, ...proof };
const input = { oldState, oldDetail, newState, newDetail, ledger, epoch: oldIndex.epoch, slot: oldIndex.workerLease.slot };
assert.equal(inspectLinuxReclaimFixedTransition(input), true);
for (const change of [
  x => { x.oldDetail.claimToken = "bad"; },
  x => { x.oldDetail.grokDirectStopConfirmedAt = null; },
  x => { x.oldDetail.grokDirectStopGeneration = "other"; },
  x => { x.oldDetail.terminationPending = true; },
  x => { x.newDetail.workerStopLeaseId = "other"; },
  x => { x.newDetail.title = "changed outside the fixed patch"; },
  x => { x.newDetail.extra = true; },
  x => { x.newState.jobs.find(job => job.id === jobId).workerStopConfirmed = false; },
  x => { x.newState.jobs.push({ id: "unrelated" }); },
  x => { x.newState.config.unrelated = true; },
  x => { x.ledger.slots[x.slot].claimToken = "other"; },
  x => { x.ledger.slots[x.slot].lease.id = "other"; },
  x => { x.ledger.slots[(x.slot + 1) % 256].extra = true; },
  x => { x.epoch = "11111111-1111-4111-8111-111111111111"; }
]) {
  const changed = structuredClone(input); change(changed);
  assert.throws(() => inspectLinuxReclaimFixedTransition(changed));
}
process.stdout.write("complete transition verified\n");
