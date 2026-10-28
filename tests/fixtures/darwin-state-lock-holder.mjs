import fs from "node:fs";
import { once } from "node:events";
import { withStateSnapshot } from "../../plugins/grok/scripts/lib/state.mjs";

const [{ workspace, ready }] = await once(process, "message");
withStateSnapshot(workspace, () => {
  fs.writeFileSync(ready, "locked");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
});
process.disconnect();
