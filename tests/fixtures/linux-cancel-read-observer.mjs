import fs from "node:fs";

const original = fs.readFileSync;
let observed = false;
fs.readFileSync = function (file, ...args) {
  const result = original.call(this, file, ...args);
  if (!observed && typeof file === "number" && new Error().stack?.includes("resolveCancelableJob")) {
    const actual = fs.fstatSync(file, { bigint: true });
    const expected = fs.statSync(process.env.GROK_TEST_STATE_FILE, { bigint: true });
    if (actual.dev === expected.dev && actual.ino === expected.ino) {
      const state = JSON.parse(result.toString());
      if (state.jobs.some(job => job.id === process.env.GROK_TEST_JOB_ID && job.status === "running")) {
        observed = true;
        fs.writeFileSync(process.env.GROK_TEST_CANCEL_SELECTED, process.env.GROK_TEST_JOB_ID);
      }
    }
  }
  return result;
};
