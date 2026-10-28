import { once } from "node:events";
import fs from "node:fs";
import { DARWIN_LEASE_SLOT_COUNT } from "../../plugins/grok/scripts/lib/darwin-worker-lease.mjs";
import { sweepDarwinWorkerLeases } from "../../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";

const [{ workspace, iterations = DARWIN_LEASE_SLOT_COUNT * 2, timeoutMs = 5000 }] = await once(process, "message");
try {
  let uncertain = false;
  for (let i = 0; i < iterations; i += 1) {
    await sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs });
    if (process.env.GROK_SWEEP_TEST_READY && fs.existsSync(process.env.GROK_SWEEP_TEST_READY)) {
      uncertain = true;
      break;
    }
  }
  process.send({ type: uncertain ? "uncertain" : "completed" }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message }, () => process.disconnect());
}
