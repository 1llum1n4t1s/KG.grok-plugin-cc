import { spawnSync } from "node:child_process";

// FD 3 は親が開いた root directory の同じ open-file-description。
const result = spawnSync("/usr/bin/flock", ["-x", "-n", "3"], { stdio: ["ignore", "pipe", "pipe", 3], timeout: 5000 });
if (result.status !== 0) {
  process.stderr.write(`root flock fixture failed: ${result.error?.message ?? result.stderr?.toString() ?? result.status}\n`);
  process.exitCode = 1;
}
