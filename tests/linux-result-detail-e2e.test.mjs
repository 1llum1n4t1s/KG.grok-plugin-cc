import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { migrateStateLock, resolveJobFile, resolveStateDir, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 履歴は合成するが、Linux の state lock・sentinel と result CLI は実物を使う。
// root はこのテスト専用で、他の工程とは共有しない。
test("Linux result rejects missing or mismatched detail and preserves history", {
  skip: process.platform !== "linux", timeout: 120000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-result-detail-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), stateFile = path.join(stateDir, "state.json");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data }; delete env.PLUGIN_DATA;
  const run = args => spawnSync(process.execPath, [command, ...args], { env, encoding: "utf8", timeout: 30000 });
  const identity = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    assert.ok(stat.isFile() || stat.isDirectory());
    assert.equal(stat.uid, BigInt(process.getuid()));
    if (stat.isFile()) assert.equal(stat.nlink, 1n);
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, nlink: stat.nlink };
  };
  const assertAbsent = file => {
    try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    assert.fail(`Unexpected entry must not be overwritten: ${file}`);
  };
  const rootIdentity = identity(root);
  const assertStatePath = () => {
    const relative = path.relative(root, stateDir);
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(fs.realpathSync(current), current);
    }
  };
  let migrated = false, verified = false, stopped = false, stateIdentity;
  const diagnoseUnconfirmed = () => {
    const barrier = path.join(stateDir, "state.lock");
    let candidates = [], foundPid = false;
    try {
      candidates = fs.readdirSync(barrier).filter(name => name === "protocol.json" || /^prepared-.*\.json$/.test(name));
      for (const name of candidates) {
        const file = path.join(barrier, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue;
        const marker = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Number.isInteger(marker.sentinel?.pid) && marker.sentinel.pid > 0) foundPid = true;
        t.diagnostic(`Unconfirmed sentinel evidence in ${file}: pid=${marker.sentinel?.pid ?? "unknown"}, startTick=${marker.sentinel?.startTick ?? "unknown"}`);
      }
    } catch (error) { t.diagnostic(`Sentinel evidence unavailable: ${error.message}`); }
    if (!foundPid) t.diagnostic("Sentinel PID is unknown; migration may have started a sentinel without publishing a readable marker.");
    t.diagnostic(`Retained unconfirmed fixture: ${root}. Confirm ownership and termination before offline recovery or cleanup.`);
  };
  t.after(() => {
    try {
      if (!migrated || !stateIdentity) { diagnoseUnconfirmed(); return; }
      assert.deepEqual(identity(root), rootIdentity); assertStatePath(); assert.deepEqual(identity(stateDir), stateIdentity);
      const stop = run(["state-lock", "stop-sentinel", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace, "--json"]);
      assert.equal(stop.error, undefined); assert.equal(stop.signal, null); assert.equal(stop.status, 0, stop.stderr);
      const stopPayload = JSON.parse(stop.stdout); assert.equal(stopPayload.stopped, true); assert.equal(stopPayload.stateDir, stateDir); stopped = true;
      if (verified) { assert.deepEqual(identity(root), rootIdentity); removeTempFixture(root, { recursive: true, force: true }); }
      else t.diagnostic(`Retained result fixture after sentinel stop: ${root}; live file descriptors are no longer preserved.`);
    } catch (error) {
      if (stopped) t.diagnostic(`Retained result fixture after sentinel stop and cleanup failure: ${root}; live file descriptors are no longer preserved.`);
      else diagnoseUnconfirmed();
      throw error;
    }
  });
  const migration = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true; stateIdentity = identity(stateDir);
  const job = { id: "synthetic-result", status: "completed", title: "Synthetic result", epoch: migration.epoch,
    createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" };
  const detail = { ...job, result: { rawOutput: "synthetic result payload" } };
  updateState(workspace, (state, context) => { writeJobFile(workspace, job.id, detail, context); state.jobs.push(job); });
  stateIdentity = identity(stateDir);
  const detailPath = resolveJobFile(workspace, job.id), held = path.join(root, "held-detail"), heldWrong = path.join(root, "held-wrong");
  const detailBytes = fs.readFileSync(detailPath), detailIdentity = identity(detailPath);
  const stateBytes = fs.readFileSync(stateFile), stateIdentityBefore = identity(stateFile);
  const unchangedState = () => { assert.deepEqual(fs.readFileSync(stateFile), stateBytes); assert.deepEqual(identity(stateFile), stateIdentityBefore); };
  const result = () => run(["result", "--cwd", workspace, "--json", job.id]);
  const restored = () => {
    assert.deepEqual(identity(detailPath), detailIdentity); assert.deepEqual(fs.readFileSync(detailPath), detailBytes); unchangedState();
    const response = result();
    assert.equal(response.error, undefined); assert.equal(response.signal, null); assert.equal(response.status, 0, response.stderr);
    const payload = JSON.parse(response.stdout); assert.equal(payload.job.id, job.id); assert.deepEqual(payload.storedJob, detail);
    unchangedState(); assert.deepEqual(identity(detailPath), detailIdentity); assert.deepEqual(fs.readFileSync(detailPath), detailBytes);
  };
  const rejected = (response, message) => {
    assert.equal(response.error, undefined); assert.equal(response.signal, null); assert.equal(response.status, 1);
    assert.match(response.stderr, message); assert.doesNotMatch(`${response.stderr}\n${response.stdout}`, /No finished job found/i);
  };
  fs.renameSync(detailPath, held);
  try {
    rejected(result(), /is indexed but its result detail is missing/); unchangedState();
    assert.deepEqual(identity(held), detailIdentity); assert.deepEqual(fs.readFileSync(held), detailBytes);
  } finally {
    assert.deepEqual(identity(held), detailIdentity); assertAbsent(detailPath);
    fs.renameSync(held, detailPath);
  }
  restored();
  const wrongBytes = Buffer.from(JSON.stringify({ ...detail, id: "another-job" }));
  fs.renameSync(detailPath, held);
  try {
    fs.writeFileSync(detailPath, wrongBytes, { mode: 0o600, flag: "wx" });
    const wrongIdentity = identity(detailPath);
    try {
      rejected(result(), /has an inconsistent result detail identity/); unchangedState();
      assert.deepEqual(identity(detailPath), wrongIdentity); assert.deepEqual(fs.readFileSync(detailPath), wrongBytes);
    } finally {
      assert.deepEqual(identity(detailPath), wrongIdentity); assert.deepEqual(fs.readFileSync(detailPath), wrongBytes);
      assertAbsent(heldWrong); fs.renameSync(detailPath, heldWrong);
    }
  } finally {
    assert.deepEqual(identity(held), detailIdentity); assertAbsent(detailPath);
    fs.renameSync(held, detailPath);
  }
  restored(); verified = true;
});
