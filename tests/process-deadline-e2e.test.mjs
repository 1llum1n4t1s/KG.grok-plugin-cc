import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { withStateSnapshot, readJobFile, resolveJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "../plugins/grok/scripts/lib/linux-lease-ledger.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

const processModule = new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).href;
const trackedJobsModule = new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url).href;
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;

// 外側の実プロセスにも watchdog を置く。故障注入の子は自力でも有限時間で終了する。
function runWorker(source, timeout, options = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { performance } from "node:perf_hooks";
    import { getProcessSnapshot, inspectTrackedJobProcess, processCommandContains,
      runCommand, terminateProcessTree, waitForTrackedJobExit } from ${JSON.stringify(processModule)};
    ${source}
  `], { ...options, encoding: "utf8", shell: false, windowsHide: true, timeout });
  assert.equal(result.error, undefined, result.stderr || result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const stalledCommand = `
  const calls = [];
  function runStalled(command, args, options) {
    const begin = performance.now();
    const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], options);
    calls.push({ command, timeout: options.timeout, elapsed: performance.now() - begin,
      error: result.error?.code ?? null, signal: result.signal });
    return result;
  }
`;

test("an explicit command deadline terminates a real waiting child process", () => {
  const effect = runWorker(`
    const begin = performance.now();
    const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"],
      { shell: false, timeout: 100 });
    console.log(JSON.stringify({ elapsed: performance.now() - begin, error: result.error?.code ?? null }));
  `, 2500);
  assert.equal(effect.error, "ETIMEDOUT");
  assert.ok(effect.elapsed < 1500, JSON.stringify(effect));
  console.log(JSON.stringify({ scenario: "explicit-command", ...effect }));
});

test("Windows process-tree shutdown works with a PATH longer than the CMD limit",
  { skip: process.platform !== "win32" }, () => {
    const effect = runWorker(`
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      const path = await import("node:path");
      process.env.PATH = Array(250).fill(path.join(process.env.TEMP,
        "nonexistent-long-path-entry")).join(";") + ";" + path.join(process.env.SystemRoot, "System32");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],
        { windowsHide: true, stdio: "ignore" });
      await once(child, "spawn");
      const exited = once(child, "exit");
      let outcome;
      try { outcome = terminateProcessTree(child.pid); }
      finally {
        if (!outcome?.delivered) child.kill();
        await exited;
      }
      console.log(JSON.stringify({ pathLength: process.env.PATH.length,
        delivered: outcome.delivered, exitCode: child.exitCode }));
    `, 6000);
    assert.ok(effect.pathLength > 8191);
    assert.equal(effect.delivered, true);
    assert.notEqual(effect.exitCode, null);
    console.log(JSON.stringify({ scenario: "long-path-shutdown", ...effect }));
  });

test("snapshot and marker lookups bound real stalled external processes", () => {
  const effect = runWorker(`${stalledCommand}
    const snapshot = getProcessSnapshot(process.pid, { platform: "win32", runCommandImpl: runStalled });
    const marker = processCommandContains(process.pid, "grok-companion.mjs",
      { platform: "win32", runCommandImpl: runStalled });
    console.log(JSON.stringify({ snapshot, marker, calls }));
  `, 10000);
  assert.equal(effect.snapshot, null);
  assert.equal(effect.marker, false);
  assert.equal(effect.calls.length, 2);
  for (const call of effect.calls) {
    assert.equal(call.command, "powershell.exe");
    assert.equal(call.error, "ETIMEDOUT");
    assert.ok(call.timeout > 0 && call.timeout <= 3000, JSON.stringify(call));
    assert.ok(call.elapsed < 4500, JSON.stringify(call));
  }
  console.log(JSON.stringify({ scenario: "lookup-timeouts", ...effect }));
});

test("identity retries and exit waiting share their real elapsed-time budgets", () => {
  const effect = runWorker(`${stalledCommand}
    const options = { platform: "win32", runCommandImpl: runStalled };
    let begin = performance.now();
    const identity = inspectTrackedJobProcess(process.pid, "win32-filetime:133000000000000000", options);
    const identityElapsed = performance.now() - begin;
    const identityCalls = calls.splice(0);
    begin = performance.now();
    const exited = waitForTrackedJobExit(process.pid, "win32-filetime:133000000000000000", options);
    console.log(JSON.stringify({ identity, identityElapsed, identityCalls,
      exited, exitElapsed: performance.now() - begin, exitCalls: calls }));
  `, 12000);
  assert.equal(effect.identity, "unavailable");
  assert.equal(effect.exited, false);
  assert.ok(effect.identityCalls.length >= 1 && effect.identityCalls.length <= 3);
  assert.ok(effect.exitCalls.length >= 2 && effect.exitCalls.length <= 6);
  assert.ok(effect.identityElapsed < 4500, JSON.stringify(effect));
  assert.ok(effect.exitElapsed < 6500, JSON.stringify(effect));
  assert.ok(effect.exitCalls[1].timeout < 2200, JSON.stringify(effect));
  for (const call of [...effect.identityCalls, ...effect.exitCalls]) {
    assert.equal(call.error, "ETIMEDOUT");
  }
  console.log(JSON.stringify({ scenario: "cumulative-budgets", ...effect }));
});

test("tracked startup refuses to start a job after three bounded real lookup failures", t => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "process-deadline-"));
  const created = fs.lstatSync(root);
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  let workerStarted = false, effect;
  t.after(() => {
    if (process.platform === "linux") {
      if (!workerStarted || !effect) throw new Error(`Worker or migration completion unconfirmed; fixture retained: ${root}`);
      const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
      process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = "";
      try {
        assert.equal(effect.calls.length, 3);
        for (const call of effect.calls) assert.ok(call.error === "ETIMEDOUT" && call.signal, "stalled child exit is unconfirmed");
        assert.equal(path.resolve(effect.stateDir), effect.stateDir);
        assert.match(effect.epoch, /^[0-9a-f-]{36}$/i);
        const marker = JSON.parse(fs.readFileSync(path.join(effect.stateDir, "state.lock", "protocol.json"), "utf8"));
        assert.equal(marker.epoch, effect.epoch);
        withStateSnapshot(workspace, (state, context) => {
          assert.equal(context.stateDir, effect.stateDir);
          assert.equal(context.epoch, effect.epoch);
          const indexed = state.jobs.find(job => job.id === "deadline-fixture");
          const stored = readJobFile(resolveJobFile(workspace, "deadline-fixture", context.stateDir));
          assert.ok(indexed?.workerLease && stored?.workerLease, "worker lease records are unavailable");
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
          const observed = withAvailableLinuxLease(indexed.workerLease, context, () => {
            verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
            return true;
          });
          assert.equal(observed.status, "available", "worker lease release is unconfirmed");
        });
        const stopped = shutdownPosixStateLockSentinel(effect.stateDir, { offlineConfirmed: true, expectedStateDir: effect.stateDir });
        assert.equal(stopped.stopped, true); assert.equal(stopped.epoch, effect.epoch); assert.equal(stopped.stateDir, effect.stateDir);
      } catch (error) { throw new Error(`Worker or sentinel termination unconfirmed; fixture retained: ${root}`, { cause: error }); }
      finally {
        if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
        if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
      }
    }
    const current = fs.lstatSync(root);
    assert.equal(path.dirname(root), parent);
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, created.dev); assert.equal(current.ino, created.ino);
    fs.rmSync(root, { recursive: true, force: true });
  });
  workerStarted = true;
  effect = runWorker(`${stalledCommand}
    const { runTrackedJob } = await import(${JSON.stringify(trackedJobsModule)});
    const { migrateStateLock, resolveStateDir, resolveJobFile, readJobFile } = await import(${JSON.stringify(stateModule)});
    const workspaceRoot = process.cwd();
    const stateDir = resolveStateDir(workspaceRoot);
    const migration = migrateStateLock(workspaceRoot, { offlineConfirmed: true, localOnly: true,
      expectedStateDir: stateDir });
    const job = { id: "deadline-fixture", workspaceRoot, jobClass: "review", title: "Review" };
    const begin = performance.now();
    let error;
    try {
      await runTrackedJob(job, () => assert.fail("unverified job must not start"), {
        getProcessSnapshotImpl(pid) {
          return getProcessSnapshot(pid, { platform: "win32", runCommandImpl: runStalled });
        }
      });
    } catch (failure) { error = failure.message; }
    const elapsed = performance.now() - begin;
    const status = process.platform === "win32" ? null : readJobFile(resolveJobFile(workspaceRoot, job.id)).status;
    console.log(JSON.stringify({ error, elapsed, calls, status, stateDir, epoch: migration.epoch }));
  `, 20000, { cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: "" } });
  assert.match(effect.error, /Cannot verify the Grok job process identity/);
  if (process.platform !== "win32") assert.equal(effect.status, "queued");
  assert.equal(effect.calls.length, 3);
  assert.ok(effect.elapsed < 11000, JSON.stringify(effect));
  for (const call of effect.calls) assert.equal(call.error, "ETIMEDOUT");
  console.log(JSON.stringify({ scenario: "startup-budget", ...effect }));
});

test("real Windows CIM preserves process identity and retries a transient command failure",
  { skip: process.platform !== "win32" }, () => {
    const effect = runWorker(`
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)",
        "grok-companion.mjs", "日本語の照会"], { windowsHide: true, stdio: "ignore" });
      await once(child, "spawn");
      let effect, startKey;
      try {
        const begin = performance.now();
        const timings = {};
        const measure = (name, operation) => {
          const started = performance.now();
          try { return operation(); } finally { timings[name] = performance.now() - started; }
        };
        const snapshot = measure("snapshot", () => getProcessSnapshot(child.pid));
        assert.ok(snapshot?.startKey);
        assert.ok(snapshot.commandLine.includes("日本語の照会"));
        startKey = snapshot.startKey;
        const differentKey = "win32-filetime:" + (BigInt(startKey.slice("win32-filetime:".length)) + 1n).toString();
        const match = measure("match", () => inspectTrackedJobProcess(child.pid, startKey));
        const mismatch = measure("mismatch", () => inspectTrackedJobProcess(child.pid, differentKey));
        const invalid = inspectTrackedJobProcess(child.pid, startKey + "-reused");
        let calls = 0;
        const transient = measure("transient", () => inspectTrackedJobProcess(child.pid, startKey, {
          runCommandImpl(command, args, options) {
            calls += 1;
            return calls === 1
              ? runCommand(process.execPath, ["-e", "process.exit(1)"], options)
              : runCommand(command, args, options);
          }
        }));
        effect = { match, mismatch, invalid, transient, calls, elapsed: performance.now() - begin, timings, childPid: child.pid };
      } finally {
        child.kill();
        await once(child, "exit");
      }
      const exitStarted = performance.now();
      effect.exited = waitForTrackedJobExit(child.pid, startKey);
      effect.timings.exit = performance.now() - exitStarted;
      console.log(JSON.stringify(effect));
    `, 12000);
    assert.equal(effect.match, "match");
    assert.equal(effect.mismatch, "mismatch");
    assert.equal(effect.invalid, "unavailable");
    assert.equal(effect.transient, "match");
    assert.equal(effect.calls, 2);
    assert.equal(effect.exited, true);
    console.log(JSON.stringify({ scenario: "real-cim", ...effect }));
  });
