import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// 先行失敗条件: 不正なログ参照、索引と詳細の状態・世代・作成日時・停止証拠の
// 不一致、明示削除、旧状態の移行。いずれも両記録とログを保持する。
const macOnly = { skip: process.platform !== "darwin" ? "macOS state-prune E2E only" : false };
const moduleUrl = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "grok-prune-e2e-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_OPTIONAL_LOCKS"].includes(key)) delete env[key];
  const run = body => {
    const source = `import {resolveStateDir,migrateStateLock,updateState,writeJobFile} from ${JSON.stringify(moduleUrl)}; const workspace=${JSON.stringify(workspace)}; ${body}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: workspace, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const stateDir = run("console.log(JSON.stringify(resolveStateDir(workspace)));");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateDir, jobsDir: path.join(stateDir, "jobs"), run };
}
function migrate(f) {
  return f.run(`try { migrateStateLock(workspace,{offlineConfirmed:true,localOnly:true,expectedStateDir:${JSON.stringify(f.stateDir)}}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function files(f, index, detail) {
  fs.mkdirSync(f.jobsDir, { recursive: true, mode: 0o700 });
  const detailFile = path.join(f.jobsDir, `${index.id}.json`), logFile = path.join(f.jobsDir, `${index.id}.log`);
  writeJson(detailFile, detail); fs.writeFileSync(logFile, "log evidence", { mode: 0o600 });
  return { detailFile, logFile };
}
function unchanged(file, contents) { assert.equal(fs.readFileSync(file, "utf8"), contents); }

for (const mismatch of ["status", "createdAt", "epoch", "pid", "logFile"]) {
  for (const action of ["prune", "remove"]) test(`macOS ${action} preserves unverified ${mismatch} and external files`, macOnly, t => {
    const f = fixture(t); assert.equal(migrate(f).ok, true);
    const outside = path.join(f.root, "outside.log"); fs.writeFileSync(outside, "outside evidence");
    const expectedLog = path.join(f.jobsDir, "old.log");
    const old = { id: "old", status: "completed", createdAt: "2020-01-01", updatedAt: "2020-01-01", pid: null, logFile: expectedLog };
    const detail = { ...old };
    if (mismatch === "status") detail.status = "running";
    if (mismatch === "createdAt") detail.createdAt = "other";
    if (mismatch === "epoch") detail.epoch = "other";
    if (mismatch === "pid") detail.pid = 42;
    if (mismatch === "logFile") old.logFile = detail.logFile = outside;
    const evidence = files(f, old, detail);
    const newer = Array.from({ length: 50 }, (_, i) => ({ id: `new-${i}`, status: "completed", createdAt: "2021-01-01", updatedAt: `2021-${String(i + 1).padStart(2, "0")}` }));
    for (const job of newer) files(f, job, job);
    const stateFile = path.join(f.stateDir, "state.json"); writeJson(stateFile, { version: 1, jobs: [old, ...newer] });
    const beforeDetail = fs.readFileSync(evidence.detailFile, "utf8");
    const result = f.run(`try { updateState(workspace,s=>{${action === "remove" ? "s.jobs=s.jobs.filter(j=>j.id!=='old');" : "s.config.test=true;"}}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
    if (action === "remove") assert.equal(result.ok, false);
    else assert.equal(result.ok, true);
    assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.some(job => job.id === "old"));
    unchanged(evidence.detailFile, beforeDetail); unchanged(evidence.logFile, "log evidence"); unchanged(outside, "outside evidence");
  });
}

for (const where of ["index", "detail"]) test(`macOS legacy migration rejects outside log in ${where}`, macOnly, t => {
  const f = fixture(t); fs.mkdirSync(f.jobsDir, { recursive: true, mode: 0o700 });
  const outside = path.join(f.root, "outside.log"); fs.writeFileSync(outside, "outside evidence");
  const job = { id: "old", status: "completed", createdAt: "2020-01-01", logFile: path.join(f.jobsDir, "old.log") };
  const detail = { ...job }; (where === "index" ? job : detail).logFile = outside;
  const evidence = files(f, job, detail), stateFile = path.join(f.stateDir, "state.json");
  writeJson(stateFile, { version: 1, jobs: [job] });
  const beforeState = fs.readFileSync(stateFile, "utf8"), beforeDetail = fs.readFileSync(evidence.detailFile, "utf8");
  assert.equal(migrate(f).ok, false);
  unchanged(stateFile, beforeState); unchanged(evidence.detailFile, beforeDetail);
  unchanged(evidence.logFile, "log evidence"); unchanged(outside, "outside evidence");
});

for (const target of ["state", "detail"]) test(`macOS oversized ${target} write leaves the readable record untouched`, macOnly, t => {
  const f = fixture(t); assert.equal(migrate(f).ok, true);
  const job = { id: "old", status: "completed", createdAt: "2020-01-01" };
  const stateFile = path.join(f.stateDir, "state.json"), detailFile = files(f, job, job).detailFile;
  writeJson(stateFile, { version: 1, jobs: [job] });
  const targetFile = target === "state" ? stateFile : detailFile;
  const before = fs.readFileSync(targetFile, "utf8");
  const result = f.run(`try { const huge='x'.repeat(64*1024*1024); ${target === "state" ? "updateState(workspace,s=>{s.config.huge=huge;});" : "writeJobFile(workspace,'old',{id:'old',huge});"} console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
  assert.equal(result.ok, false);
  unchanged(targetFile, before);
});

for (const action of ["prune", "remove"]) test(`macOS ${action} retains case-aliased job records`, macOnly, t => {
  const f = fixture(t); assert.equal(migrate(f).ok, true);
  fs.writeFileSync(path.join(f.root, "caseprobe"), "probe");
  if (!fs.existsSync(path.join(f.root, "CASEPROBE"))) { t.skip("fixture filesystem is case-sensitive"); return; }
  const old = { id: "old", status: "completed", createdAt: "2020-01-01", updatedAt: "2020-01-01", logFile: path.join(f.jobsDir, "old.log") };
  const evidence = files(f, old, old), duplicate = { ...old, id: "OLD", updatedAt: "2021-99" };
  const newer = Array.from({ length: 49 }, (_, i) => ({ id: `new-${i}`, status: "completed", createdAt: "2021-01-01", updatedAt: `2021-${String(i + 1).padStart(2, "0")}` }));
  for (const job of newer) files(f, job, job);
  const stateFile = path.join(f.stateDir, "state.json"); writeJson(stateFile, { version: 1, jobs: [old, duplicate, ...newer] });
  const beforeDetail = fs.readFileSync(evidence.detailFile, "utf8");
  const result = f.run(`try { updateState(workspace,s=>{${action === "remove" ? "s.jobs=s.jobs.filter(j=>j.id!=='old');" : "s.config.test=true;"}}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
  if (action === "remove") assert.equal(result.ok, false);
  assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.some(job => job.id === "old"));
  unchanged(evidence.detailFile, beforeDetail); unchanged(evidence.logFile, "log evidence");
});

for (const action of ["update", "detail"]) test(`macOS ${action} refuses a jobs symlink without changing its target`, macOnly, t => {
  const f = fixture(t); assert.equal(migrate(f).ok, true);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside, { mode: 0o755 }); fs.chmodSync(outside, 0o755);
  const sentinel = path.join(outside, "old.json"); fs.writeFileSync(sentinel, "outside evidence", { mode: 0o600 });
  fs.symlinkSync(outside, f.jobsDir, "dir");
  const stateFile = path.join(f.stateDir, "state.json"), beforeState = fs.readFileSync(stateFile, "utf8");
  const result = f.run(`try { ${action === "update" ? "updateState(workspace,s=>{s.config.test=true;});" : "writeJobFile(workspace,'old',{id:'old'});"} console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
  assert.equal(result.ok, false);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755); unchanged(sentinel, "outside evidence"); unchanged(stateFile, beforeState);
});

for (const missing of ["missing-epoch", "old-epoch", "terminationPending", "grokPromptState"]) {
  for (const action of ["prune", "remove"]) test(`macOS ${action} retains records without current ${missing} proof`, macOnly, t => {
    const f = fixture(t); assert.equal(migrate(f).ok, true);
    const epoch = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
    const old = { id: "old", status: "completed", createdAt: "2020-01-01", updatedAt: "2020-01-01", epoch,
      terminationPending: false, grokPromptState: "terminal", logFile: path.join(f.jobsDir, "old.log") };
    if (missing === "missing-epoch") delete old.epoch;
    else if (missing === "old-epoch") old.epoch = "old-generation";
    else delete old[missing];
    const evidence = files(f, old, old);
    const newer = Array.from({ length: 50 }, (_, i) => ({ id: `new-${i}`, status: "completed", createdAt: "2021-01-01",
      updatedAt: `2021-${String(i + 1).padStart(2, "0")}`, epoch, terminationPending: false, grokPromptState: "terminal" }));
    for (const job of newer) files(f, job, job);
    const stateFile = path.join(f.stateDir, "state.json"); writeJson(stateFile, { version: 1, jobs: [old, ...newer] });
    const beforeDetail = fs.readFileSync(evidence.detailFile, "utf8");
    const result = f.run(`try { updateState(workspace,s=>{${action === "remove" ? "s.jobs=s.jobs.filter(j=>j.id!=='old');" : "s.config.test=true;"}}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
    if (action === "remove") assert.equal(result.ok, false);
    else assert.equal(result.ok, true);
    assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.some(job => job.id === "old"));
    unchanged(evidence.detailFile, beforeDetail); unchanged(evidence.logFile, "log evidence");
  });
}

test("macOS retains current terminal records with matching explicit evidence", macOnly, t => {
  const f = fixture(t); assert.equal(migrate(f).ok, true);
  const epoch = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
  const jobs = Array.from({ length: 51 }, (_, i) => ({ id: `job-${i}`, status: "completed", createdAt: "2020-01-01",
    updatedAt: `2020-${String(i + 1).padStart(2, "0")}`, epoch, terminationPending: false, grokPromptState: "terminal",
    logFile: path.join(f.jobsDir, `job-${i}.log`) }));
  for (const job of jobs) files(f, job, job);
  const stateFile = path.join(f.stateDir, "state.json"); writeJson(stateFile, { version: 1, jobs });
  assert.equal(f.run("try { updateState(workspace,s=>{s.config.test=true;}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }").ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, jobs);
  for (const job of jobs) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.jobsDir, `${job.id}.json`), "utf8")), job);
    assert.equal(fs.readFileSync(path.join(f.jobsDir, `${job.id}.log`), "utf8"), "log evidence");
  }
});

for (const damage of ["completedAt", "invalid-stop-proof", "false-lease", "empty-lease"]) {
  for (const action of ["prune", "remove"]) test(`macOS ${action} preserves terminal records with ${damage}`, macOnly, t => {
    const f = fixture(t); assert.equal(migrate(f).ok, true);
    const epoch = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
    const old = { id: "old", status: "completed", createdAt: "2020-01-01", updatedAt: "2020-01-01", epoch,
      terminationPending: false, grokPromptState: "terminal", completedAt: "2020-01-02", logFile: path.join(f.jobsDir, "old.log") };
    const detail = { ...old };
    if (damage === "completedAt") detail.completedAt = "2020-01-03";
    if (damage === "invalid-stop-proof") Object.assign(old, { workerStopConfirmed: true, workerStopProof: "fabricated" }), Object.assign(detail, old);
    if (damage === "false-lease") old.workerLease = detail.workerLease = false;
    if (damage === "empty-lease") old.workerLease = detail.workerLease = "";
    const evidence = files(f, old, detail);
    const newer = Array.from({ length: 50 }, (_, i) => ({ id: `new-${i}`, status: "completed", createdAt: "2021-01-01",
      updatedAt: `2021-${String(i + 1).padStart(2, "0")}`, epoch, terminationPending: false, grokPromptState: "terminal" }));
    for (const job of newer) files(f, job, job);
    const stateFile = path.join(f.stateDir, "state.json"); writeJson(stateFile, { version: 1, jobs: [old, ...newer] });
    const beforeDetail = fs.readFileSync(evidence.detailFile, "utf8");
    const result = f.run(`try { updateState(workspace,s=>{${action === "remove" ? "s.jobs=s.jobs.filter(j=>j.id!=='old');" : "s.config.test=true;"}}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }`);
    assert.equal(result.ok, action !== "remove");
    assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.some(job => job.id === "old"));
    unchanged(evidence.detailFile, beforeDetail); unchanged(evidence.logFile, "log evidence");
  });
}

test("macOS retains terminal records with matching released-lease evidence", macOnly, t => {
  const f = fixture(t); assert.equal(migrate(f).ok, true);
  const epoch = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
  const jobs = Array.from({ length: 51 }, (_, i) => ({ id: `job-${i}`, status: "completed", createdAt: "2020-01-01",
    startedAt: "2020-01-02", completedAt: "2020-01-03", updatedAt: `2020-${String(i + 1).padStart(2, "0")}`,
    epoch, terminationPending: false, grokPromptState: "terminal", pid: null, workerLease: null,
    processStartKey: "darwin-lstart-utc-v1:Thu Jan  2 00:00:00 2020", workerStopConfirmed: true,
    workerStopProof: "darwin-lease-released", workerStopLeaseId: `11111111-1111-4111-8111-${i.toString(16).padStart(12, "0")}`,
    workerStopProcessStartKey: "darwin-lstart-utc-v1:Thu Jan  2 00:00:00 2020", logFile: path.join(f.jobsDir, `job-${i}.log`) }));
  for (const job of jobs) files(f, job, job);
  const stateFile = path.join(f.stateDir, "state.json"); writeJson(stateFile, { version: 1, jobs });
  assert.equal(f.run("try { updateState(workspace,s=>{s.config.test=true;}); console.log(JSON.stringify({ok:true})); } catch(e) { console.log(JSON.stringify({ok:false,error:e.message})); }").ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, jobs);
  for (const job of jobs) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.jobsDir, `${job.id}.json`), "utf8")), job);
    assert.equal(fs.readFileSync(path.join(f.jobsDir, `${job.id}.log`), "utf8"), "log evidence");
  }
});
