import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// 実 Linux の spawn だけを観測する。procfs・mount・lock は変更しない。
const root = process.env.GROK_LINUX_SIM_ROOT;
if (process.platform !== "linux" || !root || !path.isAbsolute(root) || fs.realpathSync(root) !== root) {
  throw new Error("Native Linux resume observer requires its isolated root");
}
if (process.argv[1]?.endsWith("grok-companion.mjs") && process.argv.includes("task")) {
  fs.writeFileSync(path.join(root, `marker-preload-ready-${process.pid}`), "ready", { flag: "wx", mode: 0o600 });
}
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const marker = process.env.GROK_LINUX_SIM_SPAWN_MARKER;
  if (marker && command === process.env.GROK_BIN && Array.isArray(args) && args[0] === "agent" && args[1] === "stdio" && !args.includes("--help")) {
    if (!marker.startsWith(`${root}${path.sep}`)) throw new Error("Agent marker is outside fixture root");
    fs.writeFileSync(`${marker}.attempt`, JSON.stringify({ owner: process.pid }), { flag: "wx", mode: 0o600 });
    const child = spawn.call(this, command, args, options);
    child.once("spawn", () => {
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8"), end = stat.lastIndexOf(") ");
      const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
      if (Number(fields[1]) !== process.pid || Number(fields[2]) !== child.pid) throw new Error("Spawned agent is not the owned group leader");
      fs.writeFileSync(marker, JSON.stringify({ pid: child.pid, owner: process.pid, group: Number(fields[2]) }), { flag: "wx", mode: 0o600 });
    });
    return child;
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
