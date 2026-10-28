import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildStatusSnapshot } from "../plugins/grok/scripts/lib/job-control.mjs";
import { createJobLogFile, runTrackedJob } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { loadState, migrateStateLock, resolveStateDir, updateState, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

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
  let migrated = false;
  t.after(() => {
    try {
      if (process.platform === "linux") {
        // 初期化失敗時は sentinel の有無を推測せず fixture を残す。
        if (!migrated) { t.diagnostic(`Retained unconfirmed sentinel fixture: ${root}`); return; }
        assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
      }
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const marker = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  let contextEpoch;
  updateState(workspace, (_state, context) => { contextEpoch = context.epoch; assert.ok(Object.isFrozen(context)); });
  if (process.platform === "darwin") { assert.equal(contextEpoch, null); return; }
  assert.equal(contextEpoch, marker.epoch);
  assert.match(contextEpoch, /^[0-9a-f-]{36}$/i);
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
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [old, mismatched, missing, queued, ...finished] }));
  fs.writeFileSync(path.join(jobsDir, `${old.id}.json`), JSON.stringify(old));
  fs.writeFileSync(path.join(jobsDir, `${mismatched.id}.json`), JSON.stringify({ ...mismatched, epoch: randomUUID() }));
  fs.writeFileSync(path.join(jobsDir, `${queued.id}.json`), JSON.stringify(queued));
  fs.writeFileSync(path.join(jobsDir, "orphan-detail.json"), JSON.stringify({ id: "orphan-detail", status: "queued" }));
  const danglingDetail = path.join(jobsDir, "dangling-detail.json");
  const danglingLog = path.join(jobsDir, "dangling-log.log");
  fs.symlinkSync("missing-detail-target", danglingDetail);
  fs.symlinkSync("missing-log-target", danglingLog);
  fs.writeFileSync(path.join(jobsDir, `${finished[0].id}.json`), "old detail");
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
  assert.equal(fs.readFileSync(path.join(jobsDir, `${finished[0].id}.json`), "utf8"), "old detail");
  const oldDetail = fs.readFileSync(path.join(jobsDir, `${old.id}.json`), "utf8");
  const mismatchDetail = fs.readFileSync(path.join(jobsDir, `${mismatched.id}.json`), "utf8");
  const beforeRejectedClaims = fs.readFileSync(stateFile, "utf8");
  for (const record of [old, mismatched, missing, queued, { id: "orphan-detail" }, { id: "dangling-detail" }]) {
    await assert.rejects(runTrackedJob({ ...record, workspaceRoot: workspace }, async () => { throw Error("must not run"); },
      { getProcessSnapshotImpl: () => ({ startKey: "valid" }) }));
  }
  assert.equal(fs.readFileSync(stateFile, "utf8"), beforeRejectedClaims);
  assert.equal(fs.readFileSync(path.join(jobsDir, `${old.id}.json`), "utf8"), oldDetail);
  assert.equal(fs.readFileSync(path.join(jobsDir, `${mismatched.id}.json`), "utf8"), mismatchDetail);
  assert.equal(fs.existsSync(path.join(jobsDir, `${missing.id}.json`)), false);
  assert.throws(() => createJobLogFile(workspace, "dangling-detail", "collision"));
  assert.throws(() => createJobLogFile(workspace, "dangling-log", "collision"));
  assert.equal(fs.readlinkSync(danglingDetail), "missing-detail-target");
  assert.equal(fs.readlinkSync(danglingLog), "missing-log-target");
  assert.equal(fs.existsSync(path.join(jobsDir, "dangling-detail.log")), false);
  assert.throws(() => createJobLogFile(workspace, old.id, "indexed collision"));
  const oldLog = path.join(jobsDir, `${old.id}.log`);
  fs.writeFileSync(oldLog, "old log");
  assert.throws(() => createJobLogFile(workspace, old.id, "collision"));
  assert.equal(fs.readFileSync(oldLog, "utf8"), "old log");
  await runTrackedJob({ id: "new-job", workspaceRoot: workspace }, async () => ({ exitStatus: "completed" }),
    { getProcessSnapshotImpl: () => ({ startKey: "valid" }) });
  assert.equal(loadState(workspace).jobs.find(job => job.id === "new-job").epoch, contextEpoch);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsDir, "new-job.json"), "utf8")).epoch, contextEpoch);
});
