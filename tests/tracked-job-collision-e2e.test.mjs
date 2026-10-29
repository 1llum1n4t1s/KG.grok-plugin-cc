import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  loadState, migrateStateLock, resolveStateDir, resolveJobFile, resolveJobLogFile, updateState, upsertJob, writeJobFile
} from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

const workerUrl = new URL("./fixtures/tracked-job-collision-worker.mjs", import.meta.url);

function startWorker(env) {
  const child = fork(workerUrl, [], { env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const messages = [];
  const waiters = [];
  let closed = false;
  let failure;
  const close = new Promise(resolve => child.once("close", (code, signal) => {
    closed = true;
    failure ??= new Error(`Worker closed before its next message (code=${code}, signal=${signal})`);
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
    resolve({ code, signal });
  }));
  child.on("error", error => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.on("message", message => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  return {
    child, close,
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      if (failure || closed) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for worker IPC"));
        }, 30000);
        waiter.resolve = message => { clearTimeout(timer); resolve(message); };
        waiter.reject = error => { clearTimeout(timer); reject(error); };
        waiters.push(waiter);
      });
    }
  };
}

test("simultaneous job IDs preserve the winning owner and existing files", { timeout: 120000 }, async t => {
  const temp = makeTempDir("grok-collision-e2e-");
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(name => [name, process.env[name]]);
  process.env.CLAUDE_PLUGIN_DATA = path.join(temp, "data");
  delete process.env.PLUGIN_DATA;
  const env = { ...process.env };
  const workers = [], states = [];
  let uncertainMigration = false;
  // 移行開始より先に登録し、所有 worker 全員の close 後に sentinel を停止する。
  t.after(async () => {
    try {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
      }
      let timer;
      const closed = await Promise.race([Promise.all(workers.map(worker => worker.close)).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
      clearTimeout(timer);
      assert.equal(closed, true, "worker exit was not confirmed");
      if (process.platform === "linux") {
        const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
        assert.equal(ps.status, 0, ps.stderr || ps.error?.message);
        const pids = new Set(workers.map(worker => worker.child.pid));
        assert.ok(!ps.stdout.split("\n").some(line => {
          const [pid, pgid, stat] = line.trim().split(/\s+/);
          return (pids.has(Number(pid)) || pids.has(Number(pgid))) && stat && !stat.startsWith("Z");
        }), "a fixture worker or its process group is still running");
        assert.equal(uncertainMigration, false, "migration outcome is unconfirmed");
        for (const { stateDir, epoch, dev, ino } of states) {
          const stat = fs.lstatSync(stateDir, { bigint: true });
          assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && String(stat.dev) === dev && String(stat.ino) === ino, "state directory identity changed");
          const marker = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
          assert.equal(marker.epoch, epoch, "sentinel epoch changed");
          const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
          assert.equal(stopped.stopped, true);
          assert.equal(stopped.epoch, epoch);
        }
      }
      removeTempFixture(temp, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Fixture retained because offline cleanup could not be confirmed: ${temp}; ${error.message}`, { cause: error });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  for (const kind of ["simultaneous", "log", "index", "detail"]) {
    const workspace = path.join(temp, kind);
    fs.mkdirSync(workspace);
    const stateDir = resolveStateDir(workspace);
    uncertainMigration = process.platform === "linux";
    migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    if (process.platform === "linux") {
      const { epoch } = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
      assert.equal(typeof epoch, "string");
      const stat = fs.lstatSync(stateDir, { bigint: true });
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(path.dirname(stateDir), path.join(temp, "data", "state"));
      states.push({ stateDir, epoch, dev: String(stat.dev), ino: String(stat.ino) });
      uncertainMigration = false;
    }
    const job = { id: `collision-${kind}`, workspaceRoot: workspace, status: "queued", jobClass: "review", title: "Review" };
    const detail = resolveJobFile(workspace, job.id);
    const log = resolveJobLogFile(workspace, job.id);
    if (kind === "log") fs.writeFileSync(log, "original log\n");
    if (kind === "index") upsertJob(workspace, { ...job, owner: "original" });
    if (kind === "detail") updateState(workspace, () => writeJobFile(workspace, job.id, { ...job, owner: "original" }));
    const snapshot = () => ({
      state: JSON.stringify(loadState(workspace)),
      detail: fs.existsSync(detail) ? fs.readFileSync(detail, "utf8") : null,
      log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : null
    });
    const before = snapshot();
    const group = [];
    for (let index = 0; index < 4; index++) {
      const worker = startWorker(env);
      workers.push(worker);
      group.push(worker);
    }
    const ready = await Promise.all(group.map(worker => worker.next()));
    assert.deepEqual(ready.map(message => message.type), group.map(() => "ready"));
    for (const [index, worker] of group.entries()) worker.child.send({ job, owner: `worker-${index}` });
    const results = await Promise.all(group.map(worker => worker.next()));

    if (kind !== "simultaneous") {
      for (const result of results) {
        assert.equal(result.type, "rejected", JSON.stringify(result));
        assert.equal(result.stage, "log");
        assert.ok(result.code === "EEXIST" || /already exists/i.test(result.message), JSON.stringify(result));
      }
      assert.deepEqual(snapshot(), before);
    } else {
      const started = results.filter(result => result.type === "started");
      assert.equal(started.length, 1, JSON.stringify(results));
      const winnerIndex = results.findIndex(result => result.type === "started");
      const winner = group[winnerIndex];
      const owner = started[0].owner;
      for (const result of results.filter(result => result.type !== "started")) {
        assert.equal(result.type, "rejected", JSON.stringify(result));
        assert.equal(result.stage, "log");
        assert.ok(result.code === "EEXIST" || /already exists/i.test(result.message), JSON.stringify(result));
      }
      const current = snapshot();
      const state = JSON.parse(current.state);
      const stored = JSON.parse(current.detail);
      assert.equal(state.jobs.length, 1);
      for (const record of [state.jobs[0], stored]) {
        assert.equal(record.id, job.id);
        assert.equal(record.owner, owner);
        assert.equal(record.pid, winner.child.pid);
        assert.equal(record.status, "running");
        assert.equal(record.processStartKey, `start-${owner}`);
        assert.equal(record.logFile, log);
      }
      assert.match(current.log, new RegExp(`^\\[[^\\n]+\\] Starting ${owner}\\.\\n$`));
      for (const result of results.filter(result => result.type === "rejected")) {
        assert.equal(current.log.includes(result.owner), false);
      }
      winner.child.send("release");
      assert.deepEqual(await winner.next(), { type: "completed", owner });
      const completed = snapshot();
      assert.equal(JSON.parse(completed.state).jobs[0].owner, owner);
      assert.equal(JSON.parse(completed.state).jobs[0].status, "completed");
      assert.equal(JSON.parse(completed.detail).owner, owner);
      assert.equal(JSON.parse(completed.detail).status, "completed");
      assert.ok(completed.log.includes(`finished ${owner}`));
    }
    for (const worker of group) assert.deepEqual(await worker.close, { code: 0, signal: null });
  }
});
