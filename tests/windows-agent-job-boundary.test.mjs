import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("../plugins/grok/scripts/lib/windows-agent-supervisor.ps1", import.meta.url));
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// native adapterをすべて置換し、実プロセス起動・停止・ファイル削除を行わない。
function runBoundary(body) {
  const script = `
    $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
    . '${supervisor.replaceAll("'", "''")}'
    $events = New-Object 'System.Collections.Generic.List[string]'
    $config = @{ ParentPid = 123; ParentStartKey = 'precise-parent'; ControlHandle = [IntPtr]505; ApplicationName = 'cmd.exe'; CommandLine = 'cmd.exe /d /s /c fake'; Cwd = 'C:\\mock' }
    $api = @{
      PinParent = { param($pidValue, $key) $events.Add('pin-parent'); return [IntPtr]101 }
      ControlOwnerMatches = { param($parent, $pipe) $events.Add('control-owner:' + $parent); return $true }
      ParentAlive = { param($handle) $events.Add('parent-alive:' + $handle); return $true }
      CreateJob = { $events.Add('create-job'); return [IntPtr]202 }
      ConfigureJob = { param($job) $events.Add('configure-job:' + $job) }
      CreateProcess = { param($job, $configValue) $events.Add('create-atomic:' + $job); return @{ Process = [IntPtr]303; Thread = [IntPtr]404 } }
      InJob = { param($processHandle, $job) $events.Add('in-job:' + $job); return $true }
      Resume = { param($threadHandle) $events.Add('resume:' + $threadHandle) }
      TerminateJob = { param($job) $events.Add('terminate-job:' + $job) }
      ActiveProcesses = { param($job) $events.Add('query-active:' + $job); return 0 }
      CloseHandle = { param($handle) $events.Add('close:' + $handle) }
      Delay = { param($ms) }
      Now = { return 0 }
    }
    ${body}
    [pscustomobject]@{ Events = @($events.ToArray()); Confirmed = [bool]$state.StopConfirmed; Error = $failure } | ConvertTo-Json -Compress
  `;
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

for (const boundary of ["parent-identity", "control-owner", "job-configuration", "atomic-create", "membership", "parent-exited", "resume"]) {
  test(`Windows owned agent fails closed at ${boundary}`, { skip: process.platform !== "win32" }, () => {
    const override = {
      "parent-identity": "$api.PinParent = { throw 'Parent identity mismatch' }",
      "control-owner": "$api.ControlOwnerMatches = { return $false }",
      "job-configuration": "$api.ConfigureJob = { throw 'Job configuration failed' }",
      "atomic-create": "$api.CreateProcess = { throw 'JobList unsupported' }",
      membership: "$api.InJob = { return $false }",
      "parent-exited": "$api.ParentAlive = { return $false }",
      resume: "$api.Resume = { throw 'Resume failed' }"
    }[boundary];
    const result = runBoundary(`${override}; $state = $null; $failure = $null; try { $state = Start-GrokOwnedAgent $api $config } catch { $failure = $_.Exception.Message }`);
    assert.ok(result.Error);
    assert.equal(result.Confirmed, false);
    assert.equal(result.Events.some((event) => event.startsWith("resume:")), false);
    if (["parent-identity", "control-owner", "job-configuration"].includes(boundary)) {
      assert.equal(result.Events.some((event) => event.startsWith("create-atomic:")), false);
    }
    if (!["parent-identity", "control-owner"].includes(boundary)) assert.ok(result.Events.includes("close:202"));
  });
}

test("Windows owned agent resumes only after ownership and checks emptiness on the same job", { skip: process.platform !== "win32" }, () => {
  const result = runBoundary("$failure = $null; $state = Start-GrokOwnedAgent $api $config; Stop-GrokOwnedAgent $api $state -RequestStop $true; Close-GrokOwnedAgent $api $state");
  assert.equal(result.Error, null);
  assert.equal(result.Confirmed, true);
  assert.ok(result.Events.indexOf("create-atomic:202") < result.Events.indexOf("in-job:202"));
  assert.ok(result.Events.indexOf("in-job:202") < result.Events.indexOf("resume:404"));
  assert.ok(result.Events.indexOf("terminate-job:202") < result.Events.indexOf("query-active:202"));
  assert.ok(result.Events.includes("close:202"));
});

for (const boundary of ["query-failed", "still-active", "termination-failed"]) {
  test(`Windows owned agent cannot confirm stop when ${boundary}`, { skip: process.platform !== "win32" }, () => {
    const override = {
      "query-failed": "$api.ActiveProcesses = { throw 'Query unavailable' }",
      "still-active": "$api.ActiveProcesses = { return 1 }; $api.Now = { $script:clock += 1000; return $script:clock }",
      "termination-failed": "$api.TerminateJob = { throw 'Termination failed' }"
    }[boundary];
    const result = runBoundary(`$script:clock = 0; $failure = $null; $state = Start-GrokOwnedAgent $api $config; ${override}; try { Stop-GrokOwnedAgent $api $state -RequestStop $true } catch { $failure = $_.Exception.Message }; Close-GrokOwnedAgent $api $state`);
    assert.ok(result.Error);
    assert.equal(result.Confirmed, false);
  });
}
