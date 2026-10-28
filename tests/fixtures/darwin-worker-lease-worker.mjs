import { once } from "node:events";
import { spawn } from "node:child_process";
import { runTrackedJob } from "../../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { getProcessSnapshot } from "../../plugins/grok/scripts/lib/process.mjs";
import { readJobFile, resolveJobFile } from "../../plugins/grok/scripts/lib/state.mjs";
import fs from "node:fs";

const [{ job, syntheticStartKey = false, childMarker = null, delayClaim = false, gateReady = null, gateRelease = null, keepOpenAfterCompletion = false }] = await once(process, "message");
try {
  await runTrackedJob(job, async () => {
    let descendantPid = null;
    if (childMarker) {
      const script = `const fs = require('node:fs'); const marker = process.argv[1];
        const timer = setInterval(() => { if (fs.existsSync(marker + '.release')) finish(); }, 20);
        const expiry = setTimeout(finish, 12000);
        function finish() { clearInterval(timer); clearTimeout(expiry); fs.writeFileSync(marker, 'exited'); }`;
      const child = spawn(process.execPath, ["-e", script, childMarker], { stdio: "ignore" });
      await once(child, "spawn");
      descendantPid = child.pid;
    }
    process.send({ type: "started", descendantPid });
    await once(process, "message");
    return { exitStatus: "completed", rendered: "done" };
  }, {
    ...((syntheticStartKey || delayClaim) ? { getProcessSnapshotImpl: () => {
      if (delayClaim) {
        fs.writeFileSync(gateReady, JSON.stringify(readJobFile(resolveJobFile(job.workspaceRoot, job.id)).workerLease));
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(gateRelease) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(gateRelease)) throw new Error("claim test gate timed out");
      }
      return syntheticStartKey ? { startKey: "darwin-lstart-utc-v1:Thu Jan  1 00:00:00 1970" } : getProcessSnapshot(process.pid);
    } } : {})
  });
  if (keepOpenAfterCompletion) {
    process.send({ type: "completed" });
    await once(process, "message");
    process.disconnect();
  } else process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message }, () => process.disconnect());
}
