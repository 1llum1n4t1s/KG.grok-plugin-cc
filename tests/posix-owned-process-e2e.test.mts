import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { Duplex } from "node:stream";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

const fake = fileURLToPath(new URL("./fixtures/posix-owned-agent.mjs", import.meta.url));
const options = { skip: process.platform === "win32", timeout: 30000 };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, detail) {
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) { if (predicate()) return; await pause(20); }
  throw new Error(`Timed out: ${detail}`);
}
function alive(pid) {
  if (process.platform === "linux") {
    try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return !["Z", "X", "x"].includes(stat.slice(stat.lastIndexOf(") ") + 2)[0]); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function assertOwnedGroup(supervisor, ...members) {
  for (const pid of [supervisor, ...members]) {
    const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(Number(result.stdout.trim()), supervisor, `owned process ${pid} shares the supervisor group`);
  }
}
for (const scenario of ["exit-json", "stop-data", "spawn-error", "group-guard"]) {
  test(`POSIX supervisor fd3 protocol: ${scenario}`, options, async () => {
    const directory = makeTempDir("grok-posix-protocol-");
    const supervisor = fileURLToPath(new URL("../plugins/grok/scripts/lib/posix-agent-supervisor.mjs", import.meta.url));
    const runtimeArgs = "bun" in process.versions ? ["--no-env-file"] : [];
    const code = scenario === "exit-json" ? "process.exit(7)" : "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";
    const command = scenario === "spawn-error" ? path.join(directory, "missing") : process.execPath;
    const child = spawn(process.execPath, [...runtimeArgs, supervisor, command, ...runtimeArgs, "-e", code], {
      cwd: directory, detached: scenario !== "group-guard", stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: directory, TMP: directory, TEMP: directory }
    });
    let report = "", stderr = "", closed = false;
    child.stdio[3].on("data", chunk => { report += chunk; });
    child.stdio[3].on("error", () => {});
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }));
    try {
      if (scenario === "stop-data") {
        await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("exit", () => reject(new Error("Agent exited before ready"))); });
        (child.stdio[3] as Duplex).write("stop\n");
      }
      const result = await done;
      if (scenario === "group-guard") {
        assert.deepEqual(result, { code: 1, signal: null });
        assert.match(stderr, /Could not establish the owned Grok process group/);
        assert.equal(report, "");
      } else {
        const exit = JSON.parse(report);
        assert.deepEqual(exit, scenario === "exit-json" ? { code: 7, signal: null } : scenario === "spawn-error" ? { code: 1, signal: null } : { code: null, signal: "SIGTERM" });
      }
    } finally {
      if (!closed) { (child.stdio[3] as Duplex).write("stop\n"); await done; }
      removeTempFixture(directory, { recursive: true, force: true });
    }
  });
}
for (const mode of ["normal", "remaining", "write-error", "closed-control"]) {
  test(`POSIX real ACP close: ${mode}`, options, async () => {
    const directory = makeTempDir("grok-posix-owned-空 白-");
    fs.writeFileSync(path.join(directory, ".env"), "GROK_DOTENV_PROBE=unexpected\n");
    const executable = path.join(directory, "grok");
    fs.writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${"bun" in process.versions ? "--no-env-file " : ""}${quote(fake)} "$@"\n`, { mode: 0o700 });
    const env = { ...process.env, GROK_BIN: executable, POSIX_OWNED_FIXTURE: directory, POSIX_OWNED_MODE: mode, TMPDIR: directory, TMP: directory, TEMP: directory };
    let client, agent, grandchild;
    const originalKill = process.kill;
    process.kill = function(pid, signal) {
      assert.equal(pid < 0 && signal !== 0, false, "parent never signals a process group");
      return originalKill.call(process, pid, signal);
    };
    try {
      client = await GrokAcpClient.connectForeground(directory, { grokBin: executable, env });
      agent = Number(fs.readFileSync(path.join(directory, "agent.pid"), "utf8"));
      assert.notEqual(client.proc.pid, agent);
      if (mode === "remaining") grandchild = Number(fs.readFileSync(path.join(directory, "grandchild.pid"), "utf8"));
      assertOwnedGroup(client.proc.pid, agent, ...(grandchild ? [grandchild] : []));
      if (mode === "write-error") {
        let requested;
        const request = new Promise(resolve => { requested = resolve; });
        client.proc.stdio[3].write = () => { requested(); throw new Error("fixture fd3 write failure"); };
        const closing = client.close();
        await request;
        assert.equal(alive(agent), true, "a failed control write does not fall back to a signal");
        fs.writeFileSync(path.join(directory, "stop"), "stop");
        await closing;
      }
      if (mode === "closed-control") client.proc.stdio[3].destroy();
      await Promise.all([client.close(), client.close()]);
      assert.equal(alive(agent), false);
      assert.equal(client.closeStopUnconfirmed, false);
      if (grandchild) assert.equal(alive(grandchild), false);
    } finally {
      process.kill = originalKill;
      if (!client) throw new Error(`Agent ownership unconfirmed; retained: ${directory}`);
      await client.close();
      fs.writeFileSync(path.join(directory, "stop"), "stop");
      await until(() => [agent, grandchild].every(pid => !pid || !alive(pid)), "owned processes stopped");
      if (client?.proc && client.proc.exitCode === null && client.proc.signalCode === null) throw new Error(`Child close unconfirmed; retained: ${directory}`);
      removeTempFixture(directory, { recursive: true, force: true });
    }
  });
}

test("POSIX agent natural exit stops its remaining descendant", options, async () => {
  const directory = makeTempDir("grok-posix-natural-");
  const executable = path.join(directory, "grok");
  fs.writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, GROK_BIN: executable, POSIX_OWNED_FIXTURE: directory, POSIX_OWNED_MODE: "natural", TMPDIR: directory, TMP: directory, TEMP: directory };
  let client, agent, grandchild;
  try {
    client = await GrokAcpClient.connectForeground(directory, { grokBin: executable, env });
    agent = Number(fs.readFileSync(path.join(directory, "agent.pid"), "utf8"));
    grandchild = Number(fs.readFileSync(path.join(directory, "grandchild.pid"), "utf8"));
    await until(() => !alive(agent) && !alive(grandchild), "natural agent exit and descendant cleanup");
    await client.close();
    assert.equal(client.closeStopUnconfirmed, false);
  } finally {
    fs.writeFileSync(path.join(directory, "stop"), "stop");
    await client?.close();
    await until(() => [agent, grandchild].every(pid => !pid || !alive(pid)), "owned processes stopped");
    removeTempFixture(directory, { recursive: true, force: true });
  }
});

for (const signal of ["SIGTERM", "SIGKILL"] as NodeJS.Signals[]) {
  test(`POSIX parent ${signal} stops owned agent and descendant`, options, async () => {
    const directory = makeTempDir("grok-posix-parent-");
    const executable = path.join(directory, "grok");
    fs.writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 });
    const env = { ...process.env, GROK_BIN: executable, POSIX_OWNED_FIXTURE: directory, POSIX_OWNED_MODE: "remaining", TMPDIR: directory, TMP: directory, TEMP: directory };
    const moduleUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
    const script = `import { GrokAcpClient } from ${JSON.stringify(moduleUrl)}; await GrokAcpClient.connectForeground(process.cwd(), { grokBin: process.env.GROK_BIN, env: process.env }); process.send('ready');`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let agent, grandchild;
    try {
      await new Promise((resolve, reject) => { parent.once("message", resolve); parent.once("error", reject); parent.once("exit", () => reject(new Error("Parent exited before readiness"))); });
      agent = Number(fs.readFileSync(path.join(directory, "agent.pid"), "utf8"));
      grandchild = Number(fs.readFileSync(path.join(directory, "grandchild.pid"), "utf8"));
      assert.equal(alive(agent) && alive(grandchild), true);
      parent.kill(signal);
      await until(() => !alive(agent) && !alive(grandchild), "agent and descendant stopped after parent exit");
    } finally {
      fs.writeFileSync(path.join(directory, "stop"), "stop");
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await until(() => [agent, grandchild].every(pid => !pid || !alive(pid)), "owned processes stopped");
      removeTempFixture(directory, { recursive: true, force: true });
    }
  });
}
