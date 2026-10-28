import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// macOS の Linux 模擬環境で、公開操作の syscall 境界を記録する。
const original = cp.execFileSync;
cp.execFileSync = function (command, args, options = {}) {
  const event = { pid: process.pid, at: String(process.hrtime.bigint()) };
  if (command === "/usr/bin/flock") {
    const fd = options.stdio?.[3];
    if (typeof fd === "number") {
      const st = fs.fstatSync(fd, { bigint: true });
      event.kind = st.isDirectory() ? "root" : "native";
      event.dev = String(st.dev); event.ino = String(st.ino);
    }
  } else if (args?.[1] === "bootstrap") {
    event.kind = "bootstrap";
    event.args = args.slice(6);
    if (typeof options.stdio?.[7] === "number") {
      const st = fs.fstatSync(options.stdio[7], { bigint: true });
      event.dev = String(st.dev); event.ino = String(st.ino);
    }
  }
  if (event.kind) fs.appendFileSync(process.env.GROK_ROOT_BOOTSTRAP_AUDIT, `${JSON.stringify(event)}\n`);
  return original.call(this, command, args, options);
};
syncBuiltinESMExports();
