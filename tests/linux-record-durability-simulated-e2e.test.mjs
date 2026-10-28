import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Mac 上で Node・実ファイル・lockf を使う CLI 模擬。procfs/mount は fixture 値。
// fsync 障害を注入するが、Linux kernel の mount pin・耐久性・電源断は証明しない。
// 故障条件: 未同期または部分保存の record を公開して agent 起動、異なる mount や
// symbolic jobs を追従、rename 失敗後に成功扱い、片側保存後の crash を成功扱い。
for (const fault of ["detail-file-fsync", "index-file-fsync", "detail-dir-fsync", "index-dir-fsync",
  "detail-rename", "index-rename", "detail-partial-write", "index-partial-write", "detail-crash", "index-crash",
  "jobs-mount", "jobs-symlink", "orphan-temp", "orphan-index-temp"]) {
  test(`simulated Linux CLI fails closed on ${fault}`, { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const root = fs.realpathSync(makeTempDir("grok-linux-record-fault-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
    fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace);
    const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
    const wrapper = path.join(root, "fake-grok"), agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned");
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
      GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid,
      GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker, GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1" };
    const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
    let migrated = false, worker, closed;
    t.after(async () => {
      try {
        if (worker) {
          if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
          await closed;
        }
        let agentStopped = !fs.existsSync(spawnMarker);
        if (fs.existsSync(agentPid)) {
          const pid = Number(fs.readFileSync(agentPid, "utf8")), deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            try { process.kill(pid, 0); }
            catch (error) { if (error.code === "ESRCH") { agentStopped = true; break; } throw error; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        if (migrated && agentStopped) {
          const stopped = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
          assert.equal(stopped.status, 0, stopped.stderr);
        } else if (migrated) t.diagnostic(`Retained sentinel; agent exit is unconfirmed: ${root}`);
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        t.diagnostic(`Record fault fixture retained: ${root}`);
      }
    });
    const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(migration.status, 0, migration.stderr);
    migrated = true;
    const stateFile = path.join(stateDir, "state.json"), jobs = path.join(stateDir, "jobs");
    const beforeIndex = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
    let symlinkTarget, orphanTemp, ledgerFile, beforeLedger;
    if (fault === "jobs-symlink") {
      symlinkTarget = path.join(root, "outside-jobs");
      fs.mkdirSync(symlinkTarget, { mode: 0o700 });
      if (fs.existsSync(jobs)) fs.renameSync(jobs, path.join(root, "preserved-jobs"));
      fs.symlinkSync(symlinkTarget, jobs, "dir");
    }
    if (fault === "orphan-temp" || fault === "orphan-index-temp") {
      orphanTemp = fault === "orphan-temp" ? path.join(jobs, "old.json.incomplete.tmp") : path.join(stateDir, "state.json.incomplete.tmp");
      fs.writeFileSync(orphanTemp, "unconfirmed partial detail", { flag: "wx", mode: 0o600 });
      const epoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
      ledgerFile = path.join(stateDir, "worker-leases-v1", epoch, "ledger.json");
      beforeLedger = fs.readFileSync(ledgerFile, "utf8");
    }
    worker = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "record fault"], {
      env: { ...env, GROK_LINUX_SIM_RECORD_FAULT: fault }, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = ""; worker.stderr.on("data", chunk => { stderr += chunk; });
    closed = new Promise(resolve => worker.once("close", resolve));
    const deadline = Date.now() + 15000;
    while (worker.exitCode === null && worker.signalCode === null && !fs.existsSync(agentPid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (worker.exitCode !== null || worker.signalCode !== null) await closed;
    assert.equal(fs.existsSync(agentPid), false, `agent started after ${fault}: ${stderr}`);
    assert.notEqual(worker.exitCode, null, `task did not reject ${fault}: ${stderr}`);
    assert.notEqual(worker.exitCode, 0, `task accepted ${fault}: ${stderr}`);
    if (fault === "jobs-symlink") assert.deepEqual(fs.readdirSync(symlinkTarget), [], "symbolic jobs target was modified");
    else if (fault === "orphan-temp" || fault === "orphan-index-temp") {
      assert.equal(fs.readFileSync(orphanTemp, "utf8"), "unconfirmed partial detail");
      assert.equal(fs.readFileSync(ledgerFile, "utf8"), beforeLedger, "reservation was created despite an uncertain temporary record");
      assert.equal(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null, beforeIndex);
    } else assert.equal(fs.readFileSync(path.join(root, "record-fault-injected"), "utf8"), fault);
    if (["index-file-fsync", "index-rename", "index-partial-write", "detail-crash"].includes(fault)) {
      assert.equal(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null, beforeIndex,
        "index changed before its durable commit");
    }
    if (fault === "index-dir-fsync") {
      assert.notEqual(fs.readFileSync(stateFile, "utf8"), beforeIndex, "fixture did not reach the post-rename index");
      assert.match(stderr, /(?:commit|state).*(?:outcome|result).*(?:unknown|uncertain)/i,
        "the user must be told the saved index outcome is unknown");
    }
    if (fault === "index-crash") {
      assert.ok(fs.existsSync(stateFile), "crashed publication did not retain its index");
      assert.ok(fs.readdirSync(jobs).some(name => name.endsWith(".json")), "crashed publication did not retain its detail");
    }
  });
}
