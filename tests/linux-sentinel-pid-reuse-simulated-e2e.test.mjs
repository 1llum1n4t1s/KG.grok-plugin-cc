import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 失敗条件: 同 tick の別個体を待ち続ける、停止前に FD を固定しない、
// 読取拒否や不正 stat を停止済みと扱う、失敗経路で FD を閉じない。
// Mac の実プロセスと CLI を使い procfs は模擬する。Linux 実機検証ではない。
for (const scenario of ["reuse", "open-denied", "read-denied", "malformed", "stop-fail"]) {
  test(`stop-sentinel handles pinned proc FD: ${scenario}`, { skip: process.platform !== "darwin", timeout: 45000 }, t => {
    const root = fs.realpathSync(makeTempDir("grok-sentinel-reuse-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace");
    for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
    const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace);
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const base = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const fault = fileURLToPath(new URL("./fixtures/linux-sentinel-pid-reuse-preload.mjs", import.meta.url));
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(base)} --import ${JSON.stringify(fault)}`.trim() };
    delete env.PLUGIN_DATA;
    const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace, "--json"];
    const run = (action, extra = {}) => spawnSync(process.execPath, [command, "state-lock", action, ...args],
      { env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 });
    let pid;
    t.after(() => {
      if (pid) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") pid = undefined; else throw error; }
      }
      if (pid) {
        const cleanup = run("stop-sentinel", { GROK_SENTINEL_REUSE_SCENARIO: "reuse" });
        if (cleanup.status !== 0) { t.diagnostic(`Retained fixture with unconfirmed sentinel: ${root}`); return; }
      }
      removeTempFixture(root, { recursive: true, force: true });
    });
    const migration = run("migrate");
    assert.equal(migration.status, 0, migration.stderr);
    pid = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).sentinel.pid;
    const result = run("stop-sentinel", { GROK_SENTINEL_REUSE_SCENARIO: scenario });
    const auditPath = path.join(root, "sentinel-fd-audit");
    const events = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n") : [];
    if (scenario === "reuse") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).stopped, true);
      assert.ok(events.includes("open") && events.indexOf("open") < events.indexOf("stop") && events.includes("ack"), events.join(","));
      assert.ok(events.includes("read-fd") && events.includes("close"), events.join(","));
      assert.equal(events.includes("read-reused-path"), false);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /sentinel|recovery/i);
      assert.ok(events.includes("open"), events.join(","));
      if (scenario === "open-denied") assert.equal(events.includes("stop"), false);
      else {
        assert.ok(events.indexOf("open") < events.indexOf("stop") && events.includes("close"), events.join(","));
        if (scenario !== "stop-fail") assert.ok(events.includes("ack") && events.includes("read-fd"), events.join(","));
        else assert.equal(events.includes("ack"), false);
        if (scenario === "malformed") assert.ok(events.includes("truncated-stat"), events.join(","));
      }
    }
  });
}
