import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";

import {
  createJobRecord,
  createJobLogFile,
  resolveCurrentSessionId,
  reserveLinuxTrackedJob,
  runTrackedJob
} from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveJobLogFile, resolveStateDir, saveState, updateState, upsertJob, withStateSnapshot, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { LINUX_LEASE_SLOT_COUNT, releaseLinuxWorkerLease, withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";

function isolateStateData(t) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(name => [name, process.env[name]]);
  const data = makeTempDir("grok-tracked-state-data-");
  process.env.CLAUDE_PLUGIN_DATA = data;
  delete process.env.PLUGIN_DATA;
  let workspace, workspaceIdentity, stateDir, epoch, stateIdentity, complete = false;
  const children = [], reservations = [];
  const identity = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Fixture directory is not verified: ${file}`);
    return { dev: stat.dev, ino: stat.ino };
  };
  const dataIdentity = process.platform === "linux" ? identity(data) : null;
  t.after(async () => {
    try {
      if (process.platform !== "linux") {
        for (const child of children) {
          if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill();
          await child.closed;
        }
        return;
      }
      if (!complete || !workspace || !stateDir || !epoch || !stateIdentity) throw new Error("fixture migration was not confirmed");
      for (const child of children) {
        if (child.proc.exitCode === null && child.proc.signalCode === null && child.proc.connected) child.proc.send("release", () => {});
        let result;
        try {
          result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("fixture child close was not confirmed")), 15000);
            child.closed.then(value => { clearTimeout(timer); resolve(value); });
          });
        } catch (error) {
          if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGTERM");
          throw error;
        }
        if (result.signal) throw new Error("fixture child was signalled; descendant termination is unconfirmed");
      }
      assert.ok(reservations.every(record => record.released), "fixture owner release was not confirmed");
      assert.deepEqual(identity(data), dataIdentity);
      assert.deepEqual(identity(workspace), workspaceIdentity);
      assert.deepEqual(identity(stateDir), stateIdentity);
      withStateSnapshot(workspace, (_state, context) => {
        assert.equal(context.epoch, epoch);
        const leaseDir = path.join(stateDir, "worker-leases-v1", epoch);
        identity(path.dirname(leaseDir)); identity(leaseDir);
        assert.deepEqual(fs.readdirSync(path.dirname(leaseDir)), [epoch]);
        const ledgerFile = path.join(leaseDir, "ledger.json");
        const ledgerStat = fs.lstatSync(ledgerFile);
        assert.ok(ledgerStat.isFile() && !ledgerStat.isSymbolicLink() && ledgerStat.nlink === 1);
        const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
        assert.equal(ledger.epoch, epoch);
        assert.equal(ledger.slots.length, LINUX_LEASE_SLOT_COUNT);
        const expected = new Set(["ledger.json"]);
        for (const [index, slot] of ledger.slots.entries()) {
          assert.equal(slot.slot, index);
          if (slot.state === "free") continue;
          assert.ok(slot.lease, "unidentified lease must be retained");
          expected.add(`slot-${String(index).padStart(3, "0")}.lease`);
          expected.add(`slot-${String(index).padStart(3, "0")}.binding`);
          assert.equal(withAvailableLinuxLease(slot.lease, context, () => true).status, "available");
        }
        assert.deepEqual(new Set(fs.readdirSync(leaseDir)), expected);
        for (const name of ["broker.json", "broker.lock", "broker-v2", "direct-start-v1"]) assert.equal(fs.readdirSync(stateDir).includes(name), false);
        assert.equal(fs.readdirSync(stateDir).some(name => /^broker\.json\..*\.tmp$/.test(name)), false);
        for (const name of ["broker-v3", "direct-start-v2"]) {
          const dir = path.join(stateDir, name);
          identity(dir); identity(path.join(dir, epoch));
          assert.deepEqual(fs.readdirSync(dir), [epoch]);
          assert.deepEqual(fs.readdirSync(path.join(dir, epoch)), []);
        }
      });
      const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.stateDir, stateDir);
      assert.equal(stopped.epoch, epoch);
      assert.deepEqual(identity(data), dataIdentity);
      assert.deepEqual(identity(workspace), workspaceIdentity);
      removeTempFixture(data, { recursive: true, force: true });
      removeTempFixture(workspace, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Fixture cleanup or owned process termination not confirmed: ${data}; ${workspace ?? "workspace not recorded"}`, { cause: error });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  return {
    migrate(dir) {
      workspace = dir;
      if (process.platform !== "linux") return migrateStateLock(dir, { offlineConfirmed: true, localOnly: true });
      workspaceIdentity = identity(workspace);
      stateDir = resolveStateDir(dir);
      const marker = migrateStateLock(dir, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
      assert.equal(marker.stateDir, stateDir);
      epoch = marker.epoch;
      assert.ok(epoch);
      stateIdentity = identity(stateDir);
      complete = true;
      return marker;
    },
    async run(job, runner, options = {}) {
      if (process.platform !== "linux") return runTrackedJob(job, runner, options);
      const reservation = reserveLinuxTrackedJob(job, options);
      const record = { reservation, released: false };
      reservations.push(record);
      try { return await runTrackedJob(job, runner, { ...options, reservation }); }
      finally { record.released = releaseLinuxWorkerLease(reservation.owner); assert.equal(record.released, true); }
    },
    trackChild(proc) {
      const closed = new Promise(resolve => proc.once("close", (code, signal) => resolve({ code, signal })));
      children.push({ proc, closed });
    }
  };
}

function writeFixtureJob(workspace, job) {
  updateState(workspace, () => { writeJobFile(workspace, job.id, job); });
}

function baseJob(workspace, id) {
  return { id, workspaceRoot: workspace, status: "queued", jobClass: "review", title: "Review" };
}

test("BD-1b foreground rejects completion after cancellation or pending termination", async () => {
  const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url), "utf8");
  const boundedError = source.slice(source.indexOf("function boundedLinuxStateError("), source.indexOf("\n}", source.indexOf("function boundedLinuxStateError(")) + 2);
  const body = boundedError + "\n" + source.slice(source.indexOf("function commitNonTerminalTransition("))
    .replace("export async function runTrackedJob", "async function runTrackedJob");
  for (const terminal of [{ status: "cancelled" }, { status: "running", terminationPending: true }]) {
    const lease = { stateGeneration: "epoch", id: "lease" };
    const reservation = { claimToken: "claim", createdAt: "created", lease, owner: {} };
    let stored = { id: "job", workspaceRoot: "workspace", status: "queued", epoch: "epoch",
      createdAt: reservation.createdAt, claimToken: reservation.claimToken, workerLease: lease,
      pid: null, processStartKey: null };
    const state = { jobs: [{ ...stored }] };
    const runJob = vm.runInNewContext(`${body}; runTrackedJob`, {
      Buffer, TERMINAL_STATUSES: new Set(["completed", "failed", "cancelled"]),
      LINUX_WORKER_OWNERS: new Set(), sameLinuxLease: (a, b) => a === b,
      verifyPublishedLinuxLease: ({ context, indexed, stored: detail, owner, lease: published, claimToken }) => {
        assert.equal(context.epoch, "epoch");
        assert.equal(owner, reservation.owner);
        assert.equal(published, lease);
        assert.equal(claimToken, reservation.claimToken);
        for (const record of [indexed, detail]) {
          assert.equal(record.claimToken, claimToken);
          assert.equal(record.workerLease, lease);
        }
      },
      verifyLinuxTrackedOwner: (indexed, detail, id, owner, context) =>
        context.epoch === owner.epoch && [indexed, detail].every(record => record.id === id &&
          record.claimToken === owner.claimToken && record.workerLease === owner.workerLease),
      updateState: (_cwd, mutate) => mutate(state, { epoch: "epoch", check() {} }), readStoredJobOrNull: () => stored,
      pathHasEntry: () => false, resolveJobFile: () => "job",
      writeJobFile: (_cwd, _id, record) => { stored = record; }, nowIso: () => "now",
      process: { pid: 123, platform: "linux" }, createProcessLookupDiagnostics: () => ({}),
      getProcessSnapshot: () => ({ startKey: "synthetic" }), appendLogBlock() {}
    });
    await assert.rejects(runJob({ id: "job", workspaceRoot: "workspace", epoch: "epoch" }, async () => {
      stored = { ...stored, ...terminal };
      Object.assign(state.jobs[0], terminal);
      return { exitStatus: "completed", rendered: "done" };
    }, { reservation }), /cancel|termination|terminal/i);
    assert.equal(stored.status, terminal.status);
    assert.equal(stored.terminationPending, terminal.terminationPending);
  }
});

test("session identity prefers the shared id and falls back to the Codex thread id", () => {
  assert.equal(
    resolveCurrentSessionId({ GROK_COMPANION_SESSION_ID: "claude-session", CODEX_THREAD_ID: "codex-task" }),
    "claude-session"
  );
  assert.equal(resolveCurrentSessionId({ CODEX_THREAD_ID: "codex-task" }), "codex-task");
  assert.equal(resolveCurrentSessionId({ CODEX_THREAD_ID: "   " }), null);

  const record = createJobRecord(
    { id: "codex-job" },
    { env: { CODEX_THREAD_ID: "codex-task" } }
  );
  assert.equal(record.sessionId, "codex-task");
});

test("a transient process identity lookup failure does not prevent a task from starting", async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = baseJob(workspace, "transient-process-lookup");
  let lookups = 0;

  await fixture.run(job, async () => ({
    exitStatus: "completed",
    payload: { ok: true },
    rendered: "done",
    summary: "done"
  }), {
    getProcessSnapshotImpl() {
      lookups += 1;
      return lookups === 1 ? null : { startKey: "verified-start" };
    }
  });

  assert.equal(lookups, 2);
  const stored = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(stored.status, "completed");
  assert.equal(stored.processStartKey, "verified-start");
});

test("a task stays queued when process identity cannot be verified", async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = baseJob(workspace, "missing-process-identity");
  // POSIX reserves and writes its own queued record before process lookup.
  if (process.platform === "win32") {
    saveState(workspace, { version: 1, config: {}, jobs: [job] });
    writeFixtureJob(workspace, job);
  }
  let lookups = 0;
  let ran = false;

  await assert.rejects(
    fixture.run(job, async () => {
      ran = true;
    }, {
      getProcessSnapshotImpl() {
        lookups += 1;
        return null;
      }
    }),
    /Cannot verify the Grok job process identity/i
  );

  assert.equal(lookups, 3);
  assert.equal(ran, false);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "queued");
});

test("a worker never starts a queued job that was already cancelled", async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = baseJob(workspace, "cancel-before-start");
  const detail = resolveJobFile(workspace, job.id);
  let ran = false, lookups = 0, cancelledState, cancelledDetail;

  await assert.rejects(
    fixture.run(job, async () => {
      ran = true;
      return {};
    }, {
      getProcessSnapshotImpl() {
        lookups += 1;
        updateState(workspace, (state, context) => {
          const indexed = state.jobs.find(entry => entry.id === job.id);
          if (process.platform === "linux" || process.platform === "darwin") {
            assert.equal(indexed?.status, "queued");
            assert.equal(readJobFile(detail).status, "queued");
            assert.ok(indexed.workerLease && indexed.claimToken);
          } else {
            assert.equal(indexed, undefined);
          }
          const cancelled = { ...(indexed ?? job), status: "cancelled", phase: "cancelled" };
          writeJobFile(workspace, job.id, cancelled, context);
          if (indexed) Object.assign(indexed, cancelled);
          else state.jobs.push(cancelled);
        });
        cancelledState = JSON.stringify(loadState(workspace));
        cancelledDetail = fs.readFileSync(detail, "utf8");
        return { startKey: "verified-start" };
      }
    }),
    /already cancelled/i
  );
  assert.equal(lookups, 1);
  assert.equal(ran, false);
  assert.equal(JSON.stringify(loadState(workspace)), cancelledState);
  assert.equal(fs.readFileSync(detail, "utf8"), cancelledDetail);
  assert.equal(readJobFile(detail).status, "cancelled");
});

test("cancellation during execution remains terminal when the runner returns", async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = baseJob(workspace, "cancel-during-run");

  await assert.rejects(fixture.run(job, async () => {
    updateState(workspace, state => {
      const cancelled = { ...readJobFile(resolveJobFile(workspace, job.id)), status: "cancelled", phase: "cancelled" };
      writeJobFile(workspace, job.id, cancelled);
      Object.assign(state.jobs.find(entry => entry.id === job.id), { status: "cancelled", phase: "cancelled" });
    });
    return {
      exitStatus: "completed",
      payload: { ok: true },
      rendered: "done",
      summary: "done"
    };
  }), /cancelled|terminal|termination pending/i);

  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, "cancelled");
});

for (const kind of ["log", "index", "detail", "cancelled"]) test(`job log creation preserves ${kind} collision`, t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
    const job = { ...baseJob(workspace, `collision-${kind}`), status: kind === "cancelled" ? "cancelled" : "running" };
    const log = resolveJobLogFile(workspace, job.id);
    const detail = resolveJobFile(workspace, job.id);
    if (kind === "log" || kind === "cancelled") fs.writeFileSync(log, "original log\n");
    if (kind === "index" || kind === "cancelled") upsertJob(workspace, job);
    if (kind === "detail" || kind === "cancelled") writeFixtureJob(workspace, job);
    const previousState = JSON.stringify(loadState(workspace));
    const previousDetail = fs.existsSync(detail) ? fs.readFileSync(detail, "utf8") : null;

    assert.throws(() => createJobLogFile(workspace, job.id, "replacement"));
    assert.equal(JSON.stringify(loadState(workspace)), previousState);
    assert.equal(fs.existsSync(detail) ? fs.readFileSync(detail, "utf8") : null, previousDetail);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : null,
      kind === "log" || kind === "cancelled" ? "original log\n" : null);
});

for (const kind of ["index", "detail", "cancelled"]) test(`claim preserves ${kind} collision`, async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = { ...baseJob(workspace, `claim-${kind}`), status: kind === "cancelled" ? "cancelled" : "queued" };
  const detail = resolveJobFile(workspace, job.id);
  if (kind === "index" || kind === "cancelled") upsertJob(workspace, job);
  if (kind === "detail" || kind === "cancelled") writeFixtureJob(workspace, job);
  const previousState = JSON.stringify(loadState(workspace));
  const previousDetail = fs.existsSync(detail) ? fs.readFileSync(detail, "utf8") : null;
  let ran = false;
  await assert.rejects(runTrackedJob(job, async () => { ran = true; }, {
    getProcessSnapshotImpl: () => ({ startKey: "verified-start" })
  }), /already/i);
  assert.equal(ran, false);
  assert.equal(JSON.stringify(loadState(workspace)), previousState);
  assert.equal(fs.existsSync(detail) ? fs.readFileSync(detail, "utf8") : null, previousDetail);
});

for (const kind of ["invalid JSON", "directory"]) test(`job record read failure preserves ${kind}`, async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = baseJob(workspace, "corrupt-record");
  const detail = resolveJobFile(workspace, job.id);
  if (kind === "directory") fs.mkdirSync(detail);
  else fs.writeFileSync(detail, "not JSON\n");
  let ran = false;
  await assert.rejects(runTrackedJob(job, async () => { ran = true; }, {
    getProcessSnapshotImpl: () => ({ startKey: "verified-start" })
  }), /corrupt/i);
  assert.equal(ran, false);
  if (kind === "directory") assert.equal(fs.statSync(detail).isDirectory(), true);
  else assert.equal(fs.readFileSync(detail, "utf8"), "not JSON\n");
  assert.equal(loadState(workspace).jobs.some(entry => entry.id === job.id), false);
});

test("a second process cannot claim a running job with the same ID", async t => {
  const fixture = isolateStateData(t);
  const workspace = makeTempDir();
  fixture.migrate(workspace);
  const job = baseJob(workspace, "parallel-claim");
  const workerUrl = new URL("./fixtures/tracked-job-claim-worker.mjs", import.meta.url);
  const start = () => {
    const child = fork(workerUrl, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    fixture.trackChild(child);
    return child;
  };
  const first = start();
  first.send(job);
  const [firstMessage] = await once(first, "message");
  assert.equal(firstMessage.type, "started");
  const detail = resolveJobFile(workspace, job.id);
  const beforeDetail = fs.readFileSync(detail, "utf8");
  const beforeState = JSON.stringify(loadState(workspace));
  const second = start();
  second.send(job);
  const [secondMessage] = await once(second, "message");
  assert.equal(secondMessage.type, "rejected", JSON.stringify(secondMessage));
  assert.equal(fs.readFileSync(detail, "utf8"), beforeDetail);
  assert.equal(JSON.stringify(loadState(workspace)), beforeState);
  first.send("release");
  const [completion] = await once(first, "message");
  assert.equal(completion.type, "completed", JSON.stringify(completion));
  assert.equal(readJobFile(detail).status, "completed");
});
