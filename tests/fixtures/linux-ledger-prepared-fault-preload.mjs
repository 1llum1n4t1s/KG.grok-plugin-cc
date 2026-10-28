import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// prepared file と directory の fsync 後、ledger rename 前で停止する。
const rename = fs.renameSync;
fs.renameSync = function (from, to, ...options) {
  if (typeof from === "string" && typeof to === "string" && from.endsWith("/ledger.prepared") && to.endsWith("/ledger.json")) {
    fs.writeFileSync(process.env.GROK_LEDGER_FAULT_MARKER, "before ledger rename", { flag: "wx", mode: 0o600 });
    process.exit(75);
  }
  return rename.call(this, from, to, ...options);
};
syncBuiltinESMExports();
