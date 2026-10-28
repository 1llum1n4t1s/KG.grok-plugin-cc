import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { buildStatusSnapshot } from "../../plugins/grok/scripts/lib/job-control.mjs";

const [{ workspace, stateDir }] = await once(process, "message");
const original = fs.renameSync;
let injected = false;
fs.renameSync = function (from, to) {
  if (!injected && to === path.join(stateDir, "state.json")) {
    injected = true;
    throw Object.assign(new Error("injected status index EIO"), { code: "EIO" });
  }
  return original.call(this, from, to);
};
try {
  buildStatusSnapshot(workspace, { all: true, env: {} });
  process.send({ type: "accepted", injected }, () => process.disconnect());
} catch (error) {
  process.send({ type: "rejected", message: error.message, code: error.code, injected }, () => process.disconnect());
} finally { fs.renameSync = original; }
