import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// 故障条件: lease を両記録へ公開せず agent を起動する、旧 protocol のまま起動する。
// Mac では procfs・mount・start tick・flock・abstract socket を模擬する。
// その結果は Linux kernel・namespace・durability の実証ではない。
test("Linux task publishes its worker lease before running (Mac: simulated Linux)", { skip: !["linux", "darwin"].includes(process.platform), timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-lease-integration-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data;
  delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const agentPidFile = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned"), wrapper = path.join(root, "fake-grok");
  const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_AGENT_PID: agentPidFile, GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker };
  delete env.PLUGIN_DATA;
  if (process.platform === "darwin") {
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim();
    env.GROK_LINUX_SIM_ROOT = root;
    env.GROK_LINUX_SIM_STATE_DIR = stateDir;
  }
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  let worker, closed, migrated = false, markerBeforeLegacy;
  t.after(async () => {
    try {
      if (worker) {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await closed;
      }
      if (markerBeforeLegacy !== undefined) fs.writeFileSync(path.join(stateDir, "state.lock", "protocol.json"), markerBeforeLegacy);
      // fake agent は worker の子だが、worker 終了だけを agent 終了の根拠にしない。
      let agentStopped = !worker || (process.platform === "darwin" && !fs.existsSync(spawnMarker));
      const agentPid = fs.existsSync(agentPidFile) ? Number(fs.readFileSync(agentPidFile, "utf8")) : null;
      if (Number.isInteger(agentPid) && agentPid > 0) {
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          try { process.kill(agentPid, 0); }
          catch (error) { if (error.code === "ESRCH") { agentStopped = true; break; } throw error; }
          if (process.platform === "linux") {
            try { if (/^\d+ \(.*\) [ZXx] /.test(fs.readFileSync(`/proc/${agentPid}/stat`, "utf8"))) { agentStopped = true; break; } }
            catch (error) { if (error.code === "ENOENT") { agentStopped = true; break; } throw error; }
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (migrated && agentStopped) {
        const stopped = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stopped.status, 0, stopped.stderr);
      }
      else if (migrated) t.diagnostic(`Retained sentinel and fixture because agent exit was not confirmed: ${data}`);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(migration.status, 0, migration.stderr);
  migrated = true;
  worker = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "lease integration"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr += chunk; });
  closed = new Promise(resolve => worker.once("close", resolve));
  const stateFile = path.join(stateDir, "state.json");
  let job;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      job = state.jobs.find(entry => entry.status === "running");
      if (job && fs.existsSync(agentPidFile)) break;
    }
    if (worker.exitCode !== null || worker.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(job && fs.existsSync(agentPidFile), `task did not start its agent: ${stderr}`);
  const detail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  assert.ok(job.workerLease, "running worker must publish a lease before starting the agent");
  assert.match(job.claimToken, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.match(job.epoch, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(job.workerLease.stateGeneration, job.epoch);
  assert.ok(path.relative(stateDir, job.workerLease.path).startsWith(`worker-leases-v1${path.sep}${job.epoch}${path.sep}`));
  assert.deepEqual(detail.workerLease, job.workerLease);
  assert.equal(detail.claimToken, job.claimToken);
  assert.equal(detail.epoch, job.epoch);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).protocol,
    "posix-linux-worker-lease-v6");
  const status = spawnSync(process.execPath, [command, "status", "--cwd", workspace, "--json"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(entry => entry.id === job.id).status, "running");

  if (process.platform === "darwin") {
    // 実 worker を終了させた後、同じ PID・tick・argv の別個体を procfs に注入する。
    // これは PID 再利用の模擬であり、実 kernel の PID 再利用ではない。
    worker.kill("SIGKILL");
    await closed;
    const reusedEnv = { ...env, GROK_LINUX_SIM_REUSED_PID: String(job.pid) };
    const cancel = spawnSync(process.execPath, [command, "cancel", "--cwd", workspace, "--json", job.id],
      { env: reusedEnv, encoding: "utf8", timeout: 20000 });
    assert.notEqual(cancel.status, 0, "agent/turn stop is independently unconfirmed");
    const pending = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(entry => entry.id === job.id);
    assert.equal(pending.terminationPending, true);
    assert.notEqual(pending.workerStopProof, "process-exited", "reused PID/tick is not a worker stop proof");
    if (pending.workerStopConfirmed) {
      assert.equal(pending.workerStopProof, "linux-lease-released");
      assert.equal(pending.workerStopLeaseId, job.workerLease.id);
    }

    // 両保存先に同じ古い世代を置いた場合も、ledger の claim と一致しなければ
    // queued の年齢や PID から終了を推測せず原本を保つ。
    const detailPath = path.join(stateDir, "jobs", `${job.id}.json`);
    const originalState = fs.readFileSync(stateFile, "utf8"), originalDetail = fs.readFileSync(detailPath, "utf8");
    const staleState = JSON.parse(originalState), staleDetail = JSON.parse(originalDetail);
    const stalePatch = { createdAt: "2000-01-01T00:00:00.000Z", claimToken: "11111111-1111-4111-8111-111111111111",
      status: "queued", pid: null, processStartKey: null, startedAt: null, terminationPending: false };
    Object.assign(staleState.jobs.find(entry => entry.id === job.id), stalePatch);
    Object.assign(staleDetail, stalePatch);
    const stateText = JSON.stringify(staleState), detailText = JSON.stringify(staleDetail);
    fs.writeFileSync(stateFile, stateText); fs.writeFileSync(detailPath, detailText);
    try {
      const staleStatus = spawnSync(process.execPath, [command, "status", "--cwd", workspace, "--json"],
        { env: reusedEnv, encoding: "utf8", timeout: 15000 });
      assert.notEqual(staleStatus.status, 0, "status must reject records from an old claim");
      assert.equal(fs.readFileSync(stateFile, "utf8"), stateText);
      assert.equal(fs.readFileSync(detailPath, "utf8"), detailText);
    } finally { fs.writeFileSync(stateFile, originalState); fs.writeFileSync(detailPath, originalDetail); }
  }

  // v3 を読める旧 runtime が同居できる marker は、新 runtime が拒否し保全する。
  // この marker は同一 fixture 内で作る模擬 v3 で、移行手順全体の検証ではない。
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  await closed;
  const marker = path.join(stateDir, "state.lock", "protocol.json");
  markerBeforeLegacy = fs.readFileSync(marker, "utf8");
  const legacy = { ...JSON.parse(markerBeforeLegacy), protocol: "posix-linux-sentinel-v3" };
  const legacyText = `${JSON.stringify(legacy)}\n`;
  fs.writeFileSync(marker, legacyText);
  const stateBeforeLegacy = fs.readFileSync(stateFile, "utf8"), detailBeforeLegacy = fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8");
  const refused = spawnSync(process.execPath, [command, "status", "--cwd", workspace, "--json"], { env, encoding: "utf8", timeout: 15000 });
  assert.notEqual(refused.status, 0, "new runtime must refuse a v3 barrier");
  assert.equal(fs.readFileSync(marker, "utf8"), legacyText);
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBeforeLegacy);
  assert.equal(fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8"), detailBeforeLegacy);
});

test("simulated Linux CLI refuses a live legacy v3 barrier without changing records", { skip: process.platform !== "darwin", timeout: 45000 }, t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-legacy-cli-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data;
  delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir };
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let original, migrated = false;
  t.after(() => {
    try {
      if (original !== undefined) fs.writeFileSync(path.join(stateDir, "state.lock", "protocol.json"), original);
      if (migrated) {
        const stopped = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stopped.status, 0, stopped.stderr);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  const first = spawnSync(process.execPath, [command, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(first.status, 0, first.stderr);
  migrated = true;
  const marker = path.join(stateDir, "state.lock", "protocol.json");
  original = fs.readFileSync(marker, "utf8");
  const legacyText = `${JSON.stringify({ ...JSON.parse(original), protocol: "posix-linux-sentinel-v3" })}\n`;
  fs.writeFileSync(marker, legacyText);
  const before = fs.readdirSync(path.join(stateDir, "state.lock")).sort();
  const observed = spawnSync(process.execPath, [command, "status", "--cwd", workspace, "--json"], { env, encoding: "utf8", timeout: 15000 });
  assert.notEqual(observed.status, 0, "v4 must refuse v3 while the old sentinel is live");
  const attempted = spawnSync(process.execPath, [command, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.notEqual(attempted.status, 0, "a live v3 barrier must not be replaced");
  assert.equal(fs.readFileSync(marker, "utf8"), legacyText);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "state.lock")).sort(), before);
});

test("simulated Linux interrupted marker publication remains fail-closed on explicit retry", { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-crashed-migration-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data;
  delete process.env.PLUGIN_DATA;
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    t.diagnostic(`Interrupted migration fixture retained: ${root}`);
  });
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir };
  const args = [command, "state-lock", "migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  // bootstrap 自体を marker の公開直前で終了させる。FD・プロセス状態は模擬。
  const interrupted = spawnSync(process.execPath, args, { env: { ...env, GROK_LINUX_SIM_ABORT_MARKER: "1" }, encoding: "utf8", timeout: 15000 });
  assert.notEqual(interrupted.status, 0);
  const barrier = path.join(stateDir, "state.lock");
  assert.equal(fs.existsSync(path.join(barrier, "protocol.json")), false);
  const entries = fs.readdirSync(barrier).sort();
  assert.ok(entries.some(name => name.startsWith("prepared-")));
  // 派生 sentinel に signal は送らず、その自然終了を確認してから再試行する。
  const fixturePids = fs.readdirSync(registry).map(name => Number(name.replace(/\.json$/, ""))).filter(Number.isSafeInteger);
  const deadline = Date.now() + 8000;
  let active = [];
  do {
    active = fixturePids.filter(pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    });
    if (active.length) await new Promise(resolve => setTimeout(resolve, 20));
  } while (active.length && Date.now() < deadline);
  assert.deepEqual(active, [], `fixture processes still exist; retained ${root}`);
  const retry = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 15000 });
  assert.notEqual(retry.status, 0, "incomplete barrier must not be initialized as a fresh generation");
  assert.equal(fs.existsSync(path.join(barrier, "protocol.json")), false);
  assert.deepEqual(fs.readdirSync(barrier).sort(), entries);
});

test("simulated Linux CLI retains worker lease after output until process exit", { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-worker-lifetime-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), release = path.join(root, "release-worker"), agentPidFile = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
  const observer = fileURLToPath(new URL("./fixtures/linux-cli-lease-observer.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPidFile, GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker,
    GROK_LINUX_SIM_COMPLETE: "1", GROK_LINUX_SIM_HOLD_OUTPUT: "1", GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1",
    GROK_COMPANION_SESSION_ID: "lifetime-fixture" };
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let migrated = false, worker, closed;
  t.after(async () => {
    try {
      if (worker) {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await closed;
      }
      let agentStopped = !worker || !fs.existsSync(spawnMarker);
      if (fs.existsSync(agentPidFile)) {
        const pid = Number(fs.readFileSync(agentPidFile, "utf8")), deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === "ESRCH") { agentStopped = true; break; } throw error; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (migrated && agentStopped) {
        const stopped = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stopped.status, 0, stopped.stderr);
      } else if (migrated) t.diagnostic(`Retained sentinel; agent exit is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      t.diagnostic(`Worker lifetime fixture retained: ${root}`);
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  worker = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "finish then hold"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  worker.stdout.on("data", chunk => { stdout += chunk; }); worker.stderr.on("data", chunk => { stderr += chunk; });
  closed = new Promise(resolve => worker.once("close", resolve));
  const deadline = Date.now() + 20000;
  let output;
  while (!output && worker.exitCode === null && Date.now() < deadline) {
    try { output = JSON.parse(stdout); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(output?.jobId, `CLI did not output its result: ${stderr}`);
  assert.equal(worker.exitCode, null, "fixture worker must remain alive after output");
  const jobId = output.jobId;
  const observe = () => {
    const result = spawnSync(process.execPath, [observer, workspace, jobId], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(observe().status, "unknown", "live worker must retain its lease after output");
  const candidate = () => spawnSync(process.execPath, [command, "task-resume-candidate", "--cwd", workspace, "--json"],
    { env, encoding: "utf8", timeout: 15000 });
  const whileAlive = candidate();
  if (whileAlive.status === 0) assert.equal(JSON.parse(whileAlive.stdout).available, false, "a live worker is not a stopped resume candidate");
  else assert.match(whileAlive.stderr, /worker|lease|pending|unavailable/i);
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  await closed;
  assert.equal(worker.exitCode, 0, stderr);
  assert.equal(observe().status, "available", "worker exit must release its lease");
  const afterExit = candidate();
  assert.equal(afterExit.status, 0, afterExit.stderr);
  assert.equal(JSON.parse(afterExit.stdout).candidate?.id, jobId);
});
