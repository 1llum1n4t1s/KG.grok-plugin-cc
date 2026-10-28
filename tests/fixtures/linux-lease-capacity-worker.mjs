import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  const result = spawn.call(this, command, args, options);
  if (command === "/usr/bin/flock" && result.status === 75) result.status = 1;
  return result;
};
syncBuiltinESMExports();
const { withStateSnapshot, updateState } = await import("../../plugins/grok/scripts/lib/state.mjs");
const { filterLinuxHistoryUnreferenced, reserveLinuxLeaseSlot } = await import("../../plugins/grok/scripts/lib/linux-lease-ledger.mjs");
const { releaseLinuxWorkerLease } = await import("../../plugins/grok/scripts/lib/linux-worker-lease.mjs");

const workspace = process.argv[2], action = process.argv[3];
const reserve = (context, jobId) => {
  const claimToken = randomUUID(), createdAt = new Date().toISOString();
  return reserveLinuxLeaseSlot({ context, jobId, claimToken, createdAt,
    queuedRecord: { id: jobId, claimToken, createdAt, epoch: context.epoch, status: "queued", phase: "queued", grokPromptState: "not-sent" } });
};
if (action === "crash-empty") {
  updateState(workspace, state => state);
  const open = fs.openSync;
  fs.openSync = function (target, ...args) {
    if (typeof target === "string" && /\/slot-\d{3}\.lease$/.test(target) && (args[0] & fs.constants.O_CREAT)) process.exit(76);
    return open.call(this, target, ...args);
  };
  withStateSnapshot(workspace, (_state, context) => reserve(context, "empty-crash"));
  throw new Error("fixture did not reach lease creation");
} else if (action === "hold") {
  // index が空である証拠も state mutex 内で耐久化する。
  updateState(workspace, state => state);
  const reservations = withStateSnapshot(workspace, (_state, context) =>
    Array.from({ length: 256 }, (_, i) => reserve(context, `capacity-${i}`)));
  process.send({ type: "held", leases: reservations.map(item => item.lease) });
  let [message] = await once(process, "message");
  if (message === "benchmark") {
    const claimToken = randomUUID(), workerStopLeaseId = randomUUID();
    const candidates = Array.from({ length: 2048 }, (_, i) => ({ jobId: `history-candidate-${i}`, claimToken, workerStopLeaseId }));
    const start = performance.now();
    const ids = withStateSnapshot(workspace, (_state, context) => filterLinuxHistoryUnreferenced({ context, candidates }), { timeoutMs: 10000 });
    process.send({ type: "benchmark", count: ids.size, elapsedMs: performance.now() - start });
    [message] = await once(process, "message");
  }
  if (message !== "release-one") throw new Error("fixture expected release-one");
  releaseLinuxWorkerLease(reservations[0].owner);
  process.send({ type: "released" });
  await once(process, "message");
  for (const item of reservations.slice(1)) releaseLinuxWorkerLease(item.owner);
  process.disconnect();
} else if (action === "reserve") {
  try {
    const result = withStateSnapshot(workspace, (_state, context) => reserve(context, `extra-${randomUUID()}`));
    releaseLinuxWorkerLease(result.owner);
    process.stdout.write(`${JSON.stringify({ ok: true, slot: result.lease.slot })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? null })}\n`);
  }
}
