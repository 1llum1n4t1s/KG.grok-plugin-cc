import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// 参照除去後の unlink 直後、directory fsync の直前に実プロセスを終了する。
const unlink = fs.unlinkSync;
fs.unlinkSync = function (target, ...args) {
  const result = unlink.call(this, target, ...args);
  if (process.env.GROK_SWEEP_CRASH_AFTER_LEASE_UNLINK === "1" && typeof target === "string"
      && /\/slot-\d{3}\.lease$/.test(target)) process.exit(73);
  return result;
};
syncBuiltinESMExports();
