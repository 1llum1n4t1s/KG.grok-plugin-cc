import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { getProcessSnapshot, quoteShellArgument } from "../plugins/grok/scripts/lib/process.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";

// 失敗条件: handshake失敗、誤ったPID/PGID/開始識別子、残存groupの成功誤認、
// inheritから親へのsignal、broker起動中のgroup逃走、失敗時の孤児、環境の漏洩、
// Windowsでのfixture作成・削除。実ACP/子プロセス経路だけを隔離fixtureで通す。
const enabled = process.platform === "linux" || process.platform === "darwin";
const options = { skip: !enabled, timeout: 30_000 };
const fake = fileURLToPath(new URL("./fixtures/posix-owned-agent.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  do {
    if (predicate()) return;
    await sleep(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function processGroup(pid) {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[2]);
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 1_000 });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function processRunning(pid) {
  try { process.kill(pid, 0); }
  catch (error) { return error.code !== "ESRCH"; }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const boundary = stat.lastIndexOf(") ");
      const fields = stat.slice(boundary + 2).trim().split(/\s+/);
      // 取得失敗や不正なstatは生存不明のまま保持する。
      return !stat.startsWith(`${pid} (`) || boundary < 0 || fields.length < 20 || fields[0] !== "Z";
    } catch { return true; }
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1_000 });
  return Boolean(result.error) || result.status !== 0 || !/^Z[+<>=A-Za-z-]*$/.test(result.stdout.trim());
}

function fixture(mode) {
  const directory = makeTempDir("grok-posix-owned-e2e-");
  const executable = path.join(directory, "fake-grok");
  fs.writeFileSync(executable, `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(fake)}\n`, { mode: 0o700 });
  // 実ユーザーの鍵、Grok設定、broker endpoint、NODE_OPTIONSを子へ渡さない。
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    CLAUDE_PLUGIN_DATA: path.join(directory, "data"), PLUGIN_DATA: path.join(directory, "data"),
    POSIX_OWNED_FIXTURE: directory, POSIX_OWNED_MODE: mode, GROK_BIN: executable };
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  process.env.PLUGIN_DATA = env.PLUGIN_DATA;
  migrateStateLock(directory, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(directory) });
  const pid = (name) => Number(fs.readFileSync(path.join(directory, `${name}.pid`), "utf8"));
  async function cleanup(child) {
    fs.writeFileSync(path.join(directory, "stop"), "stop");
    // signalは所有ChildProcessの生存guardをtimer phase内で確認してから送る。
    await new Promise((resolve) => setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
      resolve();
    }, 0));
    await until(() => ["agent", "grandchild"].every((name) => {
      const file = path.join(directory, `${name}.pid`);
      return !fs.existsSync(file) || !processRunning(pid(name));
    }) && (!child || child.exitCode !== null || child.signalCode !== null), "fixture processes stopped", 14_000);
    try { removeTempFixture(directory, { recursive: true, force: true }); }
    finally {
      previous.claude === undefined ? delete process.env.CLAUDE_PLUGIN_DATA : process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      previous.plugin === undefined ? delete process.env.PLUGIN_DATA : process.env.PLUGIN_DATA = previous.plugin;
    }
  }
  return { directory, executable, env, pid, cleanup };
}

for (const mode of ["normal", "remaining", "inherit"]) {
  test(`POSIX real ACP close: ${mode}`, options, async () => {
    const f = fixture(mode);
    let client;
    let parentSignals = 0;
    const onSignal = () => { parentSignals += 1; };
    process.on("SIGTERM", onSignal);
    try {
      client = await GrokAcpClient.connect(f.directory, { disableBroker: true,
        grokBin: f.executable, env: f.env, ...(mode === "inherit" ? { posixGroupMode: "inherit" } : {}) });
      const pid = f.pid("agent");
      assert.equal(client.proc.pid, pid);
      assert.equal(processGroup(pid), mode === "inherit" ? processGroup(process.pid) : pid);
      const snapshot = getProcessSnapshot(pid);
      assert.ok(snapshot?.startKey);
      assert.equal(getProcessSnapshot(pid).startKey, snapshot.startKey);
      if (process.platform === "linux") {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const tick = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
        assert.equal(snapshot.startKey, `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${tick}`);
      }
      await client.close();
      assert.equal(parentSignals, 0);
      assert.equal(processRunning(pid), false);
      if (mode === "normal") {
        assert.equal(client.directAgentStopProof(), "posix-group-empty");
        assert.notEqual(client.closeStopUnconfirmed, true);
        assert.equal(groupExists(pid), false);
      } else {
        assert.equal(client.directAgentStopProof(), false);
        assert.equal(client.closeStopUnconfirmed, true);
        if (mode === "remaining") {
          const grandchild = f.pid("grandchild");
          assert.equal(processRunning(grandchild), true);
          assert.equal(processGroup(grandchild), pid);
        }
      }
    } finally {
      // connectが失敗した場合もfake自身のmarker/deadlineで回収する。
      try { if (client) await client.close(); }
      finally {
        try { await f.cleanup(client?.proc); }
        finally { process.removeListener("SIGTERM", onSignal); }
      }
    }
  });
}

test("POSIX real broker startup keeps its agent inside its owned group", options, async (t) => {
  const f = fixture("handshake");
  const endpoint = `unix:${path.join(f.directory, "b")}`;
  let resolveChild;
  const childReady = new Promise(resolve => { resolveChild = resolve; });
  const starting = startFixtureBroker(f.directory, f.env, endpoint, { onChild: resolveChild });
  void starting.catch(() => {});
  let broker;
  try {
    broker = await Promise.race([childReady, starting.then(() => { throw new Error("Broker started before child observation"); })]);
    await until(() => {
      if (broker.exitCode !== null || broker.signalCode !== null) throw new Error("Broker exited before handshake");
      return fs.existsSync(path.join(f.directory, "agent.pid"));
    }, "broker spawned its agent");
    const agent = f.pid("agent");
    assert.equal(processGroup(broker.pid), broker.pid);
    assert.equal(processGroup(agent), broker.pid);
    await new Promise((resolve, reject) => setTimeout(() => {
      try {
        assert.equal(broker.exitCode, null);
        assert.equal(broker.signalCode, null);
        assert.equal(broker.killed, false);
        // このdetached spawnの未reap leaderがPGIDを保持する同期区間だけで送る。
        process.kill(-broker.pid, "SIGTERM");
        resolve();
      } catch (error) { reject(error); }
    }, 0));
    await until(() => !processRunning(agent), "broker fake agent exited");
    try {
      await until(() => !groupExists(broker.pid), "owned broker group disappeared");
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      // 停止とgroup不在の証拠を分け、権限不明を成功へ読み替えない。
      t.skip("Fake agent exited, but EPERM leaves broker group emptiness unconfirmed");
    }
  } finally {
    await starting.catch(() => {});
    await f.cleanup(broker);
  }
});
