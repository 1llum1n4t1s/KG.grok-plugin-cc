import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { parseLinuxReclaimJournalJson } from "../plugins/grok/scripts/lib/linux-reclaim-journal.mjs";

// 故障条件: 巨大 JSON、重複 key（escape を含む）、不正 UTF-8、非正規の
// 表現、途中切断、Proxy や可変入力を認証済み intent として扱う。
// この境界は形式のみであり、filesystem・mutex・flock の証拠ではない。
const epoch = "11111111-1111-4111-8111-111111111111";
const sample = () => ({
  protocol: "linux-reclaim-journal-v1", epoch, txid: "22222222-2222-4222-8222-222222222222",
  phase: "prepared", slot: 7, jobId: "task-valid", claimToken: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-01-01T00:00:00.000Z", reclaimKind: "terminal",
  lease: { id: "44444444-4444-4444-8444-444444444444", path: `/state/worker-leases-v1/${epoch}/slot-007.lease`,
    dev: "123", ino: "20", stateGeneration: epoch, slot: 7 }, binding: { dev: "123", ino: "21" },
  oldIndex: { name: "index.pre", dev: "123", ino: "30", size: "3", sha256: "a".repeat(64), source: { dev: "123", ino: "40" } },
  postIndex: { name: "index.post", dev: "123", ino: "31", size: "3", sha256: "b".repeat(64), target: { dev: "123", ino: "31" } },
  oldDetail: { name: "detail.pre", dev: "123", ino: "32", size: "3", sha256: "c".repeat(64), source: { dev: "123", ino: "41" } },
  postDetail: { name: "detail.post", dev: "123", ino: "33", size: "3", sha256: "d".repeat(64), target: { dev: "123", ino: "33" } },
  ledgerTx: null
});
const canonical = value => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

test("Linux reclaim journal raw JSON rejects ambiguous and oversized encodings", () => {
  const raw = canonical(sample());
  const result = parseLinuxReclaimJournalJson(raw);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.oldIndex.source));
  raw.fill(0);
  assert.equal(result.oldIndex.source.ino, "40");
  const text = canonical(sample()).toString("utf8");
  for (const bad of [
    text.replace('"protocol":', '"protocol":"ignored","protocol":'),
    text.replace('"protocol":', '"\\u0070rotocol":"ignored","protocol":'),
    text.replace('"slot":7', '"slot":7,"slot":7'),
    ` ${text}`, text.trimEnd(), text.slice(0, -3),
    Buffer.from([0xff, 0x0a]), Buffer.alloc(65537, 0x20)
  ]) assert.throws(() => parseLinuxReclaimJournalJson(Buffer.isBuffer(bad) ? bad : Buffer.from(bad)));
});

test("Linux reclaim journal raw JSON rejects proxy and shared bytes", () => {
  let invoked = false;
  const proxy = new Proxy(canonical(sample()), { get() { invoked = true; throw new Error("proxy trap"); } });
  assert.throws(() => parseLinuxReclaimJournalJson(proxy));
  assert.equal(invoked, false);
  assert.throws(() => parseLinuxReclaimJournalJson(Buffer.from(new SharedArrayBuffer(128))));
  assert.throws(() => parseLinuxReclaimJournalJson("not bytes"));
});

test("Linux reclaim journal raw JSON rejects valid shared bytes from another realm", () => {
  const source = canonical(sample());
  const foreign = vm.runInNewContext(`new SharedArrayBuffer(${source.length})`);
  const input = Buffer.from(foreign);
  source.copy(input);
  assert.throws(() => parseLinuxReclaimJournalJson(input));
});

test("Linux reclaim journal raw JSON rejects shared bytes while another worker changes them", async () => {
  const source = canonical(sample());
  const foreign = vm.runInNewContext(`new SharedArrayBuffer(${source.length})`);
  const input = Buffer.from(foreign); source.copy(input);
  const offset = source.indexOf(Buffer.from("task-valid"));
  assert.ok(offset >= 0);
  const control = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const bytes = new Uint8Array(workerData.buffer), control = new Int32Array(workerData.control);
    Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    while (Atomics.load(control, 1) === 0) {
      Atomics.store(bytes, workerData.offset, 116);
      Atomics.store(bytes, workerData.offset, 117);
    }
  `, { eval: true, workerData: { buffer: foreign, control: control.buffer, offset } });
  try {
    assert.notEqual(Atomics.wait(control, 0, 0, 5000), "timed-out", "worker must start");
    assert.throws(() => parseLinuxReclaimJournalJson(input));
  } finally {
    Atomics.store(control, 1, 1);
    await worker.terminate();
  }
});
