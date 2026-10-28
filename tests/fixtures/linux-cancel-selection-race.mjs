import fs from "node:fs";
import path from "node:path";

const stateFile = process.env.GROK_CANCEL_TEST_STATE;
const detailFile = process.env.GROK_CANCEL_TEST_DETAIL;
const marker = process.env.GROK_CANCEL_TEST_MARKER;
const testRoot = process.env.GROK_CANCEL_TEST_ROOT;
const replacementEpoch = process.env.GROK_CANCEL_TEST_EPOCH;
const variant = process.env.GROK_CANCEL_TEST_VARIANT;
if (!["linux", "darwin"].includes(process.platform) || !path.isAbsolute(testRoot) || fs.realpathSync(testRoot) !== testRoot ||
    ![stateFile, detailFile, marker].every(file => path.isAbsolute(file) && file.startsWith(`${testRoot}${path.sep}`))) {
  throw new Error("cancel race fixture refuses unverified paths");
}
const readFile = fs.readFileSync;
let injected = false;
fs.readFileSync = function (file, ...args) {
  const result = readFile.call(this, file, ...args);
  if (!injected && typeof file === "string" && file === stateFile) {
    injected = true;
    const state = JSON.parse(String(result));
    const old = state.jobs[0];
    const replacement = { ...old, ...(replacementEpoch ? { epoch: replacementEpoch } : {}), status: "running", pid: 2147483647,
      processStartKey: "00000000-0000-4000-8000-000000000000:1",
      createdAt: variant === "created" ? "2001-01-01T00:00:00.000Z" : old.createdAt };
    state.jobs[0] = replacement;
    fs.writeFileSync(detailFile, JSON.stringify(replacement));
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(marker, JSON.stringify(replacement));
  }
  return result;
};
