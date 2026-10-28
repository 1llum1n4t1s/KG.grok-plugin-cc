// commit 受信後、非同期 listen callback だけを保留する。同期 fsync は妨げない。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const { GROK_LINUX_SIM_ROOT: root, GROK_HISTORY_COMMIT_GATE: gate, GROK_HISTORY_COMMIT_RELEASE: release } = process.env;
if (gate && process.argv[1]?.endsWith("linux-state-sentinel.mjs") && process.argv[2] === "sentinel") {
  if (!root || !release || path.dirname(gate) !== root || path.dirname(release) !== root) throw new Error("Invalid sentinel commit gate");
  const create = net.createServer;
  net.createServer = function (...args) {
    const server = create.apply(this, args), listen = server.listen;
    server.listen = function (...listenArgs) {
      const callback = listenArgs.at(-1);
      if (typeof callback !== "function") throw new Error("Sentinel listen callback is unavailable");
      listenArgs[listenArgs.length - 1] = () => {
        fs.writeFileSync(gate, `${JSON.stringify({ pid: process.pid, parent: process.ppid })}\n`, { flag: "wx", mode: 0o600 });
        const timer = setInterval(() => {
          if (!fs.existsSync(release)) return;
          clearInterval(timer); callback();
        }, 20);
      };
      return listen.apply(this, listenArgs);
    };
    return server;
  };
  syncBuiltinESMExports();
}
