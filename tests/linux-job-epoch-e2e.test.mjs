import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildStatusSnapshot } from "../plugins/grok/scripts/lib/job-control.mjs";
import { createJobLogFile, reserveLinuxTrackedJob, runTrackedJob } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { loadState, migrateStateLock, resolveJobFile, resolveStateDir, updateState, withStateSnapshot, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { LINUX_LEASE_SLOT_COUNT, releaseLinuxWorkerLease, withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";
import { removeTempFixture } from "./helpers.mjs";

// 実装と同じ private な通常ファイルとして旧 epoch の fixture を作る。
function writePrivate(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  const stat = fs.lstatSync(file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o077, 0);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.nlink, 1);
}

// 先行失敗条件: epoch 不在・変更を許す、旧/不一致 job の PID 照会や状態更新、
// 旧 finished 履歴の削除、既存 ID の claim・log 上書き、新規 claim の epoch 欠落。
const posixOnly = { skip: !["linux", "darwin"].includes(process.platform) ? "POSIX E2E only" : false };

test("job history remains isolated across Linux lock epochs", posixOnly, async t => {
  const parent = os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "grok-job-epoch-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const stateDir = resolveStateDir(workspace);
  const identity = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Fixture directory is not verified: ${file}`);
    return { dev: stat.dev, ino: stat.ino };
  };
  const rootIdentity = identity(root);
  let marker, stateIdentity, retain = false, ownerReleased = false;
  t.after(() => {
    try {
      if (process.platform === "linux") {
        if (retain || !marker?.epoch || !stateIdentity) throw new Error("fixture migration or ownership was not confirmed");
        assert.ok(ownerReleased, "fixture owner release was not confirmed");
        assert.deepEqual(identity(root), rootIdentity);
        assert.deepEqual(identity(stateDir), stateIdentity);
        // このテストは同期 state API と同一 process の runner だけを使い、worker・broker・agent を起動しない。
        withStateSnapshot(workspace, (_state, context) => {
          assert.equal(context.epoch, marker.epoch);
          const leaseDir = path.join(stateDir, "worker-leases-v1", marker.epoch);
          identity(path.dirname(leaseDir)); identity(leaseDir);
          assert.deepEqual(fs.readdirSync(path.dirname(leaseDir)), [marker.epoch]);
          const ledgerFile = path.join(leaseDir, "ledger.json");
          const ledgerStat = fs.lstatSync(ledgerFile);
          assert.ok(ledgerStat.isFile() && !ledgerStat.isSymbolicLink() && ledgerStat.nlink === 1);
          const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
          assert.equal(ledger.epoch, marker.epoch);
          assert.equal(ledger.slots.length, LINUX_LEASE_SLOT_COUNT);
          const expected = new Set(["ledger.json"]);
          for (const [index, slot] of ledger.slots.entries()) {
            assert.equal(slot.slot, index);
            if (slot.state === "free") continue;
            assert.ok(slot.lease, "unidentified lease must be retained");
            expected.add(`slot-${String(index).padStart(3, "0")}.lease`);
            expected.add(`slot-${String(index).padStart(3, "0")}.binding`);
            assert.equal(withAvailableLinuxLease(slot.lease, context, () => true).status, "available");
          }
          assert.deepEqual(new Set(fs.readdirSync(leaseDir)), expected);
          for (const name of ["broker.json", "broker.lock", "broker-v2", "direct-start-v1"]) assert.equal(fs.readdirSync(stateDir).includes(name), false);
          assert.equal(fs.readdirSync(stateDir).some(name => /^broker\.json\..*\.tmp$/.test(name)), false);
          for (const name of ["broker-v3", "direct-start-v2"]) {
            const dir = path.join(stateDir, name);
            identity(dir); identity(path.join(dir, marker.epoch));
            assert.deepEqual(fs.readdirSync(dir), [marker.epoch]);
            assert.deepEqual(fs.readdirSync(path.join(dir, marker.epoch)), []);
          }
        });
        const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
        assert.equal(stopped.stopped, true);
        assert.equal(stopped.stateDir, stateDir);
        assert.equal(stopped.epoch, marker.epoch);
        assert.deepEqual(identity(root), rootIdentity);
        removeTempFixture(root, { recursive: true, force: true });
      } else {
        assert.equal(path.dirname(root), parent);
        fs.rmSync(root, { recursive: true, force: true });
      }
    } catch (error) {
      throw new Error(`Fixture cleanup or owned process termination not confirmed: ${root}`, { cause: error });
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
  });
  marker = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  if (process.platform === "linux") { assert.equal(marker.stateDir, stateDir); stateIdentity = identity(stateDir); }
  const darwinJob = { id: "darwin-retained", status: "completed", epoch: marker.epoch, createdAt: "2020-01-01T00:00:00.000Z" };
  if (process.platform === "darwin") updateState(workspace, (state, context) => {
    state.jobs.push(darwinJob);
    writeJobFile(workspace, darwinJob.id, darwinJob, context);
  });
  let contextEpoch;
  updateState(workspace, (_state, context) => { contextEpoch = context.epoch; assert.ok(Object.isFrozen(context)); });
  assert.equal(contextEpoch, marker.epoch);
  assert.match(contextEpoch, /^[0-9a-f-]{36}$/i);
  if (process.platform === "darwin") {
    const protocol = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
    assert.equal(protocol.epoch, contextEpoch);
    assert.deepEqual(loadState(workspace).jobs, [darwinJob]);
    assert.deepEqual(JSON.parse(fs.readFileSync(resolveJobFile(workspace, darwinJob.id), "utf8")), darwinJob);
    return;
  }
  const markerPath = path.join(stateDir, "state.lock", "protocol.json");
  const originalMarker = fs.readFileSync(markerPath, "utf8");
  withStateSnapshot(workspace, (_state, context) => {
    try {
      fs.writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(originalMarker), epoch: randomUUID() }));
      assert.throws(() => context.check());
    } finally { fs.writeFileSync(markerPath, originalMarker); }
  });

  const jobsDir = path.join(stateDir, "jobs");
  const old = { id: "old-running", status: "running", createdAt: "2000-01-01T00:00:00.000Z", pid: 2147483647,
    processStartKey: `${randomUUID()}:1`, grokPromptState: "pending" };
  const mismatched = { ...old, id: "mismatch", epoch: contextEpoch };
  const missing = { ...old, id: "missing" };
  const queued = { ...old, id: "old-queued", status: "queued" };
  const finished = Array.from({ length: 55 }, (_, i) => ({ id: `old-finished-${i}`, status: "completed", updatedAt: `2000-01-${String(i % 28 + 1).padStart(2, "0")}` }));
  const stateFile = path.join(stateDir, "state.json");
  writePrivate(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [old, mismatched, missing, queued, ...finished] }));
  writePrivate(path.join(jobsDir, `${old.id}.json`), JSON.stringify(old));
  writePrivate(path.join(jobsDir, `${mismatched.id}.json`), JSON.stringify({ ...mismatched, epoch: randomUUID() }));
  writePrivate(path.join(jobsDir, `${queued.id}.json`), JSON.stringify(queued));
  writePrivate(path.join(jobsDir, "orphan-detail.json"), JSON.stringify({ id: "orphan-detail", status: "queued" }));
  const finishedDetail = path.join(jobsDir, `${finished[0].id}.json`);
  const finishedPayload = JSON.stringify(finished[0]);
  writePrivate(finishedDetail, finishedPayload);
  const before = fs.readFileSync(stateFile, "utf8");
  const readFile = fs.readFileSync;
  let oldPidLookups = 0;
  try {
    fs.readFileSync = function (file, ...args) {
      if (String(file).startsWith(`/proc/${old.pid}/`)) oldPidLookups++;
      return readFile.call(this, file, ...args);
    };
    buildStatusSnapshot(workspace, { all: true });
  } finally { fs.readFileSync = readFile; }
  assert.equal(oldPidLookups, 0);
  assert.equal(fs.readFileSync(stateFile, "utf8"), before);
  updateState(workspace, state => { state.config.test = true; });
  assert.equal(loadState(workspace).jobs.length, 59);
  assert.equal(fs.readFileSync(finishedDetail, "utf8"), finishedPayload);
  const oldDetail = fs.readFileSync(path.join(jobsDir, `${old.id}.json`), "utf8");
  const mismatchDetail = fs.readFileSync(path.join(jobsDir, `${mismatched.id}.json`), "utf8");
  const beforeRejectedClaims = fs.readFileSync(stateFile, "utf8");
  for (const record of [old, mismatched, missing, queued, { id: "orphan-detail" }]) {
    await assert.rejects(runTrackedJob({ ...record, workspaceRoot: workspace }, async () => { throw Error("must not run"); },
      { getProcessSnapshotImpl: () => ({ startKey: "valid" }) }));
  }
  assert.equal(fs.readFileSync(stateFile, "utf8"), beforeRejectedClaims);
  assert.equal(fs.readFileSync(path.join(jobsDir, `${old.id}.json`), "utf8"), oldDetail);
  assert.equal(fs.readFileSync(path.join(jobsDir, `${mismatched.id}.json`), "utf8"), mismatchDetail);
  assert.equal(fs.existsSync(path.join(jobsDir, `${missing.id}.json`)), false);
  assert.throws(() => createJobLogFile(workspace, old.id, "indexed collision"));
  const oldLog = path.join(jobsDir, `${old.id}.log`);
  writePrivate(oldLog, "old log");
  assert.throws(() => createJobLogFile(workspace, old.id, "collision"));
  assert.equal(fs.readFileSync(oldLog, "utf8"), "old log");
  const newJob = { id: "new-job", workspaceRoot: workspace };
  const newOptions = { getProcessSnapshotImpl: () => ({ startKey: "valid" }) };
  const reservation = process.platform === "linux" ? reserveLinuxTrackedJob(newJob, newOptions) : null;
  try { await runTrackedJob(newJob, async () => ({ exitStatus: "completed" }), reservation ? { ...newOptions, reservation } : newOptions); }
  finally { if (reservation) { ownerReleased = releaseLinuxWorkerLease(reservation.owner); assert.equal(ownerReleased, true); } }
  assert.equal(loadState(workspace).jobs.find(job => job.id === "new-job").epoch, contextEpoch);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsDir, "new-job.json"), "utf8")).epoch, contextEpoch);
  await t.test("invalid historical JSON fails closed and is preserved", () => {
    const stateBefore = fs.readFileSync(stateFile, "utf8");
    writePrivate(finishedDetail, "old detail");
    try {
      assert.throws(() => updateState(workspace, state => { state.config.test = "corrupt"; }));
      assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
      assert.equal(fs.readFileSync(finishedDetail, "utf8"), "old detail");
    } finally { writePrivate(finishedDetail, finishedPayload); }
  });
  await t.test("dangling detail and log symlinks are preserved and rejected", async () => {
    const danglingDetail = path.join(jobsDir, "dangling-detail.json");
    const danglingLog = path.join(jobsDir, "dangling-log.log");
    const links = [];
    const addLink = (file, target) => {
      let recorded = false;
      try {
        fs.symlinkSync(target, file);
        const stat = fs.lstatSync(file, { bigint: true });
        if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== target) throw new Error("fixture symlink is not verified");
        links.push({ file, target, dev: stat.dev, ino: stat.ino });
        recorded = true;
      } finally { if (!recorded) retain = true; }
    };
    try {
      addLink(danglingDetail, "missing-detail-target");
      addLink(danglingLog, "missing-log-target");
      const stateBefore = fs.readFileSync(stateFile, "utf8");
      await assert.rejects(runTrackedJob({ id: "dangling-detail", workspaceRoot: workspace }, async () => { throw Error("must not run"); },
        { getProcessSnapshotImpl: () => ({ startKey: "valid" }) }));
      assert.throws(() => createJobLogFile(workspace, "dangling-detail", "collision"));
      assert.throws(() => createJobLogFile(workspace, "dangling-log", "collision"));
      assert.throws(() => updateState(workspace, state => { state.config.test = "symlink"; }));
      assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
      assert.equal(fs.readlinkSync(danglingDetail), "missing-detail-target");
      assert.equal(fs.readlinkSync(danglingLog), "missing-log-target");
      assert.equal(fs.existsSync(path.join(jobsDir, "dangling-detail.log")), false);
      assert.equal(fs.readFileSync(finishedDetail, "utf8"), finishedPayload);
    } finally {
      if (process.platform === "linux") try {
        for (const link of links) {
          const stat = fs.lstatSync(link.file, { bigint: true });
          assert.ok(stat.isSymbolicLink());
          assert.equal(stat.dev, link.dev);
          assert.equal(stat.ino, link.ino);
          assert.equal(fs.readlinkSync(link.file), link.target);
          fs.unlinkSync(link.file);
        }
      } catch (error) {
        retain = true;
        throw new Error(`Fixture symlink ownership or removal was not confirmed: ${root}`, { cause: error });
      }
    }
  });
});
