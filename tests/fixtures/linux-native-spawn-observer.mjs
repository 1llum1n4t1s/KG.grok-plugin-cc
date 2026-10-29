import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// 実 CLI で agent spawn の試行と spawn() の返した PID を別々に記録する。
if (process.argv[1]?.endsWith("grok-companion.mjs") && process.argv[2] === "task") {
  const ready = process.env.GROK_NATIVE_SPAWN_OBSERVER_READY;
  const attempts = process.env.GROK_NATIVE_SPAWN_ATTEMPTS;
  if (!ready || !attempts || !process.env.GROK_BIN) throw new Error("native spawn observer configuration is missing");
  const append = value => {
    const fd = fs.openSync(attempts, "a", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const fd = fs.openSync(ready, "wx", 0o600);
  try { fs.writeFileSync(fd, `${process.pid}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const agent = command === process.env.GROK_BIN && Array.isArray(args) && args[0] === "agent" && args[1] === "stdio" &&
      !args.includes("--help") && !args.includes("--version");
    if (!agent) return spawn.call(this, command, args, options);
    append({ event: "attempt", ownerPid: process.pid });
    const child = spawn.call(this, command, args, options);
    append({ event: "returned", ownerPid: process.pid, childPid: child.pid ?? null });
    return child;
  };
  syncBuiltinESMExports();
}
