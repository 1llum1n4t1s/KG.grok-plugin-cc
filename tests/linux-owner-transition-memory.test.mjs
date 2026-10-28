import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

// Failure conditions: after the original claim, a same-ID replacement in the
// same or a new epoch receives the old worker's progress, success, failure,
// or diagnostic log. These callbacks simulate state locking; they do not
// exercise the real Linux sentinel, ACP, or the filesystem.
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url), "utf8");
const commitStart = source.indexOf("function commitNonTerminalTransition(");
const progressStart = source.indexOf("export function createJobProgressUpdater(");
const progressEnd = source.indexOf("export function createProgressReporter(", progressStart);
const ownerStart = source.indexOf("export function sameLinuxLease(");
const ownerEnd = source.indexOf("export function verifyDarwinTrackedOwner(", ownerStart);
assert.ok(commitStart >= 0 && progressStart >= 0 && progressEnd > progressStart && ownerStart >= 0 && ownerEnd > ownerStart);
const extracted = source.slice(progressStart, progressEnd).replace(/^export /, "") + "\n" +
  source.slice(ownerStart, ownerEnd).replaceAll("export function ", "function ") + "\n" +
  source.slice(commitStart).replace("export async function runTrackedJob", "async function runTrackedJob");

function scenario(replacement) {
  const lease = { id: "lease", slot: 0, path: "slot", dev: "dev", ino: "ino", stateGeneration: "epoch-a" };
  const reservation = { claimToken: "claim", lease, owner: {}, createdAt: "created" };
  const queued = { id: "job", epoch: "epoch-a", status: "queued", pid: null, processStartKey: null,
    createdAt: reservation.createdAt, claimToken: reservation.claimToken, workerLease: lease };
  const state = { jobs: [{ ...queued }] };
  let stored = { ...queued }, currentEpoch = "epoch-a", logWrites = 0;
  const context = vm.createContext({
    process: { platform: "linux", pid: 41 }, TERMINAL_STATUSES: new Set(["completed", "failed", "cancelled"]),
    LINUX_WORKER_OWNERS: new Set(),
    verifyPublishedLinuxLease: ({ owner, lease: actualLease, claimToken }) => {
      assert.equal(owner, reservation.owner); assert.equal(actualLease, lease); assert.equal(claimToken, reservation.claimToken);
    },
    nowIso: () => "now", createProcessLookupDiagnostics: () => ({}), getProcessSnapshot: () => ({ startKey: "owner-a" }),
    readStoredJobOrNull: () => stored, pathHasEntry: () => stored !== null, resolveJobFile: () => "detail",
    updateState: (_workspace, callback, options) => {
      const context = { epoch: currentEpoch, check() {} };
      callback(state, context);
      options?.afterSave?.(state, context);
    },
    writeJobFile: (_workspace, _id, record) => { stored = { ...record }; },
    appendLogBlock: () => { logWrites++; },
    normalizeProgressEvent: event => ({ message: "", phase: event.phase, grokSessionId: null })
  });
  vm.runInContext(extracted, context);
  const replace = () => {
    currentEpoch = replacement.epoch;
    const next = { ...state.jobs[0], ...replacement, id: "job", status: "running", logFile: "new-owner.log" };
    state.jobs[0] = next;
    stored = { ...next };
  };
  return { context, state, reservation, readStored: () => stored, logs: () => logWrites, replace };
}

for (const [name, replacement] of [
  ["new epoch", { epoch: "epoch-b", pid: 42, processStartKey: "owner-b" }],
  ["new PID", { epoch: "epoch-a", pid: 42, processStartKey: "owner-a" }],
  ["new start key", { epoch: "epoch-a", pid: 41, processStartKey: "owner-b" }]
]) {
  for (const outcome of ["success", "failure"]) test(`Linux old worker cannot commit ${outcome} to ${name}`, async () => {
    const run = scenario(replacement);
    let before;
    await assert.rejects(run.context.runTrackedJob({ id: "job", workspaceRoot: "workspace", logFile: "old-owner.log" }, async () => {
      run.replace();
      before = JSON.stringify([run.state, run.readStored()]);
      if (outcome === "failure") throw new Error("runner failed");
      return { exitStatus: "completed", rendered: "result" };
    }, { reservation: run.reservation }));
    assert.notEqual(before, undefined, "the runner must reach the replacement");
    assert.equal(JSON.stringify([run.state, run.readStored()]), before);
    assert.equal(run.logs(), 0);
  });

  test(`Linux old worker cannot update progress for ${name}`, async () => {
    const run = scenario(replacement);
    await assert.rejects(run.context.runTrackedJob({ id: "job", workspaceRoot: "workspace" }, async ownerToken => {
      const update = run.context.createJobProgressUpdater("workspace", "job", ownerToken);
      run.replace();
      const before = JSON.stringify([run.state, run.readStored()]);
      update({ phase: "late-progress" });
      assert.equal(JSON.stringify([run.state, run.readStored()]), before);
      throw new Error("stop fixture");
    }, { reservation: run.reservation }));
    assert.equal(run.state.jobs[0].phase, "starting");
  });
}
