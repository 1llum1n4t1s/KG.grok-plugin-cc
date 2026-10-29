import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProcessSnapshot, inspectTrackedJobProcess } from "../plugins/grok/scripts/lib/process.mjs";
import { migrateStateLock, resolveJobFile, resolveStateDir, resolveStateFile, saveState, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";

const script = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

test("status preserves unleased workers regardless of process generation or exit", { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const parent = fs.realpathSync.native(process.env.GROK_STATUS_IDENTITY_TEST_ROOT || os.tmpdir());
  const repository = fs.realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
  const relative = path.relative(repository, parent);
  assert.ok(path.isAbsolute(parent) && (relative === ".." || relative.startsWith(`..${path.sep}`)));
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "status-identity-"));
  const created = fs.lstatSync(root), cwd = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null && child.connected) child.send("exit");
      await child.closed;
    }
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    try {
      const current = fs.lstatSync(root);
      assert.equal(path.dirname(root), parent); assert.equal(fs.realpathSync.native(root), root);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, created.dev); assert.equal(current.ino, created.ino);
      fs.rmSync(root, { recursive: true });
    } catch (error) { t.diagnostic(`Fixture retained or cleanup failed: ${root}`); throw error; }
  });
  const makeChild = async () => {
    const child = spawn(process.execPath, ["-e", "process.send('ready');process.on('message',()=>process.exit(0));setTimeout(()=>process.exit(0),20000)", "grok-companion.mjs"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.closed = new Promise(resolve => child.once("close", resolve));
    children.push(child);
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("close", () => reject(Error("gate exited before ready"))); });
    return child;
  };
  const old = await makeChild();
  const oldKey = getProcessSnapshot(old.pid)?.startKey;
  assert.ok(oldKey?.startsWith("darwin-lstart-utc-v1:"));
  old.send("exit"); await old.closed;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const current = await makeChild();
  const currentKey = getProcessSnapshot(current.pid)?.startKey;
  assert.ok(currentKey && currentKey !== oldKey);
  assert.equal(inspectTrackedJobProcess(current.pid, currentKey), "match");
  assert.equal(inspectTrackedJobProcess(current.pid, oldKey), "mismatch");
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(cwd) });
  const now = new Date().toISOString();
  const job = (id, key, promptState = "not-sent") => ({ id, status: "running", pid: current.pid, processStartKey: key,
    createdAt: now, updatedAt: now, grokPromptState: promptState });
  const conflictPending = { ...job("conflict-pending", oldKey, "pending"), grokSessionId: "turn-a" };
  const conflictMissing = job("conflict-missing", oldKey);
  delete conflictMissing.grokPromptState;
  const conflictSession = { ...job("conflict-session", oldKey), grokSessionId: "turn-a" };
  const missingDetail = job("missing-detail", oldKey);
  const jobs = [job("reused", oldKey, "pending"), job("matching", currentKey), job("legacy", "old-lstart"), job("missing", null),
    conflictPending, conflictMissing, conflictSession, missingDetail];
  saveState(cwd, { version: 1, config: {}, jobs });
  updateState(cwd, () => {
    for (const value of jobs) if (value.id !== missingDetail.id) writeJobFile(cwd, value.id, value);
    writeJobFile(cwd, conflictPending.id, { ...conflictPending, grokPromptState: "not-sent" });
    writeJobFile(cwd, conflictMissing.id, { ...conflictMissing, grokPromptState: "not-sent" });
    writeJobFile(cwd, conflictSession.id, { ...conflictSession, grokSessionId: "turn-b" });
  });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CODEX_THREAD_ID: "", GROK_COMPANION_SESSION_ID: "" };
  const preload = path.join(root, "lookup-failure.cjs");
  fs.writeFileSync(preload, `const fs=require('node:fs'), cp=require('node:child_process'), original=cp.spawnSync, kill=process.kill;
    cp.spawnSync=function(command,args,options) {
      if(command==='ps') {
        if(process.env.STATUS_TRACE_PATH) fs.appendFileSync(process.env.STATUS_TRACE_PATH,'ps\\n');
        if(process.env.STATUS_FAULT==='malformed' && args.includes('lstart=')) return {status:0,stdout:'not-a-date\\n',stderr:''};
        if(process.env.STATUS_FAULT==='malformed' && args.includes('command=')) return {status:0,stdout:'node grok-companion.mjs\\n',stderr:''};
        return {status:1,stdout:'',stderr:''};
      }
      return original.call(this,command,args,options);
    };
    process.kill=function(pid,signal) {
      if(pid===Number(process.env.STATUS_FAULT_PID) && signal===0) {
        if(process.env.STATUS_TRACE_PATH) fs.appendFileSync(process.env.STATUS_TRACE_PATH,'kill-0\\n');
        if(process.env.STATUS_FAULT==='eio') throw Object.assign(Error('fixture lookup failed'),{code:'EIO'});
      }
      return kill.call(this,pid,signal);
    };
    require('node:module').syncBuiltinESMExports();`);
  const unstartedCwd = path.join(root, "unmigrated-workspace"), unstartedData = path.join(root, "unmigrated-data");
  fs.mkdirSync(unstartedCwd); fs.mkdirSync(unstartedData);
  process.env.CLAUDE_PLUGIN_DATA = unstartedData;
  try {
    const stateFile = resolveStateFile(unstartedCwd);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [jobs[0]] }), { mode: 0o600 });
  }
  finally { process.env.CLAUDE_PLUGIN_DATA = data; }
  const trace = path.join(root, "unmigrated-lookup-trace");
  const blocked = spawnSync(process.execPath, ["--require", preload, script, "status", "--json", "--all"], {
    cwd: unstartedCwd, env: { ...env, CLAUDE_PLUGIN_DATA: unstartedData, STATUS_TRACE_PATH: trace }, encoding: "utf8"
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /explicit offline migration/);
  assert.equal(fs.existsSync(trace), false, "unverified state must not trigger a PID lookup");
  const stateBefore = fs.readFileSync(resolveStateFile(cwd), "utf8");
  const detailsBefore = new Map(jobs.filter(value => value.id !== missingDetail.id)
    .map(value => [value.id, fs.readFileSync(resolveJobFile(cwd, value.id), "utf8")]));
  // 旧 unleased 記録では lookup 自体を呼ばないため、fault は発火しない。
  for (const fault of ["eio", "malformed"]) {
    const faultTrace = path.join(root, `unleased-${fault}-lookup-trace`);
    const check = spawnSync(process.execPath, ["--require", preload, script, "status", "--json", "--all"], {
      cwd, env: { ...env, STATUS_FAULT: fault, STATUS_FAULT_PID: String(current.pid), STATUS_TRACE_PATH: faultTrace }, encoding: "utf8"
    });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(fs.existsSync(faultTrace), false, `${fault}: unleased status must not invoke process lookup`);
    assert.ok(JSON.parse(check.stdout).running.some(value => value.id === "matching" && value.status === "running"), `${fault}: unleased worker must remain unconfirmed`);
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--require", preload, script, "status", "--json", "--all"], { cwd, env: { ...env, STATUS_TRACE_PATH: trace }, encoding: "utf8" });
  t.diagnostic(`status with two verifiable live records: ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.running.some(value => value.id === "matching"));
  assert.ok(report.running.some(value => value.id === "legacy"));
  assert.ok(report.running.some(value => value.id === "missing"));
  for (const job of jobs) assert.ok(report.running.some(value => value.id === job.id && value.status === "running"), `${job.id} must remain unconfirmed`);
  assert.equal(fs.existsSync(trace), false, "unleased status must not consult PID as stop evidence");
  const storedState = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
  assert.equal(storedState.jobs.find(value => value.id === "conflict-pending").grokPromptState, "pending");
  assert.equal(storedState.jobs.find(value => value.id === "conflict-session").grokSessionId, "turn-a");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(cwd, conflictPending.id), "utf8")).grokPromptState, "not-sent");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(cwd, conflictSession.id), "utf8")).grokSessionId, "turn-b");
  assert.equal(fs.existsSync(resolveJobFile(cwd, missingDetail.id)), false, "missing evidence must not be recreated");
  assert.equal(current.exitCode, null, "status must not stop the unrelated process");
  current.send("exit"); await current.closed;
  const afterExit = spawnSync(process.execPath, ["--require", preload, script, "status", "--json", "--all"], { cwd, env: { ...env, STATUS_TRACE_PATH: trace }, encoding: "utf8" });
  assert.equal(afterExit.status, 0, afterExit.stderr);
  const afterReport = JSON.parse(afterExit.stdout);
  for (const job of jobs) assert.ok(afterReport.running.some(value => value.id === job.id && value.status === "running"), `${job.id} must remain unconfirmed after exit`);
  assert.equal(fs.existsSync(trace), false, "process exit must not trigger PID-based reconciliation");
  assert.equal(fs.readFileSync(resolveStateFile(cwd), "utf8"), stateBefore);
  for (const [id, contents] of detailsBefore) assert.equal(fs.readFileSync(resolveJobFile(cwd, id), "utf8"), contents);
  assert.equal(fs.existsSync(resolveJobFile(cwd, missingDetail.id)), false);
});
