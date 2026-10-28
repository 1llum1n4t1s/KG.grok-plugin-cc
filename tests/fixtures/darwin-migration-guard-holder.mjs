import fs from "node:fs";
import { spawnSync } from "node:child_process";

const guard = process.argv[2];
const fd = fs.openSync(guard, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
const locked = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8", timeout: 5000 });
if (locked.status !== 0) throw new Error(`fixture guard acquisition failed: ${locked.stderr}`);
process.stdout.write("guard-held\n");
setInterval(() => {}, 1000);
