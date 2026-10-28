import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// empty reclaiming の rename 直後、directory fsync 前に実プロセスを終了する。
const rename = fs.renameSync;
fs.renameSync = function (from, to, ...args) {
  const result = rename.call(this, from, to, ...args);
  if (process.env.GROK_EMPTY_RECLAIM_CRASH === "1" && typeof from === "string" && from.endsWith("ledger.prepared")) {
    const ledger = JSON.parse(fs.readFileSync(to, "utf8"));
    if (ledger.slots.some(entry => entry.state === "reclaiming" && entry.reclaimKind === "empty")) process.exit(77);
  }
  return result;
};
syncBuiltinESMExports();
