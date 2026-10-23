import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

const processModule = new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).href;
const trackedJobsModule = new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url).href;

// 外側の実プロセスにも watchdog を置く。故障注入の子は自力でも有限時間で終了する。
function runWorker(source, timeout) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { performance } from "node:perf_hooks";
    import { getProcessSnapshot, inspectTrackedJobProcess, processCommandContains,
      runCommand, terminateProcessTree, waitForTrackedJobExit } from ${JSON.stringify(processModule)};
    ${source}
  `], { encoding: "utf8", shell: false, windowsHide: true, timeout });
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
      error: result.error?.code ?? null });
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
    const identity = inspectTrackedJobProcess(process.pid, "unverified-start", options);
    const identityElapsed = performance.now() - begin;
    const identityCalls = calls.splice(0);
    begin = performance.now();
    const exited = waitForTrackedJobExit(process.pid, "unverified-start", options);
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

test("tracked startup refuses to register a job after three bounded real lookup failures", () => {
  const effect = runWorker(`${stalledCommand}
    const { runTrackedJob } = await import(${JSON.stringify(trackedJobsModule)});
    const begin = performance.now();
    let error;
    try {
      await runTrackedJob({}, () => assert.fail("unverified job must not start"), {
        getProcessSnapshotImpl(pid) {
          return getProcessSnapshot(pid, { platform: "win32", runCommandImpl: runStalled });
        }
      });
    } catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ error, elapsed: performance.now() - begin, calls }));
  `, 12500);
  assert.match(effect.error, /Cannot verify the Grok job process identity/);
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
      let effect;
      try {
        const begin = performance.now();
        const snapshot = getProcessSnapshot(child.pid);
        assert.ok(snapshot?.startKey);
        assert.ok(snapshot.commandLine.includes("日本語の照会"));
        const match = inspectTrackedJobProcess(child.pid, snapshot.startKey);
        const mismatch = inspectTrackedJobProcess(child.pid, snapshot.startKey + "-reused");
        let calls = 0;
        const transient = inspectTrackedJobProcess(child.pid, snapshot.startKey, {
          runCommandImpl(command, args, options) {
            calls += 1;
            return calls === 1
              ? runCommand(process.execPath, ["-e", "process.exit(1)"], options)
              : runCommand(command, args, options);
          }
        });
        effect = { match, mismatch, transient, calls, elapsed: performance.now() - begin };
      } finally {
        child.kill();
        await once(child, "exit");
      }
      effect.exited = waitForTrackedJobExit(child.pid, "former-start");
      console.log(JSON.stringify(effect));
    `, 12000);
    assert.equal(effect.match, "match");
    assert.equal(effect.mismatch, "mismatch");
    assert.equal(effect.transient, "match");
    assert.equal(effect.calls, 2);
    assert.equal(effect.exited, true);
    console.log(JSON.stringify({ scenario: "real-cim", ...effect }));
  });
