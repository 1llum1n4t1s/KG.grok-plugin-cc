import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// 実 Linux の CLI で index 確定後の逆参照走査だけを遅延する。
// 電源断時の durability はこの注入では検証しない。
fs.writeFileSync(process.env.GROK_NATIVE_PRELOAD_READY, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
const rename = fs.renameSync;
const opendir = fs.opendirSync;
let indexPublished = false;
let injected = false;
fs.renameSync = function (from, to, ...options) {
  const result = rename.call(this, from, to, ...options);
  if (typeof to === "string" && /\/state\.json$/.test(to)) indexPublished = true;
  return result;
};
fs.opendirSync = function (target, ...options) {
  if (indexPublished && !injected && typeof target === "string" && /\/proc\/self\/fd\/\d+\/\.$/.test(target)) {
    injected = true;
    fs.writeFileSync(process.env.GROK_SWEEP_DELAY_MARKER, "deadline injected", { flag: "wx", mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500);
  }
  return opendir.call(this, target, ...options);
};
syncBuiltinESMExports();
