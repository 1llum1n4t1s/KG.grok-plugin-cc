import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
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
const identity = file => { const s = fs.lstatSync(file, { bigint: true }); return `${s.dev}:${s.ino}`; };
async function assertEndpointStopped(endpoint) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("stopped broker endpoint did not refuse a connection")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("stopped broker endpoint accepted a connection")); });
    socket.once("error", error => { socket.destroy(); error.code === "ECONNREFUSED" ? resolve() : reject(error); });
  });
}
let spawned = 0;
let session;
let brokerChild, brokerClosed, brokerCloseResult, brokerExited = false;
try {
  if (mode === "legacy" || mode === "legacy-socket") {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, "gkc-"));
    const endpoint = path.join(dir, "broker.sock");
    const script = mode === "legacy-socket"
      ? "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))"
      : "process.exit(0)";
    const child = spawn(process.execPath, ["-e", script, endpoint], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let childError = "";
    child.stderr.on("data", chunk => { childError += chunk; });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    assert.equal(code, 0, childError);
    assert.equal(signal, null);
    const generation = "legacy-cleanup-generation";
    session = { generation, endpoint: `unix:${path.join(dir, "broker.sock")}`, pid: child.pid, sessionDir: dir, ownerPlatform: process.platform,
      logFile: path.join(dir, "broker.log"), pidFile: path.join(dir, "broker.pid"), shutdownAcceptedGeneration: generation,
      ownedGroup: { pgid: child.pid, generation, platform: process.platform } };
    fs.writeFileSync(session.logFile, "legacy diagnostic"); fs.writeFileSync(session.pidFile, String(child.pid));
    const legacyPaths = [dir, session.logFile, session.pidFile, ...(mode === "legacy-socket" ? [endpoint] : [])];
    if (mode === "legacy-socket") assert.equal(fs.lstatSync(endpoint).isSocket(), true);
    const legacyIdentities = legacyPaths.map(identity);
    saveBrokerSession(cwd, session);
    const stateFile = path.join(brokerDir, "broker.json");
    const stateIdentity = identity(stateFile);
    const stateBytes = fs.readFileSync(stateFile);
    const savedSession = loadBrokerSession(cwd);
    const journal = path.join(brokerDir, "broker-admission.jsonl");
    assert.equal(fs.existsSync(journal), false);
    for (const pid of [child.pid, -child.pid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), false);
    assert.deepEqual(loadBrokerSession(cwd), savedSession);
    assert.equal(identity(stateFile), stateIdentity);
    assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
    assert.deepEqual(legacyPaths.map(identity), legacyIdentities);
    assert.equal(fs.readFileSync(session.logFile, "utf8"), "legacy diagnostic");
    assert.equal(fs.readFileSync(session.pidFile, "utf8"), String(child.pid));
    assert.equal(fs.existsSync(journal), false);
    for (const pid of [child.pid, -child.pid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    // 合成した旧 endpoint の確定済み admission。child と group は実際に終了済み。
    fs.mkdirSync(brokerDir, { recursive: true });
    const base = { version: 2, generation };
    const entries = [
      { ...base, event: "pending", ownerPid: process.pid, platform: process.platform, lockToken: "fixture",
        endpoint: session.endpoint, sessionDir: dir, pidFile: session.pidFile, logFile: session.logFile },
      { ...base, event: "spawned", pid: child.pid, pgid: child.pid },
      { ...base, event: "settled", pid: child.pid, outcome: "ready" },
      { ...base, event: "confirmed", pid: child.pid, outcome: "ready" }
    ];
    fs.writeFileSync(journal, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const journalIdentity = identity(journal);
    const journalBytes = fs.readFileSync(journal);
    assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["broker.log", "broker.pid", ...(mode === "legacy-socket" ? ["broker.sock"] : [])].sort());
    assert.deepEqual(legacyPaths.map(identity), legacyIdentities);
    if (mode === "legacy-socket") assert.equal(fs.lstatSync(endpoint).isSocket(), true);
    assert.equal(fs.readFileSync(session.logFile, "utf8"), "legacy diagnostic");
    assert.equal(fs.readFileSync(session.pidFile, "utf8"), String(child.pid));
    for (const pid of [child.pid, -child.pid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    if (mode === "legacy-socket") await assertEndpointStopped(endpoint);
    assert.equal(identity(journal), journalIdentity);
    assert.deepEqual(fs.readFileSync(journal), journalBytes);
    assert.equal(loadBrokerSession(cwd), null);
    session = null;
    console.log(JSON.stringify({ ok: true, mode }));
    process.exit(0);
  }
  session = await ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn: child => {
    spawned++;
    brokerChild = child;
    child.ref();
    child.once("exit", () => { brokerExited = true; });
    brokerClosed = new Promise(resolve => child.once("close", (code, signal) => {
      brokerCloseResult = { code, signal };
      resolve(brokerCloseResult);
    }));
  } });
  assert.notEqual(mode, "too-long", "oversized path must fail before spawn");
  if (!session) {
    const dirs = fs.readdirSync(process.env.TMPDIR).filter(name => name.startsWith("gkc-"));
    throw new Error(`Broker did not start: ${dirs.map(name => { const log = path.join(process.env.TMPDIR, name, "broker.log"); return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : name; }).join("\n")}`);
  }
  assert.equal(spawned, 1);
  assert.ok(brokerChild);
  assert.equal(brokerChild.pid, session.pid);
  assert.equal(loadBrokerSession(cwd).pid, brokerChild.pid);
  assert.equal(path.basename(session.endpoint.slice(5)), expectedName);
  assert.equal(fs.lstatSync(session.endpoint.slice(5)).isSocket(), true);
  assert.deepEqual(fs.readdirSync(session.sessionDir).sort(), [expectedName, "broker.log", "broker.pid"].sort());
  const paths = [session.sessionDir, session.logFile, session.pidFile, session.endpoint.slice(5)];
  const identities = paths.map(identity);
  const beforeLog = fs.readFileSync(session.logFile);
  const beforePid = fs.readFileSync(session.pidFile);
  if (mode === "unknown" || mode === "link") {
    const extra = path.join(session.sessionDir, mode === "link" ? "unknown-link" : "broker.soc");
    if (mode === "link") fs.symlinkSync(session.logFile, extra); else fs.writeFileSync(extra, "preserve");
    const extraIdentity = identity(extra);
    const stateFile = path.join(brokerDir, "broker.json");
    const stateIdentity = identity(stateFile);
    const stateBytes = fs.readFileSync(stateFile);
    const savedSession = loadBrokerSession(cwd);
    assert.equal(brokerExited, false);
    assert.equal(brokerCloseResult, undefined);
    for (const pid of [session.pid, -session.ownedGroup.pgid]) assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), false);
    assert.equal(fs.lstatSync(extra).isSymbolicLink(), mode === "link");
    assert.equal(identity(extra), extraIdentity);
    assert.deepEqual(paths.map(identity), identities);
    if (mode === "link") assert.equal(fs.readlinkSync(extra), session.logFile);
    else assert.equal(fs.readFileSync(extra, "utf8"), "preserve");
    assert.deepEqual(loadBrokerSession(cwd), savedSession);
    assert.equal(identity(stateFile), stateIdentity);
    assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
    for (const pid of [session.pid, -session.ownedGroup.pgid]) assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(brokerExited, false);
    assert.equal(brokerCloseResult, undefined);
    assert.equal(brokerChild.exitCode, null);
    assert.equal(brokerChild.signalCode, null);
    fs.unlinkSync(extra);
  }
  assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), true);
  let closeTimer;
  try {
    await Promise.race([brokerClosed, new Promise((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error(`owned broker child ${brokerChild.pid} did not close`)), 2000);
    })]);
  } finally { clearTimeout(closeTimer); }
  assert.equal(brokerExited, true);
  assert.ok(brokerCloseResult);
  assert.equal(brokerChild.pid, session.pid);
  assert.deepEqual(paths.map(identity), identities);
  assert.deepEqual(fs.readdirSync(session.sessionDir).sort(), [expectedName, "broker.log", "broker.pid"].sort());
  assert.equal(fs.lstatSync(session.endpoint.slice(5)).isSocket(), true);
  assert.deepEqual(fs.readFileSync(session.pidFile), beforePid);
  assert.equal(fs.readFileSync(session.logFile).subarray(0, beforeLog.length).equals(beforeLog), true);
  for (const pid of [session.pid, -session.ownedGroup.pgid]) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  await assertEndpointStopped(session.endpoint.slice(5));
  assert.equal(loadBrokerSession(cwd), null);
  console.log(JSON.stringify({ ok: true, mode, name: expectedName }));
} catch (error) {
  if (mode !== "too-long") {
    if (session) await requestIdleBrokerShutdown(session, 4000);
    if (brokerChild) {
      console.error(`Owned broker child pid=${brokerChild.pid} exited=${brokerExited} closed=${!!brokerCloseResult}; fixture retained`);
      brokerChild.unref();
    }
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
