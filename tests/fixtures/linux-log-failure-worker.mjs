import fs from "node:fs";
import { once } from "node:events";
import { createJobLogFile, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

const [{ job, outcome, failAppend }] = await once(process, "message");
const logFile = createJobLogFile(job.workspaceRoot, job.id);
const injectedAppends = [];
try {
  await runTrackedJob(job, async () => {
    process.send({ type: "started", logFile });
    await once(process, "message");
    if (failAppend) {
      const append = fs.appendFileSync;
      fs.appendFileSync = function (file, data, ...args) {
        if (file === logFile) {
          injectedAppends.push(String(data));
          const error = new Error("Injected EIO while appending the job log");
          error.code = "EIO";
          throw error;
        }
        return append.call(this, file, data, ...args);
      };
    }
    if (outcome === "failure") throw new Error("runner exploded");
    return { exitStatus: "completed", rendered: "result" };
  }, { logFile, getProcessSnapshotImpl: () => ({ startKey: "owner" }) });
  process.send({ type: "completed", injectedAppends }, () => process.disconnect());
} catch (error) {
  const describe = value => value && typeof value === "object"
    ? [value.message, value.code, ...Array.from(value.errors ?? [], describe), describe(value.cause)].filter(Boolean).join(" ")
    : String(value ?? "");
  process.send({ type: "rejected", diagnostic: describe(error), injectedAppends }, () => process.disconnect());
}
