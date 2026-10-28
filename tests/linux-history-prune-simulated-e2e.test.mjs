import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// Mac の実 CLI/worker と一時ファイルを使い、procfs・mount・flock は模擬する。
// Linux kernel、電源断時の durability はこの試験では実証しない。
test("Linux CLI prunes verified old history and preserves unverified records", {
  skip: process.platform !== "darwin", timeout: 1800000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-prune-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), stateFile = path.join(stateDir, "state.json");
  const jobsDir = path.join(stateDir, "jobs");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    SETTINGS_LOG: path.join(root, "settings.log"), SETTINGS_READY: path.join(root, "agent-ready"),
    SETTINGS_RELEASE: path.join(root, "agent-release"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  const lockArgs = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let migrated = false, allStopped = true, verifiedDone = false;
  t.after(() => {
    try {
      if (migrated && allStopped) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...lockArgs], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
        else t.diagnostic(`Retained failed history fixture for inspection: ${root}`);
      } else if (migrated) t.diagnostic(`Retained fixture because agent exit is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const migrate = spawnSync(process.execPath, [command, "state-lock", "migrate", ...lockArgs], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrate.status, 0, migrate.stderr); migrated = true;
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const readDetail = id => JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), "utf8"));
  function task(i) {
    const exited = path.join(root, `agent-exit-${i}`);
    allStopped = false;
    const result = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", `history task ${i}`],
      { env: { ...env, SETTINGS_EXIT: exited, GROK_COMPANION_SESSION_ID: i === 2 ? "history-distinct-session" : "history-baseline-session" },
        encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `task ${i}: ${result.stderr}\n${result.stdout}`);
    assert.ok(fs.existsSync(exited), `task ${i}: direct agent exit must be observed`);
    allStopped = true;
  }
  function reclaimLeases() {
    // 実 worker 全終了後に検証用操作で slot をまとめて回収する。
    allStopped = false;
    const reclaim = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 75000 });
    assert.equal(reclaim.status, 0, reclaim.stderr);
    allStopped = true;
    return JSON.parse(reclaim.stdout);
  }
  for (let i = 0; i < 50; i++) task(i);
  assert.equal(reclaimLeases().reclaimed, 50, "all 50 stopped worker leases must be reclaimed");
  const verified = state().jobs.filter(job => job.status === "completed" && job.workerLease == null &&
    job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released");
  assert.equal(verified.length, 50, "50 terminal jobs must have independently reclaimed leases");
  const oldest = [...verified].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
  const oldestDetail = readDetail(oldest.id);
  assert.equal(oldestDetail.workerStopLeaseId, oldest.workerStopLeaseId);
  // 検証済み記録に大きな本文を付けても、停止証拠が一致すれば回収できる。
  fs.writeFileSync(path.join(jobsDir, `${oldest.id}.json`), `${JSON.stringify({ ...oldestDetail, fixturePadding: "x".repeat(2 * 1024 * 1024) }, null, 2)}\n`, { mode: 0o600 });
  const oldestLog = oldest.logFile;
  assert.equal(oldestLog, path.join(jobsDir, `${oldest.id}.log`));
  assert.ok(fs.existsSync(oldestLog));

  // 意図的に不一致・旧 epoch・共有参照を作る異常入力。CLI/worker が全て
  // 終了してから注入し、index への変更中に他の writer を走らせない。
  const ordered = [...verified].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const sharedOwner = ordered[1], sharedDetail = readDetail(sharedOwner.id);
  const oversizedLog = ordered[3];
  const referencedJob = ordered[4];
  assert.equal(oversizedLog.logFile, path.join(jobsDir, `${oversizedLog.id}.log`));
  fs.truncateSync(oversizedLog.logFile, 65 * 1024 * 1024);
  const resumeCandidate = verified.find(job => job.sessionId === "history-distinct-session");
  assert.ok(resumeCandidate?.grokSessionId && resumeCandidate.taskSessionResumable !== false,
    "the distinct session must have an established resumable task");
  const edited = state(), protectedIds = [];
  const originalDetail = { ...readDetail(oldest.id) }; delete originalDetail.fixturePadding;
  for (const kind of ["running", "pending", "unverified", "old-epoch", "shared-log", "source-ref"]) {
    const id = `protected-${kind}`;
    const index = { ...oldest, id, claimToken: randomUUID(), workerStopLeaseId: randomUUID(),
      createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z",
      logFile: path.join(jobsDir, `${id}.log`) };
    const detail = { ...originalDetail, ...index };
    if (kind === "running") index.status = detail.status = "running";
    if (kind === "pending") index.terminationPending = detail.terminationPending = true;
    if (kind === "unverified") detail.workerStopLeaseId = "unverified-lease";
    if (kind === "old-epoch") index.epoch = detail.epoch = "22222222-2222-4222-8222-222222222222";
    if (kind === "shared-log") index.logFile = detail.logFile = sharedOwner.logFile;
    else fs.writeFileSync(index.logFile, `protected ${kind}`, { mode: 0o600, flag: "wx" });
    if (kind === "source-ref") index.fixtureReference = detail.fixtureReference = { nested: { resumeSourceJobId: referencedJob.id } };
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify(detail), { mode: 0o600, flag: "wx" });
    edited.jobs.push(index); protectedIds.push(id);
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(edited, null, 2)}\n`, { mode: 0o600 });
  for (let i = 50; i < 57; i++) task(i);
  for (const id of protectedIds) {
    assert.ok(state().jobs.some(job => job.id === id), `${id} must remain indexed after CLI tasks`);
    assert.ok(fs.existsSync(path.join(jobsDir, `${id}.json`)), `${id} detail must remain after CLI tasks`);
  }
  assert.equal(reclaimLeases().reclaimed, 7, "the additional stopped worker leases must be reclaimed");
  const latest50 = state().jobs.filter(job => job.status === "completed" && job.workerLease == null &&
    job.workerStopProof === "linux-lease-released" && !job.id.startsWith("protected-"))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 50).map(job => job.id);
  assert.equal(latest50.length, 50);
  // 選択した index と detail の間で整理が進んでも、result は一貫した結果か明示 not-found を返す。
  const racePreload = fileURLToPath(new URL("./fixtures/linux-history-result-pause-preload.mjs", import.meta.url));
  const ready = path.join(root, "result-index-read"), releaseResult = path.join(root, "result-release");
  const start = (args, options) => {
    const child = spawn(process.execPath, [command, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, closed };
  };
  allStopped = false;
  const reader = start(["result", "--cwd", workspace, "--json", oldest.id], { env: { ...env,
    GROK_HISTORY_RESULT_TARGET: oldest.id, GROK_HISTORY_RESULT_READY: ready, GROK_HISTORY_RESULT_RELEASE: releaseResult,
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(racePreload)}` } });
  let resultDeadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && reader.child.exitCode === null && Date.now() < resultDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready), "result must pause after reading the candidate index");
  const raceExit = path.join(root, "agent-exit-57"), raceSpawn = path.join(root, "agent-spawn-57");
  const writer = start(["task", "--cwd", workspace, "--json", "history task 57"], { env: { ...env,
    SETTINGS_EXIT: raceExit, GROK_LINUX_SIM_SPAWN_MARKER: raceSpawn, GROK_COMPANION_SESSION_ID: "history-baseline-session" } });
  resultDeadline = Date.now() + 4000;
  while (fs.existsSync(path.join(jobsDir, `${oldest.id}.json`)) && writer.child.exitCode === null && Date.now() < resultDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  t.diagnostic(`Oldest detail removed while result was paused: ${!fs.existsSync(path.join(jobsDir, `${oldest.id}.json`))}`);
  fs.writeFileSync(releaseResult, "release", { flag: "wx", mode: 0o600 });
  const [readResult, writeResult] = await Promise.all([reader.closed, writer.closed]);
  if ((!fs.existsSync(raceSpawn) || fs.existsSync(raceExit)) && reader.child.exitCode !== null && writer.child.exitCode !== null) allStopped = true;
  assert.equal(writeResult.code, 0, writeResult.stderr);
  assert.ok(fs.existsSync(raceExit), "racing agent exit must be observed");
  if (readResult.code === 0) {
    const payload = JSON.parse(readResult.stdout);
    assert.equal(payload.job?.id, oldest.id);
    assert.equal(payload.storedJob?.id, oldest.id, "success must include the selected detail");
  } else assert.match(`${readResult.stderr}\n${readResult.stdout}`, /not found|no job found/i);
  // 保全対象を飛ばして複数の古い候補を整理し、最新 50 件を維持する。
  for (let i = 58; i < 60; i++) task(i);
  const after = state(), retained = new Set(after.jobs.map(job => job.id));
  assert.ok(!after.jobs.some(job => job.id === oldest.id), "the oldest verified terminal job must leave the index");
  assert.ok(!fs.existsSync(path.join(jobsDir, `${oldest.id}.json`)), "its detail must be removed");
  assert.ok(!fs.existsSync(oldestLog), "its private log must be removed");
  assert.ok(retained.has(sharedOwner.id), "an indexed shared-log owner must not be pruned");
  assert.deepEqual(readDetail(sharedOwner.id), sharedDetail);
  assert.ok(fs.existsSync(sharedOwner.logFile), "a shared log must be preserved");
  assert.ok(retained.has(oversizedLog.id), "an oversized log must be preserved while later candidates are considered");
  assert.equal(fs.statSync(oversizedLog.logFile).size, 65 * 1024 * 1024);
  assert.ok(retained.has(referencedJob.id), "a nested job reference must preserve the referenced history");
  assert.ok(retained.has(resumeCandidate.id), "the latest resumable task of another session must remain indexed");
  assert.equal(readDetail(resumeCandidate.id).grokSessionId, resumeCandidate.grokSessionId);
  for (const id of latest50) assert.ok(retained.has(id), `${id} is among the latest 50 verified jobs`);
  for (const id of protectedIds) {
    assert.ok(retained.has(id), `${id} must remain indexed`);
    assert.ok(fs.existsSync(path.join(jobsDir, `${id}.json`)), `${id} detail must remain`);
    if (id !== "protected-shared-log") assert.ok(fs.existsSync(path.join(jobsDir, `${id}.log`)), `${id} log must remain`);
  }
  const eligible = after.jobs.filter(job => verified.some(original => original.id === job.id));
  assert.equal(eligible.length, 47, "three old unprotected verified jobs should have been pruned");
  const resumeExit = path.join(root, "resume-agent-exit"), resumeSpawn = path.join(root, "resume-agent-spawn");
  allStopped = false;
  const resume = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "--resume-last"],
    { env: { ...env, SETTINGS_EXIT: resumeExit, GROK_LINUX_SIM_SPAWN_MARKER: resumeSpawn,
      GROK_COMPANION_SESSION_ID: "history-distinct-session" },
      encoding: "utf8", timeout: 30000 });
  if (!fs.existsSync(resumeSpawn) || fs.existsSync(resumeExit)) allStopped = true;
  assert.notEqual(resume.status, 0, "direct history must not be resumed when the broker is disabled");
  assert.match(`${resume.stderr}\n${resume.stdout}`, /Cannot resume a Grok session with the broker disabled/i);
  assert.ok(state().jobs.some(job => job.id === resumeCandidate.id), "rejected direct resume must preserve its history");

  const beforeConcurrent = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 75000 });
  assert.equal(beforeConcurrent.status, 0, beforeConcurrent.stderr);
  // 独立した 2 worker を agent 起動後に同時に保持し、履歴操作と並行させる。
  const release = path.join(root, "concurrent-release"), concurrent = [];
  allStopped = false;
  for (const name of ["one", "two"]) {
    const ready = path.join(root, `concurrent-${name}-ready`), exited = path.join(root, `concurrent-${name}-exit`);
    const child = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", `concurrent ${name}`], {
      env: { ...env, SETTINGS_GATE: "new", SETTINGS_READY: ready, SETTINGS_RELEASE: release, SETTINGS_EXIT: exited,
        GROK_COMPANION_SESSION_ID: `history-concurrent-${name}` }, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
    concurrent.push({ child, closed, ready, exited });
  }
  const deadline = Date.now() + 20000;
  while (!concurrent.every(item => fs.existsSync(item.ready)) && Date.now() < deadline &&
         concurrent.every(item => item.child.exitCode === null && item.child.signalCode === null)) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(concurrent.every(item => fs.existsSync(item.ready)), "both agents must be running at the same time");
  const running = state().jobs.filter(job => job.status === "running" && job.sessionId?.startsWith("history-concurrent-"));
  assert.equal(running.length, 2);
  for (const job of running) assert.equal(readDetail(job.id).status, "running");
  const during = spawnSync(process.execPath, [sweep, workspace, "1"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(during.status, 0, during.stderr);
  for (const job of running) assert.ok(state().jobs.some(current => current.id === job.id), "a live worker must remain indexed during pruning");
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const finished = await Promise.all(concurrent.map(item => item.closed));
  for (let i = 0; i < concurrent.length; i++) {
    assert.equal(finished[i].code, 0, finished[i].stderr);
    assert.ok(fs.existsSync(concurrent[i].exited), "each concurrent agent exit must be observed");
    assert.ok(state().jobs.some(job => job.id === running[i].id), "concurrent worker history must remain indexed");
  }
  allStopped = true;
  // index が残る一方で detail が欠落した場合は、削除済みの not-found や成功にしない。
  const missingDetail = path.join(jobsDir, `${resumeCandidate.id}.json`), preservedDetail = path.join(root, "preserved-result-detail");
  fs.renameSync(missingDetail, preservedDetail);
  const missingResult = spawnSync(process.execPath, [command, "result", "--cwd", workspace, "--json", resumeCandidate.id],
    { env, encoding: "utf8", timeout: 30000 });
  fs.renameSync(preservedDetail, missingDetail);
  assert.notEqual(missingResult.status, 0, "an indexed but missing detail must fail");
  assert.match(`${missingResult.stderr}\n${missingResult.stdout}`, /unavailable|corrupt|inconsistent|missing/i);
  verifiedDone = true;
});
