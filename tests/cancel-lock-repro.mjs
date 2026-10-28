// 取消とnative state lockの明示E2E。通常の tests/*.test.mjs には含めない。
// 1. late progressのlock所有worker停止後も、取消の最終保存をlock取得失敗にしない。
// 2. shared agentがcancelを無視した場合は、worker終了後もturn停止未確認を保持する。
// 実Grok・外部通信は使用しない。実行結果を確認するまで合格とは扱わない。
// 明示実行: node --test tests/cancel-lock-repro.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture, until } from "./cancel-repair-fixture.mjs";
import { initGitRepo, run } from "./helpers.mjs";
import { migrateStateLock, resolveNativeStateLockEndpoint, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

async function trackedFixture(t, command, extraEnv = {}) {
  const f = await fixture(t, extraEnv);
  initGitRepo(f.cwd);
  fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 1;\n");
  assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "test fixture"], { cwd: f.cwd }).status, 0);
  if (process.platform !== "win32") assert.equal(run("git", ["switch", "-c", "cancel-feature"], { cwd: f.cwd }).status, 0);
  fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 2;\n");
  if (process.platform !== "win32") {
    assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
    assert.equal(run("git", ["commit", "-m", "cancellation review difference"], { cwd: f.cwd }).status, 0);
    assert.equal(run("git", ["diff", "--name-only", "main...HEAD"], { cwd: f.cwd }).stdout.trim(), "example.js");
  }
  const env = { ...f.env, CLAUDE_PLUGIN_DATA: path.join(f.cwd, "data"), GROK_COMPANION_SESSION_ID: "repro-host" };
  if (["win32", "linux", "darwin"].includes(process.platform)) {
    const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
    try {
      const stateDir = resolveStateDir(f.cwd);
      migrateStateLock(f.cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
      env.CANCEL_LOCK_REPRO_STATE_ENDPOINT = process.platform === "win32"
        ? resolveNativeStateLockEndpoint(stateDir) : path.join(stateDir, "state.lock", "native.lock");
    } finally {
      if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
  if (extraEnv.CANCEL_LOCK_REPRO_HOLD) {
    // workerだけを、cancel後のprogressがlockを取得した直後に止める。
    // 製品のstate実装は変更せず、ロック保持中のOS停止を決定的に再現する。
    const preload = path.join(f.cwd, "hold-progress-lock.cjs");
    fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const worker = process.argv.some((arg) => path.basename(arg) === "grok-companion.mjs") &&
  process.argv.some((arg) => arg === "review" || arg === "task");
const cancel = process.platform !== "win32" && process.argv.some((arg) => path.basename(arg) === "grok-companion.mjs") &&
  process.argv.some((arg) => arg === "cancel");
if (cancel) {
  const append = fs.appendFileSync;
  fs.appendFileSync = function(target, content, ...args) {
    const result = append.call(this, target, content, ...args);
    if (String(content).includes("Grok cancellation notification sent on")) {
      const gate = process.env.CANCEL_REVIEW_GATE;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !fs.existsSync(gate + ".held"))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      if (fs.existsSync(gate + ".held")) fs.writeFileSync(gate + ".cancel-saw-held", "held");
    }
    return result;
  };
  syncBuiltinESMExports();
}
if (worker) {
  const write = fs.writeFileSync;
  const listen = net.Server.prototype.listen;
  const expected = process.env.CANCEL_LOCK_REPRO_STATE_ENDPOINT;
  let held = false;
  const hold = () => {
    held = true;
    const gate = process.env.CANCEL_REVIEW_GATE;
    write(gate + ".held", String(process.pid));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !fs.existsSync(gate + ".unlock"))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  };
  net.Server.prototype.listen = function(...args) {
    const result = listen.apply(this, args);
    const target = typeof args[0] === "string" ? args[0] : args[0]?.path;
    const gate = process.env.CANCEL_REVIEW_GATE;
    if (!held && expected?.startsWith("\\\\.\\pipe\\grok-state-v2-") && target === expected &&
        this.listening === true && gate && fs.existsSync(gate + ".arm")) {
      hold();
    }
    return result;
  };
  const execFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function(command, args, options) {
    const result = execFileSync.apply(this, arguments);
    const gate = process.env.CANCEL_REVIEW_GATE;
    if (!held && gate && fs.existsSync(gate + ".arm") &&
        ((command === "/usr/bin/lockf" && JSON.stringify(args) === '["-s","-t","0","3"]') ||
         (command === "/usr/bin/flock" && JSON.stringify(args) === '["-x","-n","3"]')) &&
        typeof options?.stdio?.[3] === "number") {
      const actual = fs.fstatSync(options.stdio[3], { bigint: true });
      const target = fs.statSync(expected, { bigint: true });
      if (actual.dev === target.dev && actual.ino === target.ino) hold();
    }
    return result;
  };
  syncBuiltinESMExports();
}
`);
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require="${preload.replaceAll("\\", "/")}"`].filter(Boolean).join(" ");
  }
  const cli = (args) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 20000
  });
  const child = spawn(process.execPath, [companion, command, "--json", ...(command === "task" ? ["hold this turn"]
    : process.platform !== "win32" ? ["--scope", "branch", "--base", "main"] : [])],
    { cwd: f.cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  let workerStderr = "";
  child.stderr.on("data", (chunk) => { workerStderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  f.cleanup(async () => {
    fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await until(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited before its prompt: ${workerStderr}`);
    return f.logs().some((row) => row.prompt === "review-initial");
  }, `${command} prompt`);
  const status = cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).running[0];
  assert.equal(job.grokSessionId, "session-1");
  return { ...f, cli, job, worker: child };
}

test("stopping the late-progress native lock owner must not make final cancellation save time out", async (t) => {
  const f = await trackedFixture(t, "review", { CANCEL_PROGRESS_AFTER_CANCEL: "1", CANCEL_LOCK_REPRO_HOLD: "1" });
  const result = f.cli(["cancel", "--json", f.job.id]);
  assert.equal(result.error, undefined, result.error?.message);
  if (process.platform !== "win32") {
    assert.ok(fs.existsSync(f.env.CANCEL_REVIEW_GATE + ".held"), "the progress worker held its state lock");
    assert.ok(fs.existsSync(f.env.CANCEL_REVIEW_GATE + ".cancel-saw-held"),
      "cancellation must proceed past notification only after the progress worker holds the state lock");
    const persisted = JSON.parse(fs.readFileSync(path.join(path.dirname(f.job.logFile), `${f.job.id}.json`), "utf8"));
    assert.equal(persisted.status, "cancelled");
    assert.equal(persisted.phase, "termination-pending");
    assert.equal(persisted.terminationPending, true);
  }
  assert.ok(result.status === 0 || result.status === 1, `cancel exited unexpectedly: ${result.status}; ${result.stderr}`);
  if (result.status === 1) assert.match(result.stderr, /cancellation remains pending/i);
  assert.match(fs.readFileSync(f.job.logFile, "utf8"), /Tool: late tool progress/);
  assert.ok(fs.existsSync(f.env.CANCEL_REVIEW_GATE + ".held"), "the worker acquired and held the late-progress state lock");
  assert.doesNotMatch(result.stderr, /Timed out acquiring Grok state lock|Native state lock acquisition failed/,
    "the killed lock owner must not prevent the cancellation state from being saved");
});
test("a shared ignoreCancel turn keeps cancellation pending after its worker exits", async (t) => {
  const f = await trackedFixture(t, "task");
  const result = f.cli(["cancel", "--json", f.job.id]);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cancellation remains pending/i);
  assert.doesNotMatch(result.stderr, /Timed out acquiring|Native state lock acquisition failed|Could not stop|Cannot verify/);
  await until(() => f.worker.exitCode !== null || f.worker.signalCode !== null, "tracked worker exited");
  assert.ok(f.logs().some((row) => row.cancel === "session-1"));
  assert.ok(!f.logs().some((row) => row.terminal === "review-initial"), "the fake agent has not returned a terminal ACP response");
  const agentPid = f.logs().find((row) => row.started).started;
  assert.doesNotThrow(() => process.kill(agentPid, 0), "the isolated fake shared agent is still alive");
  const status = f.cli(["status", "--json", f.job.id]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.terminationPending, true,
    "a cancelled worker record does not prove the shared agent turn stopped");
});
