import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseArgs } from "../plugins/grok/scripts/lib/args.mjs";

// CLIの拒否・説明だけを通す。確認済み移行の実行や実FSの作成/削除は行わない。
const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const source = fs.readFileSync(companion, "utf8");
const handler = source.slice(source.indexOf("function handleStateLock("), source.indexOf("async function handleSetup("));
function memoryCli(args) {
  const calls = [];
  const context = {
    path, process: { platform: process.platform }, normalizeArgv: value => value, parseCommandInput: parseArgs,
    resolveCommandWorkspace() { calls.push("workspace"); return "/workspace"; },
    migrateStateLock(cwd, options) { calls.push({ cwd, options }); return { stateDir: "C:\\Actual\\State", protocol: "native-local-v2" }; },
    outputCommandResult(payload, text, json) { calls.push({ payload, text, json }); }
  };
  const invoke = vm.runInNewContext(`${handler}; handleStateLock`, context);
  return { calls, invoke: () => invoke(args) };
}

// 失敗条件を先に固定する。欠落時の旧実装は本物のstateを移行し得るためVMで評価する。
for (const expected of [undefined, "", "relative/state", "\\root-relative"] ) {
  test(`state-lock CLI requires an absolute expected directory before workspace lookup: ${JSON.stringify(expected)}`, () => {
    const args = ["migrate", "--offline-confirmed", "--local-only"];
    if (expected !== undefined) args.push(`--expected-state-dir=${expected}`);
    const f = memoryCli(args);
    assert.throws(f.invoke, /expected.state.dir.*absolute|absolute.*expected.state.dir/i);
    assert.deepEqual(f.calls, []);
  });
}

test("state-lock CLI forwards the expected directory and reports the effective directory in JSON and text", () => {
  for (const json of [false, true]) {
    const expected = path.resolve("expected-state");
    const args = ["migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", expected];
    if (json) args.push("--json");
    const f = memoryCli(args);
    f.invoke();
    assert.equal(f.calls[1].options.expectedStateDir, expected);
    assert.equal(f.calls[2].payload.stateDir, "C:\\Actual\\State");
    assert.match(f.calls[2].text, /C:\\Actual\\State/);
    assert.equal(Boolean(f.calls[2].json), json);
  }
});
function run(args) {
  const result = spawnSync(process.execPath, [companion, "state-lock", ...args], {
    encoding: "utf8", windowsHide: true, timeout: 10_000
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

for (const args of [
  ["migrate"], ["migrate", "--offline-confirmed"], ["migrate", "--local-only"],
  ["migrate", "--offline-confirmed=false", "--local-only"],
  ["migrate", "--offline-confirmed=0", "--local-only"],
  ["migrate", "--offline-confirmed", "--local-only=no"]
]) {
  test(`state-lock CLI rejects missing/ambiguous confirmations: ${args.join(" ")}`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /offline|local.only|confirmation/i);
    assert.equal(result.stdout, "");
  });
}

test("state-lock help states the Windows-only and operator-confirmed boundaries", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Windows/i);
  assert.match(result.stdout, /stop.*old runtime/i);
  assert.match(result.stdout, /restart/i);
  assert.match(result.stdout, /other host/i);
  assert.match(result.stdout, /not.*detect|not.*prov/i);
  assert.match(result.stdout, /--expected-state-dir.*absolute/i);
});

test("state-lock CLI rejects user-supplied host identities and extra actions", () => {
  const result = run(["migrate", "--offline-confirmed", "--local-only", "--host-id=pretend", "extra"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /argument|option|usage/i);
});
