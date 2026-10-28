import { once } from "node:events";
import { createJobLogFile, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

const [{ job, outcome }] = await once(process, "message");
const logFile = createJobLogFile(job.workspaceRoot, job.id);
try {
  await runTrackedJob(job, async () => {
    process.send({ type: "started", logFile });
    await once(process, "message");
    if (outcome === "failure") throw new Error("runner exploded");
    return { exitStatus: "completed", rendered: "result" };
  }, { logFile, getProcessSnapshotImpl: () => ({ startKey: "owner" }) });
  process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  const describe = value => value && typeof value === "object"
    ? [value.message, value.code, ...Array.from(value.errors ?? [], describe), describe(value.cause)].filter(Boolean).join(" ")
    : String(value ?? "");
  process.send({ type: "rejected", diagnostic: describe(error) }, () => process.disconnect());
}
