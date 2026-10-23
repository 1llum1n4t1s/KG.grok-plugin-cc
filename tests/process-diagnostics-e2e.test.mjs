import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const processModule = new URL("../plugins/grok/scripts/lib/process.mjs", import.meta.url).href;
const trackedJobsModule = new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url).href;
const windowsOnly = { skip: process.platform !== "win32" };
const diagnosticPrefix = "[grok] Process lookup diagnostic ";

// 実装前に列挙した失敗条件: 起動未到達の誤分類、CIM前後の混同、共有期限の延長、
// callback例外による判定変更、秘密値の混入、成功時の出力変更、照会子プロセスの残存。
// 故障注入は実PowerShell内の有限sleepであり、自然発生のproviderハングとは区別する。
function runWorker(source, timeout = 12000) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { performance } from "node:perf_hooks";
    import { getProcessSnapshot, processCommandContains, inspectTrackedJobProcess,
      waitForTrackedJobExit, runCommand } from ${JSON.stringify(processModule)};
    ${source}
  `], { encoding: "utf8", shell: false, windowsHide: true, timeout });
  assert.equal(result.error, undefined, result.stderr || result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return { effect: JSON.parse(result.stdout), stderr: result.stderr };
}

const realPowerShell = `
  const records = [];
  const calls = [];
  function runInjected(command, args, options) {
    assert.equal(command, "powershell.exe");
    const changed = [...args];
    const scriptIndex = changed.indexOf("-Command") + 1;
    assert.ok(scriptIndex > 0);
    changed[scriptIndex] = inject(changed[scriptIndex]);
    const begin = performance.now();
    const result = runCommand(command, changed, options);
    calls.push({ timeout: options.timeout, elapsedMs: performance.now() - begin,
      errorCode: result.error?.code ?? null });
    return result;
  }
  const lookupOptions = { runCommandImpl: runInjected,
    onProcessLookupDiagnostic(record) { records.push(record); } };
`;

function assertTimeout(record, phase) {
  assert.equal(record.event, "process-lookup");
  assert.equal(record.errorCode, "ETIMEDOUT");
  assert.equal(record.lastPhase, phase);
  assert.ok(record.timeoutMs > 0 && record.timeoutMs <= 3000, JSON.stringify(record));
  assert.ok(record.elapsedMs < 4500, JSON.stringify(record));
  assert.ok(Array.isArray(record.phases));
  for (const pid of new Set(record.phases.map(entry => entry.pid))) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, "ESRCH"); continue; }
    // Windows は終了済み PID を再利用するため、生存中なら開始時刻で元の照会と区別する。
    // 待機や終了操作は行わず、同一プロセスが残っていれば引き続き失敗させる。
    const identity = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop';
      $p = $null;
      try {
        try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); }
        catch [System.ArgumentException] { 'null'; exit 0; }
        if ($p.HasExited) { 'null'; }
        else { @{ startUtc = $p.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress; }
      } finally { if ($null -ne $p) { $p.Dispose(); } }
    `], { encoding: "utf8", shell: false, windowsHide: true, timeout: 3000 });
    assert.equal(identity.error, undefined, identity.error?.message);
    assert.equal(identity.status, 0, identity.stderr);
    const current = JSON.parse(identity.stdout);
    const lastObservedAt = Math.max(...record.phases.filter(entry => entry.pid === pid)
      .map(entry => Date.parse(entry.atUtc)));
    assert.ok(current === null || Date.parse(current.startUtc) > lastObservedAt,
      `lookup child must have exited: ${JSON.stringify({ record, pid, current })}`);
  }
}

function diagnosticRecords(stderr) {
  return stderr.split(/\r?\n/).filter(line => line.startsWith(diagnosticPrefix))
    .map(line => JSON.parse(line.slice(diagnosticPrefix.length)));
}

test("real Windows CIM preserves Unicode snapshot and marker results without diagnostics", windowsOnly, () => {
  const { effect, stderr } = runWorker(`
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const marker = "診断E2E_日本語_marker";
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)", marker],
      { windowsHide: true, stdio: "ignore" });
    await once(child, "spawn");
    const exited = once(child, "exit");
    const records = [];
    let effect;
    try {
      const options = { onProcessLookupDiagnostic(record) { records.push(record); } };
      const snapshot = getProcessSnapshot(child.pid, options);
      assert.ok(snapshot?.startKey);
      assert.ok(snapshot.commandLine.includes(marker));
      effect = { markerFound: processCommandContains(child.pid, marker, options),
        markerAbsent: processCommandContains(child.pid, "absent-marker", options), records };
    } finally { child.kill(); await exited; }
    console.log(JSON.stringify(effect));
  `);
  assert.equal(effect.markerFound, true);
  assert.equal(effect.markerAbsent, false);
  assert.deepEqual(effect.records, []);
  assert.equal(stderr, "");
});

test("real PowerShell CIM sleep injection reports cim-start for snapshot and marker deadlines", windowsOnly, () => {
  const { effect, stderr } = runWorker(`${realPowerShell}
    function inject(script) {
      return "function Get-CimInstance { Start-Sleep -Seconds 10 }; " + script;
    }
    const snapshot = getProcessSnapshot(process.pid, lookupOptions);
    const marker = processCommandContains(process.pid, "secret-marker-never-logged", lookupOptions);
    console.log(JSON.stringify({ snapshot, marker, records, calls }));
  `);
  assert.equal(effect.snapshot, null);
  assert.equal(effect.marker, false);
  assert.equal(effect.records.length, 2);
  assert.deepEqual(effect.records.map(record => record.lookup), ["snapshot", "marker"]);
  for (const record of effect.records) assertTimeout(record, "cim-start");
  for (const call of effect.calls) assert.equal(call.errorCode, "ETIMEDOUT");
  assert.equal(stderr.includes("secret-marker-never-logged"), false);
  assert.deepEqual(diagnosticRecords(stderr), effect.records);
});

test("real PowerShell distinguishes a stall after CIM completion", windowsOnly, () => {
  const { effect } = runWorker(`${realPowerShell}
    function inject(script) {
      const replacement = script.replace(/(Write-GrokLookupPhase\\s+['\"]cim-end['\"][^;]*;)/,
        "$1 Start-Sleep -Seconds 10;");
      assert.notEqual(replacement, script, "CIM completion phase must be instrumented");
      return replacement;
    }
    const snapshot = getProcessSnapshot(process.pid, lookupOptions);
    console.log(JSON.stringify({ snapshot, records, calls }));
  `);
  assert.equal(effect.snapshot, null);
  assert.equal(effect.records.length, 1);
  assertTimeout(effect.records[0], "cim-end");
});

test("an 84ms remaining budget observes only phases actually reached by real PowerShell", windowsOnly, () => {
  const { effect } = runWorker(`${realPowerShell}
    function inject(script) { return "Start-Sleep -Seconds 10; " + script; }
    const snapshot = getProcessSnapshot(process.pid,
      { ...lookupOptions, processLookupDeadline: performance.now() + 84 });
    console.log(JSON.stringify({ snapshot, records, calls }));
  `);
  assert.equal(effect.snapshot, null);
  assert.equal(effect.records.length, 1);
  assertTimeout(effect.records[0], "not-observed");
  assert.deepEqual(effect.records[0].phases, []);
  assert.ok(effect.calls[0].timeout <= 84);
});

test("real CIM exceptions and throwing callbacks preserve null and emit metadata only", windowsOnly, () => {
  const secret = "E2E-secret-commandline-marker-error";
  const { effect, stderr } = runWorker(`${realPowerShell}
    function inject(script) {
      return "function Get-CimInstance { throw '${secret}' }; " + script;
    }
    const snapshot = getProcessSnapshot(process.pid, {
      ...lookupOptions,
      onProcessLookupDiagnostic(record) { records.push(record); throw new Error("${secret}"); }
    });
    console.log(JSON.stringify({ snapshot, records }));
  `);
  assert.equal(effect.snapshot, null);
  assert.equal(effect.records.length, 1);
  assert.equal(effect.records[0].lastPhase, "cim-start");
  assert.ok(Number.isInteger(effect.records[0].hresult));
  assert.equal(effect.records[0].phases.at(-1).phase, "error");
  assert.equal(JSON.stringify(effect.records).includes(secret), false);
  assert.equal(stderr.includes(secret), false);
  assert.deepEqual(diagnosticRecords(stderr), effect.records);
  const allowedKeys = new Set(["event", "lookup", "targetPid", "parentPid", "startedAt", "elapsedMs",
    "timeoutMs", "status", "signal", "errorCode", "outcome", "lastPhase", "phases", "hresult"]);
  assert.ok(Object.keys(effect.records[0]).every(key => allowedKeys.has(key)));
});

test("real sleeping PowerShell lookups preserve the shared retry and exit budgets", windowsOnly, () => {
  const { effect } = runWorker(`${realPowerShell}
    function inject(script) { return "function Get-CimInstance { Start-Sleep -Seconds 10 }; " + script; }
    let begin = performance.now();
    const identity = inspectTrackedJobProcess(process.pid, "unavailable-start", lookupOptions);
    const identityMs = performance.now() - begin;
    begin = performance.now();
    const exited = waitForTrackedJobExit(process.pid, "unavailable-start", lookupOptions);
    console.log(JSON.stringify({ identity, identityMs, exited, exitMs: performance.now() - begin, calls }));
  `, 15000);
  assert.equal(effect.identity, "unavailable");
  assert.equal(effect.exited, false);
  assert.ok(effect.identityMs < 4500, JSON.stringify(effect));
  assert.ok(effect.exitMs < 6500, JSON.stringify(effect));
  assert.ok(effect.calls.every(call => call.timeout <= 3000));
});

test("real failed CIM lookup persists structured diagnostics to the job log", windowsOnly, () => {
  const { effect, stderr } = runWorker(`${realPowerShell}
    const { createProcessLookupDiagnostics } = await import(${JSON.stringify(trackedJobsModule)});
    const logFile = process.env.GROK_PROCESS_DIAGNOSTICS_E2E_LOG
      ?? path.join(os.tmpdir(), "grok-process-diagnostics-e2e-" + process.pid + ".log");
    function inject(script) { return "function Get-CimInstance { throw 'secret-log-error' }; " + script; }
    const snapshot = getProcessSnapshot(process.pid, {
      runCommandImpl: runInjected,
      ...createProcessLookupDiagnostics(logFile)
    });
    const log = fs.readFileSync(logFile, "utf8");
    console.log(JSON.stringify({ snapshot, log }));
  `);
  assert.equal(effect.snapshot, null);
  assert.equal(effect.log.includes("secret-log-error"), false);
  assert.ok(effect.log.includes("process-lookup"));
  const emitted = diagnosticRecords(stderr);
  assert.equal(emitted.length, 1);
  const lastLogLine = effect.log.trimEnd().split(/\r?\n/).at(-1);
  assert.deepEqual(JSON.parse(lastLogLine.slice(lastLogLine.indexOf('{'))), emitted[0]);
});

// 追加失敗条件: stderrの受信側切断による非同期EPIPEで、null判定の後に親が異常終了する。
test("a closed real stderr read pipe preserves lookup failure and the next event-loop turn", windowsOnly, async () => {
  const source = `
    import path from "node:path";
    import os from "node:os";
    import { getProcessSnapshot, runCommand } from ${JSON.stringify(processModule)};
    const initializedStderr = process.stderr;
    const records = [];
    process.stdin.once("data", () => {
      const snapshot = getProcessSnapshot(process.pid, {
        platform: "win32",
        runCommandImpl(command, args, options) {
          return runCommand(path.join(os.tmpdir(), "missing-lookup-e2e-" + process.pid + ".exe"), args, options);
        },
        onProcessLookupDiagnostic(record) { records.push(record); }
      });
      console.log(JSON.stringify({ snapshot, records, stderrInitialized: !!initializedStderr }));
      setImmediate(() => console.log("event-loop-complete"));
    });
    console.log("ready");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let ready = false;
  let guarded = false;
  const guard = setTimeout(() => { guarded = true; child.kill(); }, 5000);
  try {
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (!ready && stdout.includes("ready\n")) {
        ready = true;
        child.stderr.once("close", () => child.stdin.end("go"));
        child.stderr.destroy();
      }
    });
    const outcome = await completion;
    assert.equal(guarded, false, "closed-pipe worker exceeded the external five-second guard");
    assert.equal(outcome.status, 0, JSON.stringify({ ...outcome, stdout }));
    assert.equal(outcome.signal, null);
    const lines = stdout.trim().split(/\r?\n/);
    assert.equal(lines[0], "ready");
    assert.equal(lines.at(-1), "event-loop-complete");
    const effect = JSON.parse(lines[1]);
    assert.equal(effect.snapshot, null);
    assert.equal(effect.stderrInitialized, true);
    assert.equal(effect.records.length, 1);
    assert.equal(effect.records[0].errorCode, "ENOENT");
    assert.equal(effect.records[0].lastPhase, "not-observed");
    assert.deepEqual(effect.records[0].phases, []);
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
