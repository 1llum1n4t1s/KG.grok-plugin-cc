import fs from "node:fs";
import { spawnSync } from "node:child_process";

// 独立した open-file-description から非待機で root directory flock を試す。
const stateDir = process.env.GROK_LINUX_SIM_STATE_DIR;
const fd = fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  const result = spawnSync("/usr/bin/flock", ["-x", "-n", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000 });
  if (result.status === 0) { process.stdout.write("available\n"); process.exitCode = 0; }
  else if (result.status === 1) { process.stdout.write("busy\n"); process.exitCode = 73; }
  else {
    process.stderr.write(`flock probe failed: ${result.error?.message ?? result.stderr?.toString() ?? result.status}\n`);
    process.exitCode = 2;
  }
} finally { fs.closeSync(fd); }
