// Mac 上の別 Node プロセスで Linux fdinfo だけを模擬する。
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const scenario = JSON.parse(process.env.GROK_TEST_SENTINEL_FDINFO);
const originalOpenSync = fs.openSync;
const originalExecFileSync = childProcess.execFileSync;
let namedRootFd = null;
if (scenario.namedRootPath) {
  fs.openSync = function (target, ...options) {
    const fd = originalOpenSync.call(this, target, ...options);
    if (target === scenario.namedRootPath) {
      namedRootFd = fd;
      fs.writeSync(2, `fixture-named-root-open:${fd}\n`);
    }
    return fd;
  };
  childProcess.execFileSync = function (file, ...options) {
    if (file === "/usr/bin/flock") return Buffer.alloc(0);
    return originalExecFileSync.call(this, file, ...options);
  };
}
// 誤って検査を通過した場合も、テストが管理できない孫を作らせない。
childProcess.spawn = function () {
  fs.writeSync(2, "fixture-unexpected-spawn\n");
  throw new Error("unexpected sentinel spawn in rejection test");
};
syncBuiltinESMExports();

const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...options) {
  const match = typeof file === "string" && /^\/proc\/self\/fdinfo\/(\d+)$/.exec(file);
  if (!match) return readFileSync.call(this, file, ...options);
  const fd = Number(match[1]);
  const stat = fs.fstatSync(fd, { bigint: true });
  fs.writeSync(2, `fixture-fd:${fd}:${stat.dev}:${stat.ino}\n`);
  const fault = scenario.fd === fd || fd === namedRootFd ? scenario.fault : "";
  if (fault === "unavailable") {
    const error = new Error("injected fdinfo read failure");
    error.code = "EACCES";
    throw error;
  }
  if (fault === "missing") return "flags:\t0\n";
  if (fault === "malformed") return "mnt_id:\tinvalid\n";
  if (fault === "duplicate") return "mnt_id:\t41\nmnt_id:\t41\n";
  return `mnt_id:\t${fault === "different" ? "42" : "41"}\n`;
};
