import fs from "node:fs";
import { once } from "node:events";
import { migrateStateLock } from "../../plugins/grok/scripts/lib/state.mjs";

const [{ workspace, stateDir, ready, step }] = await once(process, "message");
try {
  migrateStateLock(workspace, {
    offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir,
    onDarwinMigrationStep(current) {
      if (current !== step) return;
      fs.writeFileSync(ready, current);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    }
  });
  process.send({ type: "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "failed", message: error.message }, () => process.disconnect());
}
