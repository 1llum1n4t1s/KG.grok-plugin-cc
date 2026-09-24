import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  buildShellCommand,
  getProcessSnapshot,
  inspectTrackedJobProcess,
  quoteShellArgument,
  processCommandContains,
  runCommand,
  stopTrackedJobProcess,
  terminateProcessTree,
  waitForTrackedJobExit
} from "../plugins/grok/scripts/lib/process.mjs";

/** 引数をそのまま JSON で吐くだけの子プロセス。二重引用符を含めない。 */
const ECHO_ARGV_SCRIPT = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

test("quoteShellArgument leaves plain words and pre-quoted values alone", () => {
  assert.equal(quoteShellArgument("grok"), "grok");
  assert.equal(quoteShellArgument("C:\\tools\\grok.cmd"), "C:\\tools\\grok.cmd");
  assert.equal(quoteShellArgument("\"C:\\Program Files\\grok.cmd\""), "\"C:\\Program Files\\grok.cmd\"");
});

test("processCommandContains verifies a job marker before termination", () => {
  assert.equal(processCommandContains(1234, "job-exact", {
    platform: "darwin",
    runCommandImpl() {
      return { status: 0, stdout: "node grok-companion.mjs review-worker --job-id job-exact", stderr: "", error: null };
    }
  }), true);
  assert.equal(processCommandContains(1234, "job-other", {
    platform: "darwin",
    runCommandImpl() {
      return { status: 0, stdout: "node grok-companion.mjs review-worker --job-id job-exact", stderr: "", error: null };
    }
  }), false);
});

test("tracked job termination requires the same process start and companion command", () => {
  let snapshot = { startKey: "2026-09-23T01:00:00.000Z", commandLine: "node grok-companion.mjs task" };
  const options = {
    platform: "win32",
    runCommandImpl() {
      return { status: 0, stdout: JSON.stringify(snapshot), stderr: "", error: null };
    }
  };

  assert.equal(inspectTrackedJobProcess(1234, snapshot.startKey, options), "match");
  snapshot = { ...snapshot, startKey: "2026-09-23T01:00:01.000Z" };
  assert.equal(inspectTrackedJobProcess(1234, "2026-09-23T01:00:00.000Z", options), "mismatch");
  snapshot = { ...snapshot, commandLine: "node unrelated.mjs task" };
  assert.equal(inspectTrackedJobProcess(1234, snapshot.startKey, options), "mismatch");
  assert.equal(inspectTrackedJobProcess(1234, null, options), "unavailable");
});

test("a failed process lookup is retried and never treated as a different process", () => {
  let lookups = 0;
  let waits = 0;
  const options = {
    getProcessSnapshotImpl() {
      lookups += 1;
      return lookups === 1 ? null : {
        startKey: "start",
        commandLine: "node grok-companion.mjs task"
      };
    },
    sleepImpl(ms) {
      assert.equal(ms, 100);
      waits += 1;
    }
  };

  assert.equal(inspectTrackedJobProcess(1234, "start", options), "match");
  assert.equal(lookups, 2);
  assert.equal(waits, 1);
  assert.equal(inspectTrackedJobProcess(1234, "start", {
    getProcessSnapshotImpl: () => null,
    processExistsImpl: () => true,
    sleepImpl: () => { waits += 1; }
  }), "unavailable");
  assert.equal(waits, 3);
  assert.equal(inspectTrackedJobProcess(1234, "start", {
    getProcessSnapshotImpl: () => null,
    processExistsImpl: () => false,
    sleepImpl: () => {}
  }), "absent");
});

test("a termination signal is not treated as process exit", () => {
  let checks = 0;
  const sleepImpl = () => {};
  assert.equal(waitForTrackedJobExit(1234, "start", {
    inspectImpl: () => ++checks < 3 ? "match" : "absent",
    sleepImpl
  }), true);
  assert.equal(checks, 3);
  assert.equal(waitForTrackedJobExit(1234, "start", {
    inspectImpl: () => "match",
    sleepImpl
  }), false);
});

test("a taskkill error after process exit does not leave cancellation pending", () => {
  const taskkillError = new Error("taskkill exited nonzero after a child disappeared");
  assert.doesNotThrow(() => stopTrackedJobProcess(1234, "start", {
    terminateImpl: () => { throw taskkillError; },
    inspectImpl: () => "absent"
  }));
  assert.throws(() => stopTrackedJobProcess(1234, "start", {
    terminateImpl: () => { throw taskkillError; },
    inspectImpl: () => "match",
    sleepImpl: () => {}
  }), (error) => error === taskkillError);
  assert.throws(() => stopTrackedJobProcess(1234, "start", {
    terminateImpl: () => { throw taskkillError; },
    inspectImpl: () => "unavailable",
    sleepImpl: () => {}
  }), (error) => error === taskkillError);
});

test("Windows process snapshot requests UTF-8 for a Japanese command line", () => {
  let commandScript = null;
  const snapshot = getProcessSnapshot(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      assert.equal(command, "powershell.exe");
      assert.equal(options.shell, false);
      commandScript = args.at(-1);
      return {
        status: 0,
        stdout: JSON.stringify({
          startKey: "2026-09-23T01:00:00.000Z",
          commandLine: "node grok-companion.mjs task 日本語の依頼"
        }),
        stderr: "",
        error: null
      };
    }
  });

  assert.match(commandScript, /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.equal(snapshot.commandLine, "node grok-companion.mjs task 日本語の依頼");
});

test("Linux process identity includes boot ID and process start ticks", () => {
  const fields = Array(20).fill("0");
  fields[19] = "987654";
  const files = new Map([
    ["/proc/1234/stat", `1234 (node) ${fields.join(" ")}`],
    ["/proc/sys/kernel/random/boot_id", "boot-identifier\n"],
    ["/proc/1234/cmdline", "node\0grok-companion.mjs\0task\0"]
  ]);
  const snapshot = getProcessSnapshot(1234, {
    platform: "linux",
    readFileImpl(path) { return files.get(path); }
  });

  assert.deepEqual(snapshot, {
    startKey: "boot-identifier:987654",
    commandLine: "node grok-companion.mjs task"
  });
});

test("quoteShellArgument quotes spaces without mangling backslashes", () => {
  assert.equal(quoteShellArgument("C:\\Program Files\\grok.cmd"), "\"C:\\Program Files\\grok.cmd\"");
});

test("buildShellCommand folds the binary and its arguments into one string", () => {
  assert.equal(buildShellCommand("grok", ["agent", "stdio"]), "grok agent stdio");
  assert.equal(
    buildShellCommand("\"C:\\Program Files\\grok.cmd\"", ["agent", "stdio"]),
    "\"C:\\Program Files\\grok.cmd\" agent stdio"
  );
});

/**
 * shell 実行で DEP0190 を出さないことの回帰テスト。
 *
 * `shell` と引数配列を同時に渡していた頃は Node 22 以降が stderr へ警告を書き、
 * ホストが統合する出力でレポート本文の前に混ざっていた。
 */
test("runCommand runs through a shell without emitting deprecation warnings", () => {
  const result = runCommand(process.execPath, ["-e", ECHO_ARGV_SCRIPT, "a b", "c"], { shell: true });

  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), ["a b", "c"]);
  // 失敗メッセージの組み立てに使うので、呼び出し時の command / args を保つ。
  assert.equal(result.command, process.execPath);
  assert.deepEqual(result.args, ["-e", ECHO_ARGV_SCRIPT, "a b", "c"]);
});

test("Windows runCommand uses cmd.exe even when SHELL points elsewhere", { skip: process.platform !== "win32" }, () => {
  const previousShell = process.env.SHELL;
  process.env.SHELL = "C:\\missing-shell\\bash.exe";
  try {
    const result = runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
    assert.equal(result.error, null);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "ok");
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree falls back to the positive pid when a Unix process group is missing", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("missing process group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(calls, [[-1234, "SIGTERM"], [1234, "SIGTERM"]]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});
