import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { updateState } from "../../plugins/grok/scripts/lib/state.mjs";
import { withAvailableDarwinLease } from "../../plugins/grok/scripts/lib/darwin-worker-lease.mjs";

const [{ workspace, stateDir, lease, directoryIdentity, ready, release }] = await once(process, "message");
const originalRename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (to === path.join(stateDir, "state.json")) {
    fs.writeFileSync(ready, "waiting");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(release)) throw new Error("fixture gate timed out");
  }
  return originalRename.call(this, from, to);
};
try {
  updateState(workspace, state => { state.config.stopReviewGate = true; }, {
    aroundCommit(_state, context, commit) {
      const result = withAvailableDarwinLease(lease, { expectedDirectory: path.dirname(lease.path),
        expectedDirectoryIdentity: directoryIdentity, stateGeneration: context.stateGeneration }, () => commit());
      if (result.status !== "available") throw new Error("fixture lease unavailable");
      return result.value;
    }
  });
  process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message }, () => process.disconnect());
}
