import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { migrateStateLock, resolveStateDir } from "../../plugins/grok/scripts/lib/state.mjs";
import { cleanupIdleBrokerSession, ensureBrokerSession, loadBrokerSession, requestIdleBrokerShutdown, resolveBrokerStateDir, saveBrokerSession } from "../../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: 切断された socket、既存 session の破損、未知 entry/link の削除、
// 超過時の spawn/pending/空 sessionDir の発生、UTF-8 byte 数の誤判定。
const [cwd, data, expectedName, mode] = process.argv.slice(2);
const state = resolveStateDir(cwd);
migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
const brokerDir = resolveBrokerStateDir(cwd);
const before = fs.existsSync(brokerDir) ? fs.readdirSync(brokerDir).sort() : [];
let spawned = 0;
let session;
try {
  if (mode === "legacy") {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, "gkc-"));
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
    await new Promise(resolve => child.once("close", resolve));
    const generation = "legacy-cleanup-generation";
    session = { generation, endpoint: `unix:${path.join(dir, "broker.sock")}`, pid: child.pid, sessionDir: dir,
      logFile: path.join(dir, "broker.log"), pidFile: path.join(dir, "broker.pid"), shutdownAcceptedGeneration: generation,
      ownedGroup: { pgid: child.pid, generation, platform: process.platform } };
    fs.writeFileSync(session.logFile, "legacy diagnostic"); fs.writeFileSync(session.pidFile, String(child.pid));
    saveBrokerSession(cwd, session);
    assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(loadBrokerSession(cwd), null);
    session = null;
    console.log(JSON.stringify({ ok: true, mode }));
    process.exit(0);
  }
  session = await ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn: () => { spawned++; } });
  assert.notEqual(mode, "too-long", "oversized path must fail before spawn");
  if (!session) {
    const dirs = fs.readdirSync(process.env.TMPDIR).filter(name => name.startsWith("gkc-"));
    throw new Error(`Broker did not start: ${dirs.map(name => { const log = path.join(process.env.TMPDIR, name, "broker.log"); return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : name; }).join("\n")}`);
  }
  assert.equal(spawned, 1);
  assert.equal(path.basename(session.endpoint.slice(5)), expectedName);
  assert.equal(fs.lstatSync(session.endpoint.slice(5)).isSocket(), true);
  assert.deepEqual(fs.readdirSync(session.sessionDir).sort(), [expectedName, "broker.log", "broker.pid"].sort());
  if (mode === "unknown" || mode === "link") {
    const extra = path.join(session.sessionDir, mode === "link" ? "unknown-link" : "broker.soc");
    if (mode === "link") fs.symlinkSync(session.logFile, extra); else fs.writeFileSync(extra, "preserve");
    assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), false);
    assert.equal(fs.lstatSync(extra).isSymbolicLink(), mode === "link");
    assert.equal(loadBrokerSession(cwd).generation, session.generation);
    fs.unlinkSync(extra);
  }
  assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), true);
  assert.equal(fs.existsSync(session.sessionDir), false);
  assert.equal(loadBrokerSession(cwd), null);
  console.log(JSON.stringify({ ok: true, mode, name: expectedName }));
} catch (error) {
  if (mode !== "too-long") {
    if (session) await requestIdleBrokerShutdown(session, 4000);
    throw error;
  }
  assert.match(error.message, /socket.*(long|length)|too long/i);
  assert.equal(spawned, 0);
  assert.equal(loadBrokerSession(cwd), null);
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
  const after = fs.existsSync(brokerDir) ? fs.readdirSync(brokerDir).sort() : [];
  const journal = path.join(brokerDir, "broker-admission.jsonl");
  assert.equal(fs.existsSync(journal) && fs.readFileSync(journal, "utf8").includes('"event":"pending"'), false);
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ ok: true, mode, error: error.message }));
}
