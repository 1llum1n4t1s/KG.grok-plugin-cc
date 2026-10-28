import { once } from "node:events";
import { createJobLogFile, createJobProgressUpdater, createProgressReporter, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

const [job] = await once(process, "message");
const logFile = createJobLogFile(job.workspaceRoot, job.id);
let token = null;
const report = createProgressReporter({ stderr: true, logFile, onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, () => token) });
try {
  await runTrackedJob(job, async owner => {
    token = owner;
    process.send({ type: "started", logFile });
    for (;;) {
      const [action] = await once(process, "message");
      if (action !== "progress") break;
      report({ message: "old worker progress", phase: "late-progress" });
      process.stderr.write("__progress_boundary__\n", () => process.send({ type: "progress-returned" }));
    }
    return { exitStatus: "completed", rendered: "old worker result" };
  }, { logFile, getProcessSnapshotImpl: () => ({ startKey: "old-owner" }) });
  process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message }, () => process.disconnect());
}
