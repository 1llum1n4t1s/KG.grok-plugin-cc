import { once } from "node:events";
import { createJobLogFile, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

process.send({ type: "ready" });
const [message] = await once(process, "message");
const { job, owner } = message;
let stage = "log";
try {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, owner);
  stage = "claim";
  await runTrackedJob({ ...job, owner, logFile }, async () => {
    process.send({ type: "started", owner });
    const [command] = await once(process, "message");
    if (command !== "release") throw new Error("Unexpected worker command");
    return { exitStatus: "completed", rendered: `finished ${owner}` };
  }, { logFile, getProcessSnapshotImpl: () => ({ startKey: `start-${owner}` }) });
  process.send({ type: "completed", owner }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", owner, stage, code: error.code, message: error.message }, () => process.disconnect());
}
