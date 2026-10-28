import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// detail の rename 後、index の容量 inventory 開始までを通してから故障させる。
// Mac 上の模擬であり、Linux kernel や電源断の検証ではない。
const rename = fs.renameSync;
const opendir = fs.opendirSync;
const jobId = process.env.GROK_RECLAIM_FAULT_JOB;
let detailPublished = false;
let injected = false;
fs.renameSync = function (from, to, ...options) {
  const result = rename.call(this, from, to, ...options);
  if (typeof to === "string" && to.endsWith(`/${jobId}.json`)) detailPublished = true;
  return result;
};
fs.opendirSync = function (target, ...options) {
  if (detailPublished && !injected && new Error().stack?.includes("linuxBudgetInventory")) {
    injected = true;
    fs.writeFileSync(process.env.GROK_RECLAIM_FAULT_MARKER, "index inventory", { flag: "wx", mode: 0o600 });
    if (process.env.GROK_RECLAIM_FAULT_MODE === "crash") process.exit(74);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500);
  }
  return opendir.call(this, target, ...options);
};
syncBuiltinESMExports();
