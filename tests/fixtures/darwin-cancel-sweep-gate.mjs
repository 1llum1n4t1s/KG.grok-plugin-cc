import fs from "node:fs";
import path from "node:path";

// 最終 state が保存され、native mutex の FD が閉じた直後だけ cancel を停止する。
const lockPath = path.join(process.env.GROK_TEST_STATE_DIR, "state.lock", "native.lock");
const statePath = path.join(process.env.GROK_TEST_STATE_DIR, "state.json");
const marker = process.env.GROK_TEST_SWEEP_GATE;
const id = process.env.GROK_TEST_SWEEP_JOB;
const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs), read = fs.readFileSync.bind(fs);
const lockFds = new Set();
let gated = false;
fs.openSync = (name, ...args) => {
  const fd = open(name, ...args);
  if (String(name) === lockPath) lockFds.add(fd);
  return fd;
};
fs.closeSync = fd => {
  const tracked = lockFds.delete(fd);
  const result = close(fd);
  if (tracked && !gated) {
    let job;
    try { job = JSON.parse(read(statePath, "utf8")).jobs.find(entry => entry.id === id); } catch { /* 初回 state 読込前。 */ }
    if (job?.status === "cancelled" && job.terminationPending === false && job.workerLease && job.workerStopConfirmed === true) {
      gated = true;
      fs.writeFileSync(marker, "ready");
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(`${marker}.release`) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      if (!fs.existsSync(`${marker}.release`)) throw new Error("cancel sweep gate timed out");
    }
  }
  return result;
};
