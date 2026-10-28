import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac 親子 process を使い、procfs/mount/flock は模擬する。
// 実 Linux directory flock・process 生命周期・電源断の証明ではない。
for (const stage of ["bootstrap-marker", "sentinel-ready"]) {
  test(`migration root lock survives parent death during ${stage}`, {
    skip: process.platform !== "darwin", timeout: 180000
  }, async t => {
    const root = fs.realpathSync(makeTempDir("grok-linux-descendant-lock-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace");
    for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
    const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace), barrier = path.join(stateDir, "state.lock");
    const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const pause = fileURLToPath(new URL("./fixtures/linux-history-migration-descendant-pause.mjs", import.meta.url));
    const contender = fileURLToPath(new URL("./fixtures/linux-history-root-flock-contender.mjs", import.meta.url));
    const ready = path.join(root, "descendant-ready"), release = path.join(root, "descendant-release"),
      committed = path.join(root, "descendant-last-fsync");
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(pause)}`.trim() };
    delete env.PLUGIN_DATA; delete env.GROK_HISTORY_DESCENDANT_STAGE;
    const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
    let migration, migrationClosed, verifiedDone = false;
    t.after(async () => {
      try {
        if (!fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
        if (migration && migration.exitCode === null && migration.signalCode === null) migration.kill("SIGTERM");
        if (migrationClosed) await migrationClosed;
        if (!verifiedDone && fs.existsSync(barrier)) {
          // 解放直後の bootstrap は ready をまだ確定中かもしれない。
          let stopped = false;
          for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
            const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
            stopped = stop.status === 0;
          }
          if (!stopped) t.diagnostic(`Sentinel shutdown unconfirmed; preserving ${root}`);
        }
        if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
        else t.diagnostic(`Retained descendant lock fixture: ${root}`);
      } finally {
        for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    });
    const start = (argv, childEnv) => {
      const child = spawn(process.execPath, [command, ...argv], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
      const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      return { child, closed, exited };
    };
    const initial = start(["state-lock", "migrate", ...args], { ...env, GROK_HISTORY_DESCENDANT_STAGE: stage,
      GROK_HISTORY_DESCENDANT_READY: ready, GROK_HISTORY_DESCENDANT_RELEASE: release, GROK_HISTORY_DESCENDANT_COMMITTED: committed });
    migration = initial.child; migrationClosed = initial.closed;
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(ready) && migration.exitCode === null && migration.signalCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(ready), "a writing descendant must reach the selected fsync boundary");
    const descendantPid = Number(fs.readFileSync(ready, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0 && descendantPid !== migration.pid);
    migration.kill("SIGKILL");
    const parentExit = await initial.exited; assert.equal(parentExit.signal, "SIGKILL");
    const namespace = path.join(stateDir, "history-journal-v1");
    const epochs = fs.readdirSync(namespace).filter(name => /^[0-9a-f-]{36}$/i.test(name));
    assert.equal(epochs.length, 1);
    const probe = () => spawnSync(process.execPath, [contender], { env, encoding: "utf8", timeout: 10000 });
    const whileWriting = probe();
    t.diagnostic(`${stage}: fsync injection reached in pid ${descendantPid}; nonblocking root flock: ${whileWriting.stdout.trim() || whileWriting.stderr.trim()}`);
    assert.equal(whileWriting.status, 73, `root flock must be busy while a writing descendant survives; probe status ${whileWriting.status}, output: ${whileWriting.stdout} ${whileWriting.stderr}`);
    assert.ok(fs.existsSync(barrier), "the in-progress barrier must be preserved");
    fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
    const activeDescendants = () => fs.readdirSync(path.join(root, "processes")).filter(name => /^\d+\.json$/.test(name)).some(name => {
      const record = JSON.parse(fs.readFileSync(path.join(root, "processes", name), "utf8"));
      if (!record.argv?.[1]?.endsWith("linux-state-sentinel.mjs") || !["bootstrap", "sentinel"].includes(record.argv[2])) return false;
      try { process.kill(Number(name.slice(0, -5)), 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    });
    const finishDeadline = Date.now() + 10000;
    while (!fs.existsSync(committed) && activeDescendants() && Date.now() < finishDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(committed) || !activeDescendants(), "the ready directory fsync or all writer exits must be observed");
    let afterWrite = probe();
    const unlockDeadline = Date.now() + 6000;
    while (afterWrite.status === 73 && Date.now() < unlockDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50)); afterWrite = probe();
    }
    assert.equal(afterWrite.status, 0, `root flock must become available after the last writer: ${afterWrite.stderr}`);
    await migrationClosed;
    const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
    if (stop.status !== 0) {
      const stopDeadline = Date.now() + 10000;
      while (activeDescendants() && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!activeDescendants(), `descendant exit must be independently confirmed: ${stop.stderr}`);
    }
    verifiedDone = true;
  });
}
