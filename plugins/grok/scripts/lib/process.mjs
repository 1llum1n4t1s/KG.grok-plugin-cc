import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { performance } from "node:perf_hooks";

// 通常の Windows CIM 照会（約 0.5～0.8 秒）に余裕を持たせ、再試行で期限を延ばさない。
const PROCESS_LOOKUP_TIMEOUT_MS = 3000;
const PROCESS_LOOKUP_PHASE_PREFIX = "GROK_PROCESS_LOOKUP_PHASE|";
const WINDOWS_START_KEY_PREFIX = "win32-filetime:";

function windowsProcessLookupScript(pid, output) {
  // stderr は照会結果と分離し、強制終了までに到達した段階も回収できるよう即時に流す。
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    "$grokLookupWatch = [System.Diagnostics.Stopwatch]::StartNew();",
    "function Write-GrokLookupPhase([string]$phase, [int]$hresult = 0) {",
    `[Console]::Error.WriteLine(('${PROCESS_LOOKUP_PHASE_PREFIX}' + $phase + '|' + $PID + '|' + $grokLookupWatch.Elapsed.TotalMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture) + '|' + $hresult + '|' + [DateTime]::UtcNow.ToString('o')));`,
    "[Console]::Error.Flush(); };",
    "Write-GrokLookupPhase 'powershell-start';",
    "try { Write-GrokLookupPhase 'cim-start';",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop;`,
    "Write-GrokLookupPhase 'cim-end';",
    output,
    "; Write-GrokLookupPhase 'powershell-end';",
    "} catch { Write-GrokLookupPhase 'error' $_.Exception.HResult; exit 1; }"
  ].join(" ");
}

function processLookupPhases(stderr) {
  const phases = [];
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    if (!line.startsWith(PROCESS_LOOKUP_PHASE_PREFIX)) continue;
    const fields = line.slice(PROCESS_LOOKUP_PHASE_PREFIX.length).split("|");
    if (fields.length !== 5) continue;
    const [phase, pidText, elapsedText, hresultText, atUtc] = fields;
    const pid = Number(pidText);
    const elapsedMs = Number(elapsedText);
    if (!["powershell-start", "cim-start", "cim-end", "powershell-end", "error"].includes(phase) ||
        !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(atUtc) || !Number.isFinite(Date.parse(atUtc))) continue;
    const hresult = Number(hresultText);
    phases.push({ phase, pid, elapsedMs, atUtc,
      ...(phase === "error" && Number.isInteger(hresult) ? { hresult } : {}) });
    if (phases.length === 8) break;
  }
  return phases;
}

function reportProcessLookupFailure(options, lookup, startedAt, begin, timeoutMs, result, error) {
  const phases = processLookupPhases(result?.stderr);
  const reversePhases = [...phases].reverse();
  const code = error?.code;
  const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null;
  const signal = typeof result?.signal === "string" && /^[A-Z0-9]{1,16}$/.test(result.signal) ? result.signal : null;
  const record = {
    event: "process-lookup", ...lookup, parentPid: process.pid, startedAt,
    timeoutMs, elapsedMs: Math.round((performance.now() - begin) * 10) / 10,
    outcome: errorCode === "ETIMEDOUT" ? "timeout" : error ? "error" : signal ? "signal" : "exit",
    status: Number.isInteger(result?.status) ? result.status : null, signal, errorCode,
    lastPhase: reversePhases.find((entry) => entry.phase !== "error")?.phase ?? "not-observed",
    hresult: reversePhases.find((entry) => entry.phase === "error")?.hresult ?? null,
    phases
  };
  // 診断用の保存失敗で、同一性の判定やキャンセルの結果を変えない。
  try { options.onProcessLookupDiagnostic?.(record); } catch { /* stderr への診断は続ける。 */ }
  // Stream.write の非同期 EPIPE で終了しないよう、閉じた stderr もここで同期的に捕捉する。
  try { fs.writeSync(process.stderr.fd, `[grok] Process lookup diagnostic ${JSON.stringify(record)}\n`); } catch { /* 診断は補助情報。 */ }
}

function withProcessLookupDeadline(options, budget) {
  return {
    ...options,
    processLookupDeadline: Math.min(options.processLookupDeadline ?? Infinity, performance.now() + budget)
  };
}

function remainingProcessLookupTime(options) {
  return Math.max(0, options.processLookupDeadline - performance.now());
}

function runProcessLookup(run, command, args, options, lookup = {}, env) {
  const remaining = remainingProcessLookupTime(options);
  if (remaining <= 0) return null;
  const timeoutMs = Math.max(1, Math.ceil(remaining));
  const begin = performance.now();
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = run(command, args, { shell: false, timeout: timeoutMs, ...(env ? { env } : {}) });
  } catch (error) {
    if (command === "powershell.exe") reportProcessLookupFailure(options, lookup, startedAt, begin, timeoutMs, null, error);
    throw error;
  }
  if (command === "powershell.exe" && result && (result.error || result.signal || result.status !== 0)) {
    reportProcessLookupFailure(options, lookup, startedAt, begin, timeoutMs, result, result.error);
  }
  return result;
}

/**
 * shell 経由で渡す 1 語をエスケープする。
 *
 * すでに丸ごと二重引用符で囲まれている値はそのまま返す（呼び出し側が
 * `quoteIfNeeded` で囲んだ実行ファイルパスを二重に囲まないため）。
 * バックスラッシュは触らない。cmd.exe はこれをエスケープ文字として扱わず、
 * `"C:\\Users\\..."` へ変換すると Windows のパスが壊れる。
 */
export function quoteShellArgument(value) {
  const text = String(value ?? "");
  if (text && !/[\s"'`$&|<>^()]/.test(text)) {
    return text;
  }
  if (/^".*"$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * 実行ファイルと引数を、shell に渡せる 1 本のコマンド文字列へ畳む。
 *
 * `shell` を有効にしたまま引数配列を渡すと Node 24 以降が DEP0190 を出す。
 * 警告は stderr へ書かれるので、ホストが stdout と stderr を 1 つの結果へ
 * 合流する経路では、レポート本文の前に
 * 警告が挟まって出力が汚れる。shell 経由のときは自前で連結して、引数配列は
 * 空のまま spawn する。
 */
export function buildShellCommand(command, args = []) {
  return [quoteShellArgument(command), ...args.map((arg) => quoteShellArgument(arg))].join(" ");
}

export function runCommand(command, args = [], options = {}) {
  const shell = options.shell ?? (process.platform === "win32");
  const useShell = Boolean(shell);
  const result = spawnSync(useShell ? buildShellCommand(command, args) : command, useShell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    stdio: options.stdio ?? "pipe",
    shell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

/** PID の再利用を見分けるため、OS が持つプロセス開始識別子を読む。 */
export function getProcessSnapshot(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const run = options.runCommandImpl ?? runCommand;
  const lookupOptions = withProcessLookupDeadline(options, PROCESS_LOOKUP_TIMEOUT_MS);
  try {
    // Windows PowerShell の既定出力は環境によって CP932 になる。
    // 日本語の依頼文を含む CommandLine を JSON として読むため UTF-8 に固定する。
    // ハンドルを先に保持し、開始時刻と CIM の CommandLine が別の PID 所有者にならないようにする。
    const script = [
      "$ErrorActionPreference = 'Stop'; $grokPinnedProcess = $null; try {",
      `$grokPinnedProcess = [System.Diagnostics.Process]::GetProcessById(${pid});`,
      "$null = $grokPinnedProcess.Handle;",
      windowsProcessLookupScript(pid, `if ($null -ne $p) { [pscustomobject]@{ startKey = ('${WINDOWS_START_KEY_PREFIX}' + $grokPinnedProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)); commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`),
      "} finally { if ($null -ne $grokPinnedProcess) { $grokPinnedProcess.Dispose() } }"
    ].join(" ");
    const result = runProcessLookup(run, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], lookupOptions, { lookup: "snapshot", targetPid: pid });
    if (!result || result.error || result.status !== 0 || !result.stdout.trim()) return null;
    const snapshot = JSON.parse(result.stdout);
    return typeof snapshot.startKey === "string" && typeof snapshot.commandLine === "string"
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
