import { once } from "node:events";
import { withStateSnapshot } from "../../plugins/grok/scripts/lib/state.mjs";

const [workspace] = await once(process, "message");
try {
  withStateSnapshot(workspace, () => {}, { timeoutMs: 0 });
  process.send({ acquired: true }, () => process.disconnect());
} catch (error) {
  process.send({ acquired: false, message: error.message }, () => process.disconnect());
}
