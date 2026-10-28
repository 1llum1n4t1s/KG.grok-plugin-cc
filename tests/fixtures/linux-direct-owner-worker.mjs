import { once } from "node:events";
import { registerDirectAgentOwner } from "../../plugins/grok/scripts/lib/direct-agent-control.mjs";
import { runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";

const [{ job, variant }] = await once(process, "message");
try {
  await runTrackedJob(job, async token => {
    process.send({ type: "started" });
    await once(process, "message");
    const altered = variant === "epoch" ? { ...token, epoch: "00000000-0000-4000-8000-000000000000" }
      : variant === "pid" ? { ...token, pid: token.pid + 1 }
      : variant === "start" ? { ...token, startKey: `${token.startKey}-replacement` } : token;
    try {
      const owner = registerDirectAgentOwner(job.workspaceRoot, job.id, { close: async () => "never-started" }, { ownerToken: altered });
      owner.dispose();
      process.send({ type: "registered" });
    } catch (error) {
      process.send({ type: "rejected", message: error.message });
    }
    await once(process, "message");
    throw new Error("fixture stopped");
  }, { getProcessSnapshotImpl: () => ({ startKey: "owner" }) });
} catch { /* The parent terminates the fixture after inspecting registration. */ }
process.disconnect();
