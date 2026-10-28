import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { performance } from "node:perf_hooks";

// 通常の Windows CIM 照会（約 0.5～0.8 秒）に余裕を持たせ、再試行で期限を延ばさない。
const PROCESS_LOOKUP_TIMEOUT_MS = 3000;
const PROCESS_EXIT_TIMEOUT_MS = 5000;
const PROCESS_LOOKUP_PHASE_PREFIX = "GROK_PROCESS_LOOKUP_PHASE|";
const WINDOWS_START_KEY_PREFIX = "win32-filetime:";
const DARWIN_START_KEY_PREFIX = "darwin-lstart-utc-v1:";

function isPreciseWindowsStartKey(startKey) {
  return typeof startKey === "string" && /^win32-filetime:[1-9]\d{16,18}$/.test(startKey);
}

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

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
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

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const args = ["/PID", String(pid), ...(options.tree === false ? [] : ["/T"]), "/F"];
    const result = runCommandImpl("taskkill", args, {
      cwd: options.cwd,
      env: options.env,
      // CMD は長い PATH を失うことがあるため、OS の実行ファイルは直接起動する。
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  if (options.tree === false) {
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    // detached process group が無い場合でも、正の PID のプロセス自体は
    // 存在し得る。ESRCH を含む group kill の全失敗で個別 kill を試す。
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function processCommandContains(pid, marker, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof marker !== "string" || !marker) {
    return false;
  }
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const lookupOptions = withProcessLookupDeadline(options, PROCESS_LOOKUP_TIMEOUT_MS);
  try {
    if (platform === "linux") {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      return cmdline.includes(marker);
    }
    const result = platform === "win32"
      ? runProcessLookup(runCommandImpl, "powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsProcessLookupScript(pid, "$p.CommandLine")
        ], lookupOptions, { lookup: "marker", targetPid: pid })
      : runProcessLookup(runCommandImpl, "ps", ["-p", String(pid), "-o", "command="], lookupOptions);
    return !!result && !result.error && result.status === 0 && String(result.stdout).includes(marker);
  } catch {
    return false;
  }
}

/** PID の再利用を見分けるため、OS が持つプロセス開始識別子を読む。 */
export function getProcessSnapshot(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  const readFile = options.readFileImpl ?? fs.readFileSync;
  const run = options.runCommandImpl ?? runCommand;
  const lookupOptions = withProcessLookupDeadline(options, PROCESS_LOOKUP_TIMEOUT_MS);
  try {
    if (platform === "linux") {
      const stat = readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      const bootId = readFile("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const commandLine = readFile(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      const startTick = fields[19]; // /proc/[pid]/stat の第 22 フィールド。
      return bootId && startTick && commandLine
        ? { startKey: `${bootId}:${startTick}`, commandLine }
        : null;
    }
    if (platform === "win32") {
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
    }
    // lstart は呼び出し元の時間帯・ロケールで変化するため、Mac では表記を固定する。
    const startEnv = platform === "darwin" ? { ...process.env, TZ: "UTC", LC_ALL: "C" } : undefined;
    const start = runProcessLookup(run, "ps", ["-p", String(pid), "-o", "lstart="], lookupOptions, {}, startEnv);
    const command = runProcessLookup(run, "ps", ["-p", String(pid), "-o", "command="], lookupOptions);
    return start && command && !start.error && !command.error && start.status === 0 && command.status === 0 &&
      start.stdout.trim() && command.stdout.trim()
      ? { startKey: `${platform === "darwin" ? DARWIN_START_KEY_PREFIX : ""}${start.stdout.trim()}`, commandLine: command.stdout.trim() }
      : null;
  } catch {
    return null;
  }
}

function isDarwinZombie(pid, options) {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  try {
    const result = runProcessLookup(options.runCommandImpl ?? runCommand, "ps",
      ["-p", String(pid), "-o", "pid=", "-o", "stat="], options);
    if (!result || result.error || result.signal || result.status !== 0) return false;
    const fields = String(result.stdout ?? "").trim().split(/\s+/);
    // PIDを同じ行で照合し、親が未回収でも実行不能なZだけを終了証拠にする。
    // 生存状態・空出力・複数行・不正な修飾子は終了と推測しない。
    return fields.length === 2 && fields[0] === String(pid) && /^Z[+<NslLWEVX]*$/.test(fields[1]);
  } catch {
    return false;
  }
}

/** 照会失敗を別プロセスとの不一致から区別して、停止判断を返す。 */
export function inspectTrackedJobProcess(pid, startKey, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "unavailable";
  if (typeof startKey !== "string" || !startKey) return "unavailable";
  // 旧 CIM キーは 100 ns 桁を失っているため、新キーとの不一致を終了扱いにしない。
  if ((options.platform ?? process.platform) === "win32" && !isPreciseWindowsStartKey(startKey)) return "unavailable";

  const readSnapshot = options.getProcessSnapshotImpl ?? getProcessSnapshot;
  const processExists = options.processExistsImpl ?? ((targetPid) => {
    try {
      process.kill(targetPid, 0);
      if ((options.platform ?? process.platform) === "linux") {
        try {
          const stat = (options.readFileImpl ?? fs.readFileSync)(`/proc/${targetPid}/stat`, "utf8");
          const separator = stat.lastIndexOf(") ");
          const fields = separator >= 0 ? stat.slice(separator + 2).trim().split(/\s+/) : [];
          // 親が未回収でも、ゾンビ・終了状態のプロセスは処理を続けられない。
          if (stat.startsWith(`${targetPid} (`) && /^[ZX]$/.test(fields[0] ?? "") && /^\d+$/.test(fields[19] ?? "")) {
            return false;
          }
        } catch {
          // 終了状態を読めない場合は、生存・照会不能として慎重な判定を保つ。
        }
      }
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  });
  const sleep = options.sleepImpl ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const lookupOptions = withProcessLookupDeadline(options, PROCESS_LOOKUP_TIMEOUT_MS);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (remainingProcessLookupTime(lookupOptions) <= 0) break;
    const snapshot = readSnapshot(pid, lookupOptions);
    if (snapshot) {
      // 旧 lstart は取得時の TZ・ロケールが不明なので、差を終了証拠にできない。
      if ((options.platform ?? process.platform) === "darwin" && !startKey.startsWith(DARWIN_START_KEY_PREFIX)) {
        return isDarwinZombie(pid, lookupOptions) ? "absent" : "unavailable";
      }
      // mismatchは元の個体が終了した証拠として使うため、開始識別子の相違だけに限る。
      if (snapshot.startKey !== startKey) return "mismatch";
      if (isDarwinZombie(pid, lookupOptions)) return "absent";
      const commandMatches = typeof options.expectedCommandLine === "string" && options.expectedCommandLine
        ? snapshot.commandLine === options.expectedCommandLine
        : /(?:^|[\s\\/])grok-companion\.mjs(?=$|[\s"'])/i.test(snapshot.commandLine);
      return commandMatches ? "match" : "unavailable";
    }
    if (attempt < 2) sleep(Math.min(100, remainingProcessLookupTime(lookupOptions)));
  }
  return isDarwinZombie(pid, lookupOptions) || !processExists(pid) ? "absent" : "unavailable";
}

/** 停止要求後、追跡対象の PID が消えるまで短時間待つ。 */
export function waitForTrackedJobExit(pid, startKey, options = {}) {
  const inspect = options.inspectImpl ?? inspectTrackedJobProcess;
  const sleep = options.sleepImpl ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const lookupOptions = withProcessLookupDeadline(options, PROCESS_EXIT_TIMEOUT_MS);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (remainingProcessLookupTime(lookupOptions) <= 0) break;
    const identity = inspect(pid, startKey, lookupOptions);
    if (identity === "absent" || identity === "mismatch") return true;
    if (attempt < 49) sleep(Math.min(100, remainingProcessLookupTime(lookupOptions)));
  }
  return false;
}

function stopWindowsTrackedProcess(pid, startKey, options) {
  const fileTime = startKey.slice(WINDOWS_START_KEY_PREFIX.length);
  // .NET Framework は Handle 取得後の StartTime / Kill で同じ保持ハンドルを使う。
  // 開始時刻の照合後に PID を再解決する taskkill へのフォールバックは行わない。
  const script = [
    "$ErrorActionPreference = 'Stop'; $grokPinnedProcess = $null; try {",
    `try { $grokPinnedProcess = [System.Diagnostics.Process]::GetProcessById(${pid}); }`,
    "catch [System.ArgumentException] { Write-Output 'absent'; exit 0; }",
    "$null = $grokPinnedProcess.Handle;",
    "$actual = $grokPinnedProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture);",
    `if ($actual -cne '${fileTime}') { Write-Output 'mismatch'; exit 0; }`,
    "$grokPinnedProcess.Kill(); Write-Output 'stopped';",
    "} catch { [Console]::Error.WriteLine('Tracked process handle stop failed.'); exit 1; }",
    "finally { if ($null -ne $grokPinnedProcess) { $grokPinnedProcess.Dispose() } }"
  ].join(" ");
  const result = runProcessLookup(options.runCommandImpl ?? runCommand, "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    withProcessLookupDeadline(options, PROCESS_LOOKUP_TIMEOUT_MS), { lookup: "stop", targetPid: pid });
  if (!result || result.error || result.status !== 0 || !/^(?:stopped|absent|mismatch)$/.test(result.stdout.trim())) {
    throw new Error("Windows tracked process stop could not be confirmed.", { cause: result?.error });
  }
}

/** 停止要求が終了レースで失敗しても、追跡対象の消滅を確認してから判定する。 */
export function stopTrackedJobProcess(pid, startKey, options = {}) {
  const platform = options.platform ?? process.platform;
  const windowsHandleStop = platform === "win32" && !options.terminateImpl;
  if (windowsHandleStop && (!Number.isInteger(pid) || pid <= 0 || !isPreciseWindowsStartKey(startKey))) {
    throw new Error("Windows tracked process stop requires a precise win32-filetime start key; legacy CIM keys cannot be stopped safely.");
  }
  const stopOptions = withProcessLookupDeadline(options, PROCESS_EXIT_TIMEOUT_MS);
  const waitForExit = options.waitForExitImpl ?? waitForTrackedJobExit;
  let terminationError;
  try {
    if (windowsHandleStop) stopWindowsTrackedProcess(pid, startKey, stopOptions);
    // POSIXの数値PIDは照会後に再利用され得る。所有workerの協調停止を待ち、
    // 別プロセスからのPID/group killへのフォールバックは行わない。
    else if (platform === "win32") (options.terminateImpl ?? terminateProcessTree)(pid, stopOptions);
  } catch (error) {
    terminationError = error;
  }
  if (waitForExit(pid, startKey, stopOptions)) return;
  throw terminationError ?? new Error("Process exit could not be confirmed.");
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
