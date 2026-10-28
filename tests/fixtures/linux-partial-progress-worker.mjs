import fs from "node:fs";
import { once } from "node:events";
import { resolveStateDir } from "../../plugins/grok/scripts/lib/state.mjs";
import { createJobLogFile, createJobProgressUpdater, createProgressReporter, runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";
import path from "node:path";

const [job] = await once(process, "message");
const logFile = createJobLogFile(job.workspaceRoot, job.id);
let token;
const report = createProgressReporter({ logFile, onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, () => token) });
try {
  await runTrackedJob(job, async owner => {
    token = owner;
    process.send({ type: "started", logFile });
    await once(process, "message");
    const stateFile = path.join(resolveStateDir(job.workspaceRoot), "state.json");
    const rename = fs.renameSync;
    let injected = false;
    fs.renameSync = function (from, to) {
      if (!injected && to === stateFile) {
        injected = true;
        throw Object.assign(new Error("injected index EIO"), { code: "EIO" });
      }
      return rename.call(this, from, to);
    };
    try { report({ message: "progress once", phase: "running" }); }
    catch (error) { process.send({ type: "first-failed", code: error.code }); }
    finally { fs.renameSync = rename; }
    await once(process, "message");
    report({ message: "progress retry", phase: "running" });
    process.send({ type: "retried" });
    await once(process, "message");
    throw new Error("fixture stopped");
  }, { logFile, getProcessSnapshotImpl: () => ({ startKey: "owner" }) });
} catch { /* Parent inspects the retained state before ending the fixture. */ }
process.disconnect();
