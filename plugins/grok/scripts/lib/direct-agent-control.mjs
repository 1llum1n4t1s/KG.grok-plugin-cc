import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createStateJobReader, resolveStateDir, updateState, withStateSnapshot, writeJobFile } from "./state.mjs";
import { readStoredJob } from "./job-control.mjs";
import { sameLinuxLease, verifyDarwinTrackedOwner, verifyLinuxTrackedOwner } from "./tracked-jobs.mjs";
import { verifyPublishedLinuxLeaseRecords } from "./linux-lease-ledger.mjs";

function dependencies(overrides) {
  return { pid: process.pid, randomUUID, createStateJobReader, resolveStateDir, updateState, withStateSnapshot,
    writeJobFile, readStoredJob, verifyDarwinTrackedOwner, verifyLinuxTrackedOwner, verifyPublishedLinuxLeaseRecords, watch: fs.watch, setInterval, clearInterval, ...overrides };
}

function candidateReader(root, id, api, overrides) {
  if (overrides.readCandidate) return { stateDir: api.resolveStateDir(root), read: () => overrides.readCandidate(root, id) };
  return api.createStateJobReader(root, id);
}

function tokenFor(job) {
  return { generation: job.grokDirectGeneration, pid: job.grokDirectOwnerPid, startKey: job.grokDirectOwnerStartKey, epoch: job.epoch,
    claimToken: job.claimToken, workerLease: job.workerLease ? { ...job.workerLease } : null };
}

function matches(job, jobId, token) {
  return Boolean(job && job.id === jobId && token.generation && token.startKey &&
    (process.platform !== "linux" || (token.epoch && job.epoch === token.epoch && token.claimToken &&
      job.claimToken === token.claimToken && sameLinuxLease(job.workerLease, token.workerLease))) &&
    (process.platform !== "darwin" || (token.epoch && job.epoch === token.epoch && token.claimToken && job.claimToken === token.claimToken &&
      token.workerLease && job.workerLease && ["id", "path", "dev", "ino", "stateGeneration", "directoryDev", "directoryIno"].every(key => job.workerLease[key] === token.workerLease[key]))) &&
    job.grokDirectGeneration === token.generation && job.grokDirectOwnerPid === token.pid &&
    job.grokDirectOwnerStartKey === token.startKey && job.processStartKey === token.startKey);
}

/** PID不在から推論せず、同世代・同workerの両保存先に確定済みの証拠だけを読む。 */
export function readDirectAgentStop(workspaceRoot, jobId, expected, overrides = {}) {
  const api = dependencies(overrides);
  const token = tokenFor(expected);
  return api.withStateSnapshot(workspaceRoot, (state, context) => {
    if ((process.platform === "linux" || process.platform === "darwin") && (!context?.epoch || token.epoch !== context.epoch)) return false;
    const indexed = state.jobs.find(job => job.id === jobId);
    const stored = api.readStoredJob(workspaceRoot, jobId);
    if (process.platform === "linux") api.verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: token.workerLease });
    return [indexed, stored].every(job => matches(job, jobId, token) &&
      job.grokDirectStopGeneration === token.generation && ["job-empty", "posix-group-empty", "never-started"].includes(job.grokDirectStopKind));
  }, overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs });
}

export async function waitForDirectAgentStop(workspaceRoot, jobId, expected, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const api = dependencies(options);
  const reader = candidateReader(workspaceRoot, jobId, api, options);
  const token = tokenFor(expected);
  do {
    // atomic rename済みの候補を非lockで読む。worker停止/最終確定は呼出側でlock内CASする。
    const { indexed, stored } = reader.read();
    if ([indexed, stored].every(job => matches(job, jobId, token) && job.grokDirectStopGeneration === token.generation &&
        ["job-empty", "posix-group-empty", "never-started"].includes(job.grokDirectStopKind))) {
      const remaining = deadline - Date.now();
      if (remaining < 0) return false;
      return readDirectAgentStop(workspaceRoot, jobId, expected, { ...options, timeoutMs: remaining });
    }
    if (Date.now() >= deadline) return false;
    // state lockを保持したままtimerやworkerのcloseを待たない。
    await new Promise(resolve => setTimeout(resolve, Math.min(options.pollMs ?? 100, Math.max(1, deadline - Date.now()))));
  } while (true);
}

/** direct起動直前に世代を登録し、実所有者だけが終了証拠を書けるようにする。 */
export function registerDirectAgentOwner(workspaceRoot, jobId, control, overrides = {}) {
  const api = dependencies(overrides);
  const reader = candidateReader(workspaceRoot, jobId, api, overrides);
  const generation = api.randomUUID();
  let token;
  api.updateState(workspaceRoot, (state, context) => {
    const indexed = state.jobs.find(job => job.id === jobId);
    const stored = api.readStoredJob(workspaceRoot, jobId);
    const owner = overrides.ownerToken;
    if (process.platform === "darwin" && !api.verifyDarwinTrackedOwner(indexed, stored, jobId, owner, context)) {
      throw new Error(`Job ${jobId} worker lease is unavailable; direct agent was not started.`);
    }
    if (process.platform === "linux" && !api.verifyLinuxTrackedOwner(indexed, stored, jobId, owner, context)) {
      throw new Error(`Job ${jobId} worker ownership could not be verified.`);
    }
    if (![indexed, stored].every(job => job && job.id === jobId &&
        (process.platform !== "linux" || (owner?.epoch && owner?.startKey && Number.isInteger(owner?.pid) && owner.pid > 0 &&
          context?.epoch === owner.epoch && job.epoch === owner.epoch && job.pid === owner.pid && job.processStartKey === owner.startKey)) &&
        job.status === "running" && !job.terminationPending &&
        job.pid === api.pid && typeof job.processStartKey === "string" && job.processStartKey)) {
      throw new Error(`Job ${jobId} was cancelled or its running worker identity is unavailable; direct agent was not started.`);
    }
    if (indexed.processStartKey !== stored.processStartKey) throw new Error("Direct worker identity differs between state records.");
    const retainedFields = ["grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
    if (indexed.grokDirectGeneration == null && stored.grokDirectGeneration == null &&
        [indexed, stored].some(job => retainedFields.some(key => job[key] != null))) {
      throw Object.assign(new Error(`Job ${jobId} has incomplete direct agent generation evidence.`), { turnStopUnconfirmed: true });
    }
    if (indexed.grokDirectGeneration != null || stored.grokDirectGeneration != null) {
      const previous = indexed.grokDirectGeneration;
      const confirmed = typeof previous === "string" && Boolean(previous) && stored.grokDirectGeneration === previous &&
        [indexed, stored].every(job => job.grokDirectStopGeneration === previous &&
          ["job-empty", "posix-group-empty", "never-started"].includes(job.grokDirectStopKind)) &&
        indexed.grokDirectStopKind === stored.grokDirectStopKind &&
        Number.isInteger(indexed.grokDirectOwnerPid) && indexed.grokDirectOwnerPid === api.pid &&
        indexed.grokDirectOwnerPid === stored.grokDirectOwnerPid &&
        typeof indexed.grokDirectOwnerStartKey === "string" && Boolean(indexed.grokDirectOwnerStartKey) &&
        indexed.grokDirectOwnerStartKey === indexed.processStartKey && indexed.grokDirectOwnerStartKey === stored.grokDirectOwnerStartKey &&
        typeof indexed.grokDirectStopConfirmedAt === "string" && Boolean(indexed.grokDirectStopConfirmedAt) &&
        indexed.grokDirectStopConfirmedAt === stored.grokDirectStopConfirmedAt;
      if (!confirmed) {
        throw Object.assign(new Error(`Job ${jobId} already has an unconfirmed direct agent generation.`), { turnStopUnconfirmed: true });
      }
    }
    const patch = { grokDirectGeneration: generation, grokDirectOwnerPid: api.pid,
      grokDirectOwnerStartKey: indexed.processStartKey, grokDirectStopGeneration: null,
      grokDirectStopKind: null, grokDirectStopConfirmedAt: null,
      grokTransport: "direct", grokPromptState: "starting", grokSessionId: null, grokBrokerGeneration: null };
    api.writeJobFile(workspaceRoot, jobId, { ...indexed, ...stored, ...patch });
    Object.assign(indexed, patch);
    token = tokenFor(indexed);
  });

  let watcher;
  let timer;
  let disposed = false;
  let closing = false;
  let finishPromise;
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    watcher?.close();
    if (timer) api.clearInterval(timer);
  };
  const finish = (proof) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      try {
        if (!["job-empty", "posix-group-empty", "never-started"].includes(proof)) return false;
        let accepted = false;
        api.updateState(workspaceRoot, (state, context) => {
          const indexed = state.jobs.find(job => job.id === jobId);
          const stored = api.readStoredJob(workspaceRoot, jobId);
          if (((process.platform === "linux" || process.platform === "darwin") && (!context?.epoch || token.epoch !== context.epoch)) ||
              ![indexed, stored].every(job => matches(job, jobId, token))) return;
          if (process.platform === "linux" && !api.verifyLinuxTrackedOwner(indexed, stored, jobId, overrides.ownerToken, context)) return;
          const patch = { grokDirectStopGeneration: generation, grokDirectStopKind: proof,
            grokDirectStopConfirmedAt: new Date().toISOString() };
          // cancelledでも専用CASで書く。index保存失敗時は片側ACKを確定扱いしない。
          api.writeJobFile(workspaceRoot, jobId, { ...indexed, ...stored, ...patch });
          Object.assign(indexed, patch);
          accepted = true;
        });
        return accepted;
      } finally { dispose(); }
    })();
    finishPromise.then(resolveClosed, rejectClosed);
    return finishPromise;
  };
  const check = () => {
    if (disposed || closing) return;
    let requested;
    try {
      {
        const { indexed, stored } = reader.read();
        // 世代が置換されても旧controller自身は閉じるが、新世代へACKは書かない。
        requested = ![indexed, stored].every(job => matches(job, jobId, token)) ||
          [indexed, stored].some(job => job?.status === "cancelled" || job?.terminationPending);
      }
    } catch {
      // 通知欠落・一時的lock競合は有界intervalで再確認する。証拠は推測しない。
      return;
    }
    if (!requested) return;
    closing = true;
    try {
      // await/microtaskより先にclientのclosed gateを立て、戻り直後のspawnを防ぐ。
      const operation = control.close();
      void Promise.resolve(operation).then(finish).catch(error => { dispose(); rejectClosed(error); });
    } catch (error) { dispose(); rejectClosed(error); }
  };
  try {
    watcher = api.watch(reader.stateDir, (_event, filename) => {
      // lockのcreate/removeやchmodを自己通知として再読込しない。名前不明はpollに任せる。
      if (filename != null && String(filename) === "state.json") check();
    });
    watcher.on?.("error", () => {});
  } catch { /* pollを残す */ }
  timer = api.setInterval(check, 100);
  // 実所有者がACK保存を終えるまでworkerを生かす。通常closeのfinishで解放する。
  check();
  return { generation, closed, finish, dispose, check };
}
