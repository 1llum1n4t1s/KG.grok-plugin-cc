import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { grokFixtureEnv, makeTempDir, removeTempFixture } from "./helpers.mjs";

const fixture = fileURLToPath(new URL("./fixtures/posix-owned-agent.mjs", import.meta.url));
const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function until(predicate: () => boolean, ms: number, detail: string) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await pause(20);
  }
  throw new Error(`Timed out: ${detail}`);
}

function message(parent: ChildProcess, type: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      parent.off("message", onMessage);
      parent.off("error", onError);
      parent.off("exit", onExit);
    };
    const onMessage = (value) => {
      if (value?.type !== type) return;
      cleanup(); resolve();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error(`Parent exited before ${type}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, ms);
    parent.on("message", onMessage);
    parent.once("error", onError);
    parent.once("exit", onExit);
  });
}

for (const mode of ["parent", "supervisor"] as const) {
  test(`Windows ${mode} forced exit stops owned agent and descendant`, {
    skip: process.platform !== "win32", timeout: 30000
  }, async () => {
    const directory = makeTempDir(`grok-windows-${mode}-`);
    const env = {
      ...grokFixtureEnv(fixture, path.join(directory, "grok")),
      POSIX_OWNED_FIXTURE: directory, POSIX_OWNED_MODE: "remaining",
      WINDOWS_OWNED_DETACHED_DESCENDANT: "1",
      XAI_API_KEY: "fixture", GROK_COMPANION_DISABLE_BROKER: "1",
      TMPDIR: directory, TMP: directory, TEMP: directory
    };
    const script = `
      import { GrokAcpClient } from ${JSON.stringify(moduleUrl)};
      const client = await GrokAcpClient.connectForeground(process.cwd(), {
        grokBin: process.env.GROK_BIN, env: process.env
      });
      if (!client.proc || !Number.isInteger(client.proc.pid)) throw new Error("Supervisor handle missing");
      process.on("message", (value) => {
        if (value !== "stop-supervisor") return;
        if (!client.proc.kill("SIGKILL")) throw new Error("Supervisor kill failed");
        process.send({ type: "supervisor-killed" });
      });
      setInterval(() => {}, 1000);
      process.send({ type: "ready" });
    `;
    const started = performance.now();
    const parent = spawn(process.execPath, mode === "parent" ? [cli, "task", "--json", "inspect"] : ["--input-type=module", "-e", script], {
      cwd: directory, env, windowsHide: true,
      stdio: mode === "parent" ? ["ignore", "ignore", "pipe"] : ["ignore", "ignore", "pipe", "ipc"]
    });
    let diagnostic = "";
    parent.stderr.on("data", chunk => { diagnostic += chunk; });
    let agent: number | undefined, grandchild: number | undefined;
    let originalFailure: Error | undefined;
    const readPid = (name: string) => {
      const file = path.join(directory, `${name}.pid`);
      if (!fs.existsSync(file)) return undefined;
      const pid = Number(fs.readFileSync(file, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, `Invalid ${name} PID`);
      return pid;
    };
    try {
      if (mode === "supervisor") await message(parent, "ready", 7000);
      else await until(() => {
        if (parent.exitCode !== null || parent.signalCode !== null) throw new Error("CLI exited before fixture readiness");
        return !!readPid("agent") && !!readPid("grandchild");
      }, 7000, "CLI agent and descendant readiness");
      assert.ok(performance.now() - started < 7000, "Startup took too long to exclude the fixture's 12-second fallback");
      agent = readPid("agent");
      grandchild = readPid("grandchild");
      assert.ok(agent && grandchild, "Agent and descendant must publish readiness");
      assert.ok(Number.isSafeInteger(parent.pid) && parent.pid > 0, "Parent must have a positive PID");
      assert.equal(new Set([agent, grandchild, process.pid, parent.pid]).size, 4,
        "Agent, descendant, test process, and spawned parent must have distinct PIDs");
      assert.equal(alive(agent), true, "Agent must be alive before forced exit");
      assert.equal(alive(grandchild), true, "Descendant must be alive before forced exit");
      const killedAt = performance.now();
      if (mode === "parent") assert.equal(parent.kill("SIGKILL"), true);
      else {
        const killed = message(parent, "supervisor-killed", 3000);
        parent.send("stop-supervisor");
        await killed;
      }
      await until(() => !alive(agent) && !alive(grandchild), Math.max(0, 3000 - (performance.now() - killedAt)),
        "agent and descendant stopped within three seconds of forced exit");
      assert.ok(performance.now() - started < 10000, "Termination must precede the fixture's 12-second fallback");
    } catch (error) {
      originalFailure = new Error(`Owned process verification failed; fixture: ${directory}; parent stderr: ${diagnostic}`, { cause: error });
      throw originalFailure;
    } finally {
      // PID を使った終了操作はしない。fixture 自身の marker / 12秒期限で復旧する。
      try {
        fs.writeFileSync(path.join(directory, "stop"), "stop");
        if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
        await until(() => {
          agent ??= readPid("agent");
          grandchild ??= readPid("grandchild");
          return parent.exitCode !== null || parent.signalCode !== null
            ? !!agent && !!grandchild && !alive(agent) && !alive(grandchild)
            : false;
        }, 14000, "owned processes and parent stopped");
        removeTempFixture(directory, { recursive: true, force: true });
      } catch (error) {
        const cleanupFailure = new Error(`Cleanup unconfirmed; retained: ${directory}; parent stderr: ${diagnostic}`, { cause: error });
        if (originalFailure) {
          throw new AggregateError([originalFailure, cleanupFailure],
            `Owned process verification and cleanup failed; retained: ${directory}`, { cause: originalFailure });
        }
        throw cleanupFailure;
      }
    }
  });
}
