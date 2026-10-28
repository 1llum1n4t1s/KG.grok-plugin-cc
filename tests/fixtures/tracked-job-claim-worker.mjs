import { once } from "node:events";
import { runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

const [job] = await once(process, "message");
try {
  await runTrackedJob(job, async () => {
    process.send({ type: "started" });
    await once(process, "message");
    return { exitStatus: "completed", rendered: "done" };
  }, { getProcessSnapshotImpl: () => ({ startKey: "verified-start" }) });
  process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message }, () => process.disconnect());
}
