import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateLinuxReclaimJournal } from "../plugins/grok/scripts/lib/linux-reclaim-journal.mjs";

// 故障条件: 無関係・不完全・重複 inode の記録を回収 intent と誤認する、
// phase や nested transaction を取り違える、画像サイズを無制限に受理する、
// getter を実行する。実際の filesystem・mutex・flock は別の E2E で検証する。
const epoch = "11111111-1111-4111-8111-111111111111";
const txid = "22222222-2222-4222-8222-222222222222";
const claim = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const nested = "55555555-5555-4555-8555-555555555555";
const preDetail = { id: "task-valid", status: "completed", workerLease: { id: leaseId } };
const postDetail = { ...preDetail, workerLease: null, workerStopConfirmed: true,
  workerStopProof: "linux-lease-released", workerStopLeaseId: leaseId, workerStopProcessStartKey: null };
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const image = (name, ino, data) => ({ name, dev: "123", ino: String(ino), size: String(data.length),
  sha256: createHash("sha256").update(data).digest("hex") });
const ledgerImage = (ino, content) => ({ dev: "123", ino: String(ino), size: String(content.length),
  sha256: createHash("sha256").update(content).digest("hex") });
const nestedTx = (operation, state) => ({ id: nested, outerTxid: txid, operation, state,
  oldLedger: ledgerImage(80, bytes({ cursor: 0 })), newLedger: ledgerImage(81, bytes({ cursor: 1 })) });
const sample = () => ({
  protocol: "linux-reclaim-journal-v1", epoch, txid, phase: "prepared", slot: 7,
  jobId: "task-valid", claimToken: claim, createdAt: "2026-01-01T00:00:00.000Z", reclaimKind: "terminal",
  lease: { id: leaseId, path: "/state/worker-leases-v1/11111111-1111-4111-8111-111111111111/slot-007.lease",
    dev: "123", ino: "20", stateGeneration: epoch, slot: 7 },
  binding: { dev: "123", ino: "21" },
  oldIndex: { ...image("index.pre", 30, bytes({ jobs: [preDetail] })), source: { dev: "123", ino: "40" } },
  postIndex: { ...image("index.post", 31, bytes({ jobs: [postDetail] })), target: { dev: "123", ino: "31" } },
  oldDetail: { ...image("detail.pre", 32, bytes(preDetail)), source: { dev: "123", ino: "41" } },
  postDetail: { ...image("detail.post", 33, bytes(postDetail)), target: { dev: "123", ino: "33" } },
  ledgerTx: null
});

test("Linux reclaim journal schema rejects malformed transaction evidence", () => {
  assert.notEqual(sample().oldIndex.sha256, sample().postIndex.sha256);
  assert.notEqual(sample().oldDetail.sha256, sample().postDetail.sha256);
  for (const phase of ["prepared", "detail", "records", "unlink-ready", "lease-unlinked", "binding-unlinked", "free"]) {
    const value = sample(); value.phase = phase;
    if (phase !== "prepared") value.ledgerTx = nestedTx(phase === "free" ? "free" : "reclaiming", "complete");
    const validated = validateLinuxReclaimJournal(value);
    assert.ok(Object.isFrozen(validated));
    assert.ok(Object.isFrozen(validated.oldIndex.source));
    assert.notEqual(validated, value);
  }
  const cases = [
    x => { x.extra = true; }, x => { delete x.epoch; }, x => { x.protocol = "linux-reclaim-journal-v0"; },
    x => { x.epoch = "not-an-epoch"; }, x => { x.ledgerTx = nestedTx("reclaiming", "prepared"); x.txid = claim; },
    x => { x.claimToken = "bad"; }, x => { x.jobId = "../invalid"; }, x => { x.slot = 256; },
    x => { x.lease.slot = 8; }, x => { x.lease.stateGeneration = claim; },
    x => { x.lease.path = "/state/worker-leases-v1/other/slot-007.lease"; },
    x => { x.phase = "unknown"; }, x => { x.reclaimKind = "reserved"; },
    x => { x.ledgerTx = nestedTx("reclaiming", "prepared"); x.ledgerTx.outerTxid = claim; },
    x => { x.ledgerTx = nestedTx("reclaiming", "prepared"); x.ledgerTx.id = x.txid; },
    x => { x.ledgerTx = nestedTx("free", "prepared"); },
    x => { x.phase = "detail"; },
    x => { x.phase = "free"; x.ledgerTx = nestedTx("reclaiming", "complete"); },
    x => { x.ledgerTx = nestedTx("reclaiming", "prepared"); x.ledgerTx.newLedger.ino = x.ledgerTx.oldLedger.ino; },
    x => { x.ledgerTx = nestedTx("reclaiming", "unknown"); },
    x => { x.oldIndex.size = "67108865"; }, x => { x.oldIndex.size = "010"; },
    x => { x.oldIndex.ino = "0"; }, x => { x.oldIndex.sha256 = "A".repeat(64); },
    x => { x.oldIndex.name = "../index.pre"; }, x => { x.postDetail.ino = x.oldDetail.ino; },
    x => { delete x.oldIndex.source; }, x => { x.oldIndex.source.ino = x.oldIndex.ino; },
    x => { x.oldDetail.source.ino = x.oldIndex.source.ino; }, x => { x.oldIndex.source.dev = "124"; },
    x => { x.oldIndex.source.ino = x.lease.ino; }, x => { delete x.postIndex.target; },
    x => { x.postIndex.target.ino = x.oldIndex.source.ino; }, x => { x.postDetail.target.dev = "124"; },
    x => { x.binding.ino = x.lease.ino; }, x => { x.postDetail.dev = "124"; },
    x => { delete x.postIndex; }
  ];
  for (const change of cases) {
    const value = sample(); change(value);
    assert.throws(() => validateLinuxReclaimJournal(value));
  }
});

test("Linux reclaim journal schema never invokes getters", () => {
  const value = sample(); let invoked = false;
  Object.defineProperty(value.oldDetail, "size", { enumerable: true, get() { invoked = true; return "10"; } });
  assert.throws(() => validateLinuxReclaimJournal(value));
  assert.equal(invoked, false);
});

test("Linux reclaim journal schema rejects proxies and returns an independent frozen copy", () => {
  const value = sample(); let invoked = false;
  value.oldIndex = new Proxy(value.oldIndex, { ownKeys() { invoked = true; throw new Error("proxy trap"); } });
  assert.throws(() => validateLinuxReclaimJournal(value));
  assert.equal(invoked, false);
  const original = sample(), safe = validateLinuxReclaimJournal(original);
  original.oldIndex.source.ino = "99";
  assert.equal(safe.oldIndex.source.ino, "40");
  assert.throws(() => { safe.oldIndex.source.ino = "99"; });
});

test("Linux reclaim journal schema ignores inherited descriptor value", () => {
  const value = sample(); let invoked = false;
  Object.defineProperty(value.oldDetail, "size", { enumerable: true, get() { throw new Error("accessor executed"); } });
  Object.defineProperty(Object.prototype, "value", { configurable: true, get() { invoked = true; throw new Error("inherited getter executed"); } });
  try { assert.throws(() => validateLinuxReclaimJournal(value)); }
  finally { Reflect.deleteProperty(Object.prototype, "value"); }
  assert.equal(invoked, false);
});
