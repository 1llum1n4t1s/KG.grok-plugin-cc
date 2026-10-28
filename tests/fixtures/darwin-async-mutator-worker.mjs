import fs from "node:fs";
import { once } from "node:events";
import { updateState } from "../../plugins/grok/scripts/lib/state.mjs";

const [{ workspace, marker, variant }] = await once(process, "message");
const mutate = variant === "async" ? async state => {
  fs.writeFileSync(marker, "async mutator ran");
  await Promise.resolve();
  state.config.stopReviewGate = true;
} : state => {
  state.config.stopReviewGate = true;
  return { then(resolve) { resolve(); } };
};
try {
  updateState(workspace, mutate);
  process.send({ type: "accepted", mutated: fs.existsSync(marker) }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message, mutated: fs.existsSync(marker) }, () => process.disconnect());
}
