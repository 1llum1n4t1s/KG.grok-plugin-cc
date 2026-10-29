import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateStateLock, updateState, listJobs, writeJobFile, resolveJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { saveBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { getProcessSnapshot } from "../plugins/grok/scripts/lib/process.mjs";

// 実アカウントや既存 state に触れず、明示された専用 root 上の macOS でのみ実行する。
const root = process.env.GROK_CANCEL_CONFLICT_ROOT;
const enabled = process.platform === "darwin" && Boolean(root);
const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const hook = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));

function releaseUnconfirmed(child, fixture, reason) {
  // 所有権を証明できない process へ信号を送らず、runner 側の参照だけを閉じる。
  try { if (child.connected) child.disconnect(); } catch { /* 既に切断されている場合もある。 */ }
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* 他の参照も必ず解放する。 */ }
  }
  try { child.unref(); } catch { /* spawn 不成立なら process handle はない。 */ }
  return new Error(`${reason}; child PID ${child.pid ?? "unavailable"}; retained ${fixture}`);
}

function workerMessage(worker, fixture) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); worker.removeListener("message", onMessage); worker.removeListener("error", onError); worker.removeListener("close", onClose); };
    const onMessage = message => { cleanup(); resolve(message); };
    const onError = error => { cleanup(); reject(new Error(`Worker error: ${error.message}; retained ${fixture}`)); };
    const onClose = (code, signal) => { cleanup(); reject(new Error(`Worker closed before message (${code ?? signal}); retained ${fixture}`)); };
    worker.once("message", onMessage); worker.once("error", onError); worker.once("close", onClose);
    timer = setTimeout(() => { cleanup(); reject(new Error(`Worker ${worker.pid} message timed out; retained ${fixture}`)); }, 8000);
  });
}

async function workerClose(closed, worker, fixture) {
  let timer;
  try { return await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Worker ${worker.pid} close timed out; retained ${fixture}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}

function run(file, args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stdinError, startKey, timer, killTimer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      if (error) reject(error); else resolve(result);
    };
    child.once("spawn", () => { startKey = getProcessSnapshot(child.pid, { processLookupDeadline: performance.now() + 1000 })?.startKey; });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", error => { stdinError = error; });
    child.on("error", error => { if (!settled) finish(releaseUnconfirmed(child, env.TMPDIR, `Child error: ${error.message}`)); });
    child.once("close", (code, signal) => finish(null, { code, signal, stdout, stderr, stdinError }));
    timer = setTimeout(() => {
      const group = pid => spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
      const childGroup = group(child.pid), ownGroup = group(process.pid);
      if (!startKey || getProcessSnapshot(child.pid, { processLookupDeadline: performance.now() + 1000 })?.startKey !== startKey || childGroup.status !== 0 || ownGroup.status !== 0 ||
          childGroup.stdout.trim() !== ownGroup.stdout.trim()) {
        return finish(releaseUnconfirmed(child, env.TMPDIR, "Child identity/group is unconfirmed"));
      }
      try {
        if (!child.kill("SIGTERM")) return finish(releaseUnconfirmed(child, env.TMPDIR, "Child stop failed"));
      } catch (error) { return finish(releaseUnconfirmed(child, env.TMPDIR, `Child stop failed: ${error.message}`)); }
      killTimer = setTimeout(() => {
        finish(releaseUnconfirmed(child, env.TMPDIR, "Child exit is unconfirmed"));
      }, 4000);
    }, 10000);
    child.stdin.end(input);
  });
}

const cases = [
  { name: "index pending, file not-sent", index: ["pending", "s"], file: ["not-sent", "s"], conflict: true },
  { name: "index not-sent, file pending", index: ["not-sent", "s"], file: ["pending", "s"], conflict: true },
  { name: "different session", index: ["pending", "active"], file: ["pending", "old"], conflict: true },
  { name: "missing file", index: ["pending", "s"], file: null, conflict: true },
  { name: "legacy fields missing", index: [], file: [], legacy: true },
  { name: "legacy null and missing", index: [null, null], file: [], legacy: true },
  { name: "matching pending", index: ["pending", "s"], file: ["pending", "s"] },
  { name: "matching not-sent", index: ["not-sent", "s"], file: ["not-sent", "s"] }
];
cases.push(...cases.filter(entry => entry.conflict).map(entry => ({ ...entry, name: `${entry.name}, first request`, fresh: true })));
cases.push({ ...cases[0], name: `${cases[0].name}, live worker`, fresh: true, live: true });

for (const entry of cases) for (const mode of ["cancel", "SessionEnd"]) {
  test(`macOS ${mode}: ${entry.name}`, { skip: !enabled, timeout: 45000 }, async t => {
    assert.ok(path.isAbsolute(root));
    assert.equal(fs.realpathSync(root), root);
    fs.accessSync(root, fs.constants.W_OK);
    const fixture = fs.mkdtempSync(path.join(root, "f-"));
    t.diagnostic(`Retained fixture: ${fixture}`);
    const cwd = path.join(fixture, "work"), data = path.join(fixture, "data"), bin = path.join(fixture, "bin");
    fs.mkdirSync(cwd); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\ncase \"$*\" in *--version*) echo 'git version 2.50.0';; *) echo 'fatal: not a git repository' >&2; exit 128;; esac\n", { mode: 0o700 });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, TMPDIR: fixture, PATH: `${bin}:/usr/bin:/bin` };
    const previous = { CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PATH: env.PATH, TMPDIR: fixture });
    const seen = [], generation = "fixture-generation", endpoint = path.join(fixture, "b.sock");
    const sockets = new Set(), brokerErrors = [];
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.on("error", error => { brokerErrors.push(`socket: ${error.message}`); socket.destroy(); });
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          let request;
          try { request = JSON.parse(buffer.slice(0, end)); }
          catch (error) { brokerErrors.push(`invalid broker request: ${error.message}`); socket.destroy(); return; }
          buffer = buffer.slice(end + 1); seen.push(request);
          const result = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, _meta: { grokExecutionLedger: true, grokBrokerGeneration: generation } }
            : { generation, executionState: request.params?.sessionId === "active" ? "accepted" : "never-accepted",
              reservationAccepted: true, notificationSent: false };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
    server.on("error", error => { brokerErrors.push(`server: ${error.message}`); });
    try {
      await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint, resolve));
      migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true });
      saveBrokerSession(cwd, { generation, endpoint: `unix:${endpoint}`, pid: process.pid, authMode: "browser" });
      const worker = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], { cwd, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      worker.stderr.resume();
      const workerClosed = new Promise(resolve => worker.once("close", resolve));
      worker.on("error", () => { /* 停止未確認の場合は所有情報とともに t.after で報告する。 */ });
      let workerStartKey;
      t.after(async () => {
        if (worker.exitCode === null && worker.signalCode === null && worker.connected) {
          try { worker.send("finish"); }
          catch (error) { throw releaseUnconfirmed(worker, fixture, `Worker IPC failed: ${error.message}`); }
        }
        let timer;
        const stopped = await Promise.race([workerClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        clearTimeout(timer);
        if (!stopped) {
          const ps = pid => spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
          const childGroup = ps(worker.pid), ownGroup = ps(process.pid);
          if (!(workerStartKey && getProcessSnapshot(worker.pid, { processLookupDeadline: performance.now() + 1000 })?.startKey === workerStartKey && childGroup.status === 0 && ownGroup.status === 0 &&
            childGroup.stdout.trim() === ownGroup.stdout.trim())) throw releaseUnconfirmed(worker, fixture, "Worker identity/group is unconfirmed");
          try {
            if (!worker.kill("SIGKILL")) throw new Error("signal was not delivered");
          } catch (error) { throw releaseUnconfirmed(worker, fixture, `Worker stop failed: ${error.message}`); }
          let deadline;
          const killed = await Promise.race([workerClosed.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), 5000); })]);
          clearTimeout(deadline);
          if (!killed) throw releaseUnconfirmed(worker, fixture, "Worker exit is unconfirmed");
        }
      });
      const starting = workerMessage(worker, fixture);
      worker.send({ job: { id: "fixture-job", workspaceRoot: cwd, jobClass: "task", sessionId: "owner", grokPromptState: "not-sent" } });
      const started = await starting;
      assert.equal(started.type, "started", JSON.stringify(started));
      const leased = listJobs(cwd).find(job => job.id === "fixture-job");
      assert.ok(leased?.workerLease && leased.epoch && leased.claimToken);
      workerStartKey = leased.processStartKey;
      const assertLiveLease = () => {
        assert.equal(worker.exitCode, null); assert.equal(worker.signalCode, null);
        assert.equal(getProcessSnapshot(worker.pid, { processLookupDeadline: performance.now() + 1000 })?.startKey, workerStartKey);
        const fd = fs.openSync(leased.workerLease.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const probe = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 2000 });
          assert.equal(probe.error, undefined, probe.error?.message); assert.equal(probe.signal, null); assert.equal(probe.status, 75);
        } finally { fs.closeSync(fd); }
      };
      if (entry.live) assertLiveLease();
      if (!entry.live) {
        const finished = workerMessage(worker, fixture); worker.send("finish");
        assert.equal((await finished).type, "completed");
        await workerClose(workerClosed, worker, fixture); assert.equal(worker.exitCode, 0);
      }
      const base = { ...leased, status: "cancelled", pid: null, terminationPending: true,
        workerStopConfirmed: false, workerStopProof: null, workerStopProcessStartKey: null,
        grokTransport: "broker", grokBrokerGeneration: generation };
      if (entry.fresh) Object.assign(base, { status: "running", pid: worker.pid, terminationPending: false });
      const record = fields => {
        const value = { ...base }; delete value.grokPromptState; delete value.grokSessionId;
        if (fields.length) Object.assign(value, { grokPromptState: fields[0], grokSessionId: fields[1] });
        return value;
      };
      updateState(cwd, (state, context) => {
        const index = state.jobs.findIndex(job => job.id === base.id);
        assert.notEqual(index, -1); state.jobs[index] = record(entry.index);
        if (entry.file) writeJobFile(cwd, base.id, record(entry.file), context);
      });
      const file = resolveJobFile(cwd, base.id);
      if (!entry.file) fs.unlinkSync(file);
      const originalIndex = listJobs(cwd).find(job => job.id === base.id);
      const originalDetail = entry.file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      const binding = base.workerLease.path.replace(/\.lease$/, ".binding");
      const evidence = [base.workerLease.path, binding].map(name => ({ name, stat: fs.lstatSync(name, { bigint: true }), bytes: fs.readFileSync(name) }));
      const assertLeaseEvidence = () => {
        for (const item of evidence) {
          const now = fs.lstatSync(item.name, { bigint: true });
          assert.equal(now.dev, item.stat.dev); assert.equal(now.ino, item.stat.ino);
          assert.deepEqual(fs.readFileSync(item.name), item.bytes);
        }
      };
      const assertReleasedProof = value => {
        assert.equal(value.workerStopConfirmed, true);
        assert.equal(value.workerStopProof, "darwin-lease-released");
        assert.equal(value.workerStopLeaseId, base.workerLease.id);
      };
      const invoke = () => mode === "cancel" ? run(companion, ["cancel", base.id, "--cwd", cwd, "--json"], env)
        : run(hook, ["SessionEnd"], env, JSON.stringify({ cwd, session_id: "owner" }));
      const result = await invoke();
      assert.equal(result.stdinError, undefined, result.stdinError?.message);
      assert.equal(result.signal, null);
      const index = listJobs(cwd).find(job => job.id === base.id);
      const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      if (entry.conflict) {
        assert.ok(index, `index removed: ${result.stderr}`);
        if (mode === "SessionEnd" || !entry.file) {
          assert.deepEqual(index, originalIndex);
          assert.deepEqual(stored, originalDetail);
        } else assert.equal(index.terminationPending, true, result.stderr);
        assert.equal(index.grokPromptState, entry.index[0]); assert.equal(index.grokSessionId, entry.index[1]);
        if (entry.file) {
          assert.ok(stored);
          if (mode === "cancel") assert.equal(stored.terminationPending, true);
          assert.equal(stored.grokPromptState, entry.file[0]); assert.equal(stored.grokSessionId, entry.file[1]);
        } else assert.equal(stored, null);
        assert.equal(seen.filter(row => row.method === "broker/cancelTurn").length, 0);
        assertLeaseEvidence();
        if (mode === "cancel") {
          assert.equal(result.code, 1, result.stderr);
          if (entry.file) {
            if (entry.live) {
              assert.match(result.stderr, /worker lease remains unconfirmed/i);
              assert.equal(index.workerStopConfirmed, false); assert.equal(stored.workerStopConfirmed, false);
            } else {
              assert.match(result.stderr, /turn stop is unconfirmed/i);
              assertReleasedProof(index); assertReleasedProof(stored);
            }
          } else assert.match(result.stderr, /no verified current worker lease/i);
          const again = await invoke(); assert.equal(again.stdinError, undefined, again.stdinError?.message); assert.equal(again.signal, null); assert.equal(again.code, 1);
          const retry = listJobs(cwd).find(job => job.id === base.id);
          assert.equal(retry.terminationPending, !entry.file ? originalIndex.terminationPending : true);
          assert.equal(retry.grokPromptState, entry.index[0]);
          assert.equal(retry.grokSessionId, entry.index[1]);
          assert.equal(fs.existsSync(file), Boolean(entry.file));
          if (entry.file) {
            const retryDetail = JSON.parse(fs.readFileSync(file, "utf8"));
            assert.equal(retryDetail.grokPromptState, entry.file[0]); assert.equal(retryDetail.grokSessionId, entry.file[1]);
            for (const key of ["id", "epoch", "claimToken", "createdAt", "processStartKey", "workerLease"]) {
              assert.deepEqual(retry[key], index[key]); assert.deepEqual(retryDetail[key], stored[key]);
            }
            if (entry.live) {
              assert.equal(retry.workerStopConfirmed, false); assert.equal(retryDetail.workerStopConfirmed, false);
            } else { assertReleasedProof(retry); assertReleasedProof(retryDetail); }
          } else assert.deepEqual(retry, originalIndex);
          assertLeaseEvidence();
          assert.equal(seen.filter(row => row.method === "broker/cancelTurn").length, 0);
        } else assert.equal(result.code, 0, result.stderr);
      } else if (entry.legacy) {
        assert.equal(result.code, mode === "cancel" ? 1 : 0, result.stderr);
        assert.ok(index && stored); assert.equal(index.terminationPending, true); assert.equal(stored.terminationPending, true);
        for (const key of ["grokPromptState", "grokSessionId"]) {
          assert.equal(index[key] ?? null, originalIndex[key] ?? null);
          assert.equal(stored[key] ?? null, originalDetail[key] ?? null);
        }
        assert.equal(seen.filter(row => row.method === "broker/cancelTurn").length, 0);
        if (mode === "cancel") {
          assert.match(result.stderr, /turn stop is unconfirmed/i);
          assertReleasedProof(index); assertReleasedProof(stored);
        } else {
          assert.ok(index.cancelRequestedAt); assert.equal(stored.cancelRequestedAt, index.cancelRequestedAt);
          assert.equal(index.errorMessage, "Cancelled when the session ended.");
          assert.equal(stored.errorMessage, index.errorMessage);
        }
      } else if (mode === "cancel") {
        assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).turnStopConfirmed, true);
        assert.equal(index.terminationPending, false);
        assert.equal(stored.terminationPending, false); assertReleasedProof(index); assertReleasedProof(stored);
        assert.equal(seen.filter(row => row.method === "broker/cancelTurn").length, entry.index[0] === "pending" ? 1 : 0);
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.ok(index && stored, "SessionEnd must retain both history records");
        assert.equal(index.status, "cancelled"); assert.equal(index.terminationPending, true);
        assert.equal(stored.status, "cancelled"); assert.equal(stored.terminationPending, true);
        assert.equal(seen.filter(row => row.method === "broker/cancelTurn").length, entry.index[0] === "pending" ? 1 : 0);
      }
      if (!entry.conflict && !entry.legacy && entry.index[0] === "pending") {
        const [request] = seen.filter(row => row.method === "broker/cancelTurn");
        assert.equal(request.params.sessionId, "s"); assert.equal(request.params.executionId, base.id);
        assert.equal(request.params.generation, generation);
      }
      if (entry.live) {
        assertLiveLease();
        const finished = workerMessage(worker, fixture); worker.send("finish");
        const completion = await finished;
        if (mode === "cancel") {
          assert.equal(completion.type, "rejected");
          assert.equal(completion.message, "Job fixture-job was cancelled or became terminal or termination pending before completion; its output was not committed.");
        } else assert.equal(completion.type, "completed", JSON.stringify(completion));
        await workerClose(workerClosed, worker, fixture); assert.equal(worker.exitCode, 0); assert.equal(worker.signalCode, null);
      }
    } finally {
      try {
        for (const socket of sockets) socket.destroy();
        let timeout;
        const closed = await Promise.race([new Promise(resolve => server.close(() => resolve(true))), new Promise(resolve => { timeout = setTimeout(() => resolve(false), 3000); })]);
        clearTimeout(timeout);
        assert.ok(closed, `broker fixture close is unconfirmed; retained ${fixture}`);
        assert.deepEqual(brokerErrors, [], `broker fixture failed; retained ${fixture}`);
      } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    }
  });
}
