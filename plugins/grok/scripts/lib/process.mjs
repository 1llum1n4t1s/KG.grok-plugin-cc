import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

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
 * `shell` を有効にしたまま引数配列を渡すと Node 22 以降が DEP0190 を出す。
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
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
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
  try {
    if (platform === "linux") {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      return cmdline.includes(marker);
    }
    const result = platform === "win32"
      ? runCommandImpl("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`
        ], { shell: false })
      : runCommandImpl("ps", ["-p", String(pid), "-o", "command="], { shell: false });
    return !result.error && result.status === 0 && String(result.stdout).includes(marker);
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
      const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { [pscustomobject]@{ startKey = $p.CreationDate.ToUniversalTime().ToString('o'); commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`;
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { shell: false });
      if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
      const snapshot = JSON.parse(result.stdout);
      return typeof snapshot.startKey === "string" && typeof snapshot.commandLine === "string"
        ? snapshot
        : null;
    }
    const start = run("ps", ["-p", String(pid), "-o", "lstart="], { shell: false });
    const command = run("ps", ["-p", String(pid), "-o", "command="], { shell: false });
    return !start.error && !command.error && start.status === 0 && command.status === 0 &&
      start.stdout.trim() && command.stdout.trim()
      ? { startKey: start.stdout.trim(), commandLine: command.stdout.trim() }
      : null;
  } catch {
    return null;
  }
}

/** 照会失敗を別プロセスとの不一致から区別して、停止判断を返す。 */
export function inspectTrackedJobProcess(pid, startKey, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "absent";
  if (typeof startKey !== "string" || !startKey) return "unavailable";

  const readSnapshot = options.getProcessSnapshotImpl ?? getProcessSnapshot;
  const processExists = options.processExistsImpl ?? ((targetPid) => {
    try {
      process.kill(targetPid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  });
  const sleep = options.sleepImpl ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = readSnapshot(pid, options);
    if (snapshot) {
      return snapshot.startKey === startKey &&
        /(?:^|[\s\\/])grok-companion\.mjs(?=$|[\s"'])/i.test(snapshot.commandLine)
        ? "match"
        : "mismatch";
    }
    if (attempt < 2) sleep(100);
  }
  return processExists(pid) ? "unavailable" : "absent";
}

/** 停止要求後、追跡対象の PID が消えるまで短時間待つ。 */
export function waitForTrackedJobExit(pid, startKey, options = {}) {
  const inspect = options.inspectImpl ?? inspectTrackedJobProcess;
  const sleep = options.sleepImpl ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const identity = inspect(pid, startKey, options);
    if (identity === "absent" || identity === "mismatch") return true;
    if (attempt < 9) sleep(100);
  }
  return false;
}

/** taskkill が終了レースで失敗しても、追跡対象の消滅を確認してから判定する。 */
export function stopTrackedJobProcess(pid, startKey, options = {}) {
  const terminate = options.terminateImpl ?? terminateProcessTree;
  const waitForExit = options.waitForExitImpl ?? waitForTrackedJobExit;
  let terminationError;
  try {
    terminate(pid, options);
  } catch (error) {
    terminationError = error;
  }
  if (waitForExit(pid, startKey, options)) return;
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
