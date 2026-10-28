import fs from "node:fs";

const original = fs.readFileSync;
let observed = false;
fs.readFileSync = function (file, ...args) {
  const result = original.call(this, file, ...args);
  if (!observed && typeof file === "string" && file === process.env.GROK_TEST_STATE_FILE) {
    observed = true;
    fs.writeFileSync(process.env.GROK_TEST_CANCEL_SELECTED, "selected");
  }
  return result;
};
