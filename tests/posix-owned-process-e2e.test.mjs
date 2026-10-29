import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
for (const mode of ["normal", "remaining"]) {
  test(`POSIX real ACP close: ${mode}`, options, async () => {
    const directory = makeTempDir("grok-posix-owned-");
    const executable = path.join(directory, "grok");
    fs.writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 });
    const env = { ...process.env, GROK_BIN: executable, POSIX_OWNED_FIXTURE: directory, POSIX_OWNED_MODE: mode, TMPDIR: directory, TMP: directory, TEMP: directory };
    let client, agent, grandchild;
    try {
      client = await GrokAcpClient.connectForeground(directory, { grokBin: executable, env });
      agent = Number(fs.readFileSync(path.join(directory, "agent.pid"), "utf8"));
      assert.notEqual(client.proc.pid, agent);
      if (mode === "remaining") grandchild = Number(fs.readFileSync(path.join(directory, "grandchild.pid"), "utf8"));
      await client.close();
      assert.equal(alive(agent), false);
      assert.equal(client.closeStopUnconfirmed, false);
      if (grandchild) assert.equal(alive(grandchild), false);
    } finally {
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

for (const signal of ["SIGTERM", "SIGKILL"]) {
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
