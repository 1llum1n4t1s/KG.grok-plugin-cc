import fs from "node:fs";
import path from "node:path";
import { updateState, writeJobFile } from "../../plugins/grok/scripts/lib/state.mjs";

const stateFile = process.env.GROK_CANCEL_TEST_STATE;
const detailFile = process.env.GROK_CANCEL_TEST_DETAIL;
const marker = process.env.GROK_CANCEL_TEST_MARKER;
const testRoot = process.env.GROK_CANCEL_TEST_ROOT;
const workspace = process.env.GROK_CANCEL_TEST_WORKSPACE;
const jobId = process.env.GROK_CANCEL_TEST_JOB;
const replacementEpoch = process.env.GROK_CANCEL_TEST_EPOCH;
const variant = process.env.GROK_CANCEL_TEST_VARIANT;
if (!["linux", "darwin"].includes(process.platform) || !path.isAbsolute(testRoot) || fs.realpathSync(testRoot) !== testRoot ||
    !path.isAbsolute(workspace) || fs.realpathSync(workspace) !== workspace || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(jobId) ||
    ![stateFile, detailFile, marker].every(file => path.isAbsolute(file) && file.startsWith(`${testRoot}${path.sep}`))) {
  throw new Error("cancel race fixture refuses unverified paths");
}
const readFile = fs.readFileSync;
const close = fs.closeSync;
let selectedFd = null, injected = false;
fs.readFileSync = function (file, ...args) {
  const result = readFile.call(this, file, ...args);
  if (!injected && typeof file === "number") {
    const opened = fs.fstatSync(file, { bigint: true });
    const named = fs.statSync(stateFile, { bigint: true });
    if (opened.dev === named.dev && opened.ino === named.ino) selectedFd = file;
  }
  return result;
};
fs.closeSync = function (fd) {
  const result = close.call(this, fd);
  if (!injected && fd === selectedFd) {
    injected = true;
    updateState(workspace, (state, context) => {
      const index = state.jobs.findIndex(entry => entry.id === jobId);
      if (index < 0) throw new Error("cancel race fixture could not find the selected job");
      const old = state.jobs[index];
      const replacement = { ...old, ...(replacementEpoch ? { epoch: replacementEpoch } : {}),
        createdAt: variant === "created" ? "2001-01-01T00:00:00.000Z" : old.createdAt };
      writeJobFile(workspace, jobId, replacement, context);
      state.jobs[index] = replacement;
      fs.writeFileSync(marker, JSON.stringify(replacement));
    });
  }
  return result;
};
