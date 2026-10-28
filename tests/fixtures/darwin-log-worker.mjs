import { once } from "node:events";
import { createJobProgressUpdater, createProgressReporter, createReservedDarwinJobLog,
  reserveDarwinTrackedJob, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { resolveJobLogFile } from "../../plugins/grok/scripts/lib/state.mjs";

const [{ job }] = await once(process, "message");
try {
  const logFile = resolveJobLogFile(job.workspaceRoot, job.id);
  const reservation = reserveDarwinTrackedJob(job, { logFile });
  createReservedDarwinJobLog(job, logFile, reservation);
  let owner;
  const progress = createProgressReporter({ logFile, onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, () => owner, logFile) });
  await runTrackedJob(job, async token => {
    owner = token;
    progress("initial progress");
    process.send({ type: "ready", logFile });
    const [request] = await once(process, "message");
    if (request === "progress") progress("later progress");
    return { exitStatus: "completed", rendered: "final result" };
  }, { logFile, reservation });
  process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message, stateCommitted: error.stateCommitted === true,
    causeCode: error.cause?.code ?? null }, () => process.disconnect());
}
