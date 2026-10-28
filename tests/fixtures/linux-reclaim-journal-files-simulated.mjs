import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { inspectLinuxReclaimSnapshotFiles } from "../../plugins/grok/scripts/lib/linux-reclaim-journal.mjs";

const root = process.env.GROK_LINUX_SIM_ROOT, state = process.env.GROK_LINUX_SIM_STATE_DIR;
const mode = process.argv[2], epoch = "11111111-1111-4111-8111-111111111111";
const jobs = path.join(state, "jobs"), journalDir = path.join(state, "reclaim-journal-v1", epoch);
fs.mkdirSync(jobs, { mode: 0o700 }); fs.mkdirSync(path.dirname(journalDir), { mode: 0o700 }); fs.mkdirSync(journalDir, { mode: 0o700 });
const payloads = { "index.pre": "old index\n", "index.post": "new index\n", "detail.pre": "old detail\n", "detail.post": "new detail\n" };
for (const [name, data] of Object.entries(payloads)) fs.writeFileSync(path.join(journalDir, name), data, { flag: "wx", mode: 0o600 });
const indexPath = path.join(state, "state.json"), detailPath = path.join(jobs, "task-valid.json");
fs.writeFileSync(indexPath, payloads["index.pre"], { flag: "wx", mode: 0o600 });
fs.writeFileSync(detailPath, payloads["detail.pre"], { flag: "wx", mode: 0o600 });
const id = target => { const stat = fs.lstatSync(target, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; };
const image = (name, source, target) => ({ name, ...id(path.join(journalDir, name)), size: String(Buffer.byteLength(payloads[name])),
  sha256: createHash("sha256").update(payloads[name]).digest("hex"), ...(source ? { source: id(source) } : { target: id(target) }) });
const txid = "22222222-2222-4222-8222-222222222222";
const dev = id(indexPath).dev;
const journal = { protocol: "linux-reclaim-journal-v1", epoch, txid, phase: "prepared", slot: 7,
  jobId: "task-valid", claimToken: "33333333-3333-4333-8333-333333333333", createdAt: "2026-01-01T00:00:00.000Z", reclaimKind: "terminal",
  lease: { id: "44444444-4444-4444-8444-444444444444", path: `${state}/worker-leases-v1/${epoch}/slot-007.lease`,
    dev, ino: "9000000001", stateGeneration: epoch, slot: 7 }, binding: { dev, ino: "9000000002" },
  oldIndex: image("index.pre", indexPath), postIndex: image("index.post", null, path.join(journalDir, "index.post")),
  oldDetail: image("detail.pre", detailPath), postDetail: image("detail.post", null, path.join(journalDir, "detail.post")), ledgerTx: null };
if (mode === "detail-post" || mode === "both-post") fs.renameSync(path.join(journalDir, "detail.post"), detailPath);
if (mode === "both-post" || mode === "index-post-first") {
  fs.renameSync(path.join(journalDir, "index.post"), indexPath);
  if (mode === "both-post") {
    journal.phase = "detail";
    journal.ledgerTx = { id: "55555555-5555-4555-8555-555555555555", outerTxid: txid, operation: "reclaiming", state: "complete",
      oldLedger: { dev, ino: "9000000010", size: "10", sha256: "a".repeat(64) },
      newLedger: { dev, ino: "9000000011", size: "10", sha256: "b".repeat(64) } };
  }
}
if (mode === "digest") fs.writeFileSync(path.join(journalDir, "detail.pre"), "bad detail\n");
if (mode === "source-changed") fs.writeFileSync(detailPath, "bad detail\n");
if (mode === "source-replaced") { fs.renameSync(detailPath, path.join(root, "old-detail-held")); fs.writeFileSync(detailPath, payloads["detail.pre"], { mode: 0o600 }); }
if (mode === "symlink") { fs.renameSync(path.join(journalDir, "index.post"), path.join(root, "post-held")); fs.symlinkSync(path.join(root, "post-held"), path.join(journalDir, "index.post")); }
if (mode === "hardlink") fs.linkSync(path.join(journalDir, "detail.pre"), path.join(root, "extra-hardlink"));
if (mode === "mode") fs.chmodSync(path.join(journalDir, "index.pre"), 0o644);
const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const rootFd = fs.openSync(state, flags), jobsFd = fs.openSync(jobs, flags);
const journalFd = mode === "journal-not-directory" ? fs.openSync(indexPath, fs.constants.O_RDONLY) : fs.openSync(journalDir, flags);
let faultReached = false;
if (["named-jobs-mount", "named-journal-mount", "post-named-jobs-mount", "post-named-journal-mount", "post-named-namespace-mount"].includes(mode)) {
  const open = fs.openSync, read = fs.readFileSync, named = new Set();
  const post = mode.startsWith("post-");
  let pathOpens = 0;
  fs.openSync = function (target, ...args) {
    const fd = open.call(this, target, ...args);
    const matches = typeof target === "string" && (mode.includes("jobs-mount") ? /\/jobs$/.test(target)
      : mode.includes("namespace-mount") ? /\/reclaim-journal-v1$/.test(target) : target.endsWith(`/${epoch}`));
    if (matches && ++pathOpens >= (post ? 2 : 1)) {
      named.add(fd); faultReached = true;
    }
    return fd;
  };
  fs.readFileSync = function (target, options) {
    const match = typeof target === "string" && /^\/proc\/self\/fdinfo\/(\d+)$/.exec(target);
    if (match && named.has(Number(match[1]))) return typeof options === "string" || options?.encoding ? "mnt_id:\t42\n" : Buffer.from("mnt_id:\t42\n");
    return read.call(this, target, options);
  };
  syncBuiltinESMExports();
}
if (mode === "deadline") {
  const read = fs.readSync;
  fs.readSync = function (...args) {
    if (!faultReached) { faultReached = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); }
    return read.apply(this, args);
  };
  syncBuiltinESMExports();
}
try {
  const inspect = () => inspectLinuxReclaimSnapshotFiles({ rootFd, jobsFd, journalFd, journal,
    ...(mode === "budget" ? { maxBytes: 1 } : {}), ...(mode === "deadline" ? { timeoutMs: 1000 } : {}) });
  if (["old", "detail-post", "both-post"].includes(mode)) {
    const expected = mode === "old" ? { index: "old", detail: "old" }
      : mode === "detail-post" ? { index: "old", detail: "post" } : { index: "post", detail: "post" };
    assert.deepEqual(inspect(), expected);
  } else if (mode.startsWith("flag-")) {
    assert.throws(inspect, /flag/i);
    assert.equal(globalThis.__reclaimFlagFixtureOperations(), 0, "missing safety flags must be rejected before filesystem access");
  } else if (mode === "budget") assert.throws(inspect, /budget/i);
  else if (mode === "deadline") { assert.throws(inspect, /deadline/i); assert.ok(faultReached); }
  else {
    assert.throws(inspect);
    if (mode.includes("named-") && mode.endsWith("-mount")) assert.ok(faultReached, "named path must actually be opened at the injection point");
  }
} finally { fs.closeSync(journalFd); fs.closeSync(jobsFd); fs.closeSync(rootFd); }
process.stdout.write(`verified ${mode}\n`);
