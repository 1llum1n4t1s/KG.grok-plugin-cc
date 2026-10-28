import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { readWindowsWorkingTreeFiles } from "../plugins/grok/scripts/lib/git.mjs";

// 先に固定する失敗条件: 不正path、helper欠落/timeout、不正JSON、欠落/重複/順序違い、
// 不正base64、サイズ超過。実Git・ファイル生成・削除は使わない。
function helper(t, result) {
  const systemRoot = process.env.SystemRoot;
  t.after(() => {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });
  // helper自体はmockするため、Windowsがないホストでも同じ起動契約を検証する。
  process.env.SystemRoot = String.raw`C:\Windows`;
  const calls = [];
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify(result), stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test("Windows snapshot reader: paths are validated before starting a helper", (t) => {
  const calls = helper(t, {});
  for (const file of ["../secret", "a/../secret", "a\\secret", "C:/secret", "/secret", "a:stream", "a\0b", ".git/config", "a//b", "a.", "CON"]) {
    assert.throws(() => readWindowsWorkingTreeFiles(process.cwd(), [file]), /incomplete|invalid/i);
  }
  assert.equal(calls.length, 0);
});

test("Windows snapshot reader: contents use one bounded shell-free helper", (t) => {
  const calls = helper(t, { version: 1, files: [{ path: "app.js", content: "aGkK" }] });
  const result = readWindowsWorkingTreeFiles(process.cwd(), ["app.js"]);
  assert.equal(result.get("app.js").toString(), "hi\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.match(calls[0].command, /^[a-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 15000);
  assert.deepEqual(JSON.parse(calls[0].options.input).paths, ["app.js"]);
  assert.ok(calls[0].options.maxBuffer < 16 * 1024 * 1024);
});

// 先行失敗条件: 残り予算を超えた helper 起動、期限切れ後の新規起動。
test("Windows snapshot reader: shared deadline limits the helper and prevents late starts", (t) => {
  const calls = helper(t, { version: 1, files: [{ path: "app.js", content: "aGkK" }] });
  readWindowsWorkingTreeFiles(process.cwd(), ["app.js"], { deadline: performance.now() + 500 });
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 500);
  assert.throws(() => readWindowsWorkingTreeFiles(process.cwd(), ["app.js"], { deadline: performance.now() - 1 }), /deadline|expired/i);
  assert.equal(calls.length, 1);
});

for (const result of [
  {}, { version: 2, files: [] }, { version: 1, files: [] },
  { version: 1, files: [{ path: "other", content: "aGkK" }] },
  { version: 1, files: [{ path: "app.js", content: "invalid!" }] },
  { version: 1, files: [{ path: "app.js", content: null }] },
  { version: 1, files: [{ path: "app.js", content: "" }, { path: "app.js", content: "" }] }
]) {
  test(`Windows snapshot reader: invalid response fails closed ${JSON.stringify(result)}`, (t) => {
    helper(t, result);
    assert.throws(() => readWindowsWorkingTreeFiles(process.cwd(), ["app.js"]), /incomplete/i);
  });
}

test("Windows snapshot reader: missing helper and timeout fail closed", (t) => {
  helper(t, {});
  t.mock.method(childProcess, "spawnSync", () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }));
  syncBuiltinESMExports();
  assert.throws(() => readWindowsWorkingTreeFiles(process.cwd(), ["app.js"]), /incomplete/i);
});
