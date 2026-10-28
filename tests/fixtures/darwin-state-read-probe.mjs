import fs from "node:fs";
import { once } from "node:events";

const [{ workspace, probePath, mode }] = await once(process, "message");
const originalRead = fs.readFileSync;
const probe = fs.lstatSync(probePath, { bigint: true });
let unsafeRead = false;
fs.readFileSync = function (target, ...args) {
  const opened = typeof target === "number" ? fs.fstatSync(target, { bigint: true }) : null;
  if (target === probePath || (opened && (opened.size > 64n * 1024n * 1024n ||
      (probe.isFile() && opened.dev === probe.dev && opened.ino === probe.ino)))) {
    unsafeRead = true;
    throw new Error("Test detected an unsafe record read");
  }
  return originalRead.call(this, target, ...args);
};
try {
  const { updateState, withStateSnapshot } = await import("../../plugins/grok/scripts/lib/state.mjs");
  if (mode === "state") withStateSnapshot(workspace, () => {});
  else updateState(workspace, state => { state.config.probe = true; });
  process.send({ type: "done", unsafeRead }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", unsafeRead, message: error.message }, () => process.disconnect());
}
