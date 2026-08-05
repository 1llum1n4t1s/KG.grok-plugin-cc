import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  buildShellCommand,
  quoteShellArgument,
  runCommand,
  terminateProcessTree
} from "../plugins/grok/scripts/lib/process.mjs";

/** 引数をそのまま JSON で吐くだけの子プロセス。二重引用符を含めない。 */
const ECHO_ARGV_SCRIPT = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

test("quoteShellArgument leaves plain words and pre-quoted values alone", () => {
  assert.equal(quoteShellArgument("grok"), "grok");
  assert.equal(quoteShellArgument("C:\\tools\\grok.cmd"), "C:\\tools\\grok.cmd");
  assert.equal(quoteShellArgument("\"C:\\Program Files\\grok.cmd\""), "\"C:\\Program Files\\grok.cmd\"");
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
 * バックグラウンド実行の出力ファイルでレポート本文の前に混ざっていた。
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
