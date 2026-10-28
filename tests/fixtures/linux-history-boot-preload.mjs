// 実際の reboot ではなく、この子プロセスの Linux boot ID 読取りのみを模擬する。
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const boot = process.env.GROK_HISTORY_SIM_BOOT;
if (boot !== undefined) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(boot)) throw new Error("Invalid simulated boot ID");
  const read = fs.readFileSync;
  fs.readFileSync = function (target, options) {
    if (target === "/proc/sys/kernel/random/boot_id") {
      const value = `${boot}\n`, encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? value : Buffer.from(value);
    }
    return read.call(this, target, options);
  };
  syncBuiltinESMExports();
}
