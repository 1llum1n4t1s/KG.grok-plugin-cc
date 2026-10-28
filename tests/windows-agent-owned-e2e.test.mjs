import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { spawnWindowsAgent } from "../plugins/grok/scripts/lib/windows-agent.mjs";
import { getProcessSnapshot } from "../plugins/grok/scripts/lib/process.mjs";

const enabled = process.platform === "win32" && process.env.GROK_OWNED_AGENT_E2E === "1";
const text = "日🙂x".repeat(8192);
const fake = String.raw`
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--grandchild')) {
  send({ role: 'grandchild', pid: process.pid });
  setInterval(() => {}, 1000);
} else {
  send({ role: 'boot', pid: process.pid });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method !== 'start') throw Error('Bootstrap leaked into agent stdin');
    if (process.env.OWNED_AGENT_MODE === 'natural') {
      const bytes = Buffer.from(JSON.stringify({ role: 'natural', text: '日🙂x'.repeat(8192), received: message }) + '\n');
      for (let offset = 0; offset < bytes.length; offset += 4093) process.stdout.write(bytes.subarray(offset, offset + 4093));
      process.stdout.write('', () => process.exit(0));
    } else {
      spawn(process.execPath, [process.argv[1], '--grandchild'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      send({ role: 'root', pid: process.pid });
      // EOFを無視して存続し、Jobだけがこのfake treeを終了できるようにする。
      setInterval(() => {}, 1000);
    }
  });
}
`;

function fixture(t, mode) {
  const root = path.resolve(os.tmpdir());
  for (let current = root; ; current = path.dirname(current)) {
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `Fixture parent must not be a reparse point: ${current}`);
    if (path.dirname(current) === current) break;
  }
  fs.accessSync(root, fs.constants.W_OK);
  const cwd = fs.mkdtempSync(path.join(root, "grok-owned agent 日-"));
  const source = path.join(cwd, "agent.mjs");
  const wrapper = path.join(cwd, "grok-owned.cmd");
  fs.writeFileSync(source, fake);
  // cmdファイル本体はASCIIにし、既定CP932でもUnicodeのディレクトリを保持する。
  fs.writeFileSync(wrapper, '@echo off\r\n"%GROK_OWNED_NODE%" "%~dp0agent.mjs" %*\r\n');
  // Windows実削除禁止のため、再現用fixtureを明示して保持する。
  t.diagnostic(`Retained owned-fake fixture: ${cwd}`);
  return { cwd, wrapper, env: { ...process.env, TEMP: cwd, TMP: cwd, OWNED_AGENT_MODE: mode, GROK_OWNED_NODE: process.execPath,
    PATH: cwd + path.delimiter + (process.env.PATH ?? "") } };
}

async function until(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

function readFrames(proc) {
  const rows = [];
  let buffer = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      rows.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  return { rows, stderr: () => stderr };
}

for (const command of ["absolute-cmd", "PATH-PATHEXT"]) {
  test(`Windows owned agent natural exit preserves ${command}, Unicode and byte framing`, { skip: !enabled, timeout: 20000 }, async t => {
    const f = fixture(t, "natural");
    const owned = await spawnWindowsAgent(f.cwd, command === "absolute-cmd" ? `"${f.wrapper}"` : "grok-owned", ["agent", "stdio"], { env: f.env });
    const frames = readFrames(owned.proc);
    try {
      await owned.ready;
      owned.proc.stdin.write('{"method":"start"}\n');
      await until(() => frames.rows.some(row => row.role === "natural"), "natural agent frame");
      await until(() => owned.stopConfirmed, "same-job empty ACK after natural exit");
      assert.equal(await owned.close(), true);
      const response = frames.rows.find(row => row.role === "natural");
      assert.equal(response.text, text);
      assert.deepEqual(response.received, { method: "start" });
      assert.equal(frames.stderr(), "");
    } finally { await owned.close(); }
  });
}

test("Windows owned Job stops only its EOF-ignoring fake root and detached grandchild", { skip: !enabled, timeout: 20000 }, async t => {
  const f = fixture(t, "hold");
  const owned = await spawnWindowsAgent(f.cwd, `"${f.wrapper}"`, ["agent", "stdio"], { env: f.env });
  const frames = readFrames(owned.proc);
  try {
    await owned.ready;
    owned.proc.stdin.write('{"method":"start"}\n');
    await until(() => frames.rows.some(row => row.role === "root") && frames.rows.some(row => row.role === "grandchild"), "owned fake root and grandchild started");
    const identities = frames.rows.filter(row => ["root", "grandchild"].includes(row.role)).map(row => ({ pid: row.pid, snapshot: getProcessSnapshot(row.pid) }));
    assert.ok(identities.every(row => /^win32-filetime:/.test(row.snapshot?.startKey ?? "")));
    assert.equal(await owned.close(), true, "confirmation requires this Job's ActiveProcesses=0 ACK");
    for (const identity of identities) {
      await until(() => {
        try { process.kill(identity.pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
        const current = getProcessSnapshot(identity.pid);
        return current && current.startKey !== identity.snapshot.startKey;
      }, `owned fake identity ${identity.pid} exited`);
    }
    assert.equal(frames.stderr(), "");
  } finally { await owned.close(); }
});

// 同じ親プロセスが所有する本物のpipeで、受信messageだけを欠落させる。
function controlledServer(onMessage) {
  const server = net.createServer();
  const register = server.on.bind(server);
  server.on = (event, listener) => {
    if (event !== "connection") return register(event, listener);
    return register(event, socket => {
      const listen = socket.on.bind(socket);
      socket.on = (name, handler) => {
        if (name !== "data") return listen(name, handler);
        let buffered = "";
        return listen(name, chunk => {
          buffered += chunk;
          let end;
          while ((end = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
            if (onMessage(JSON.parse(line), socket)) handler(line + "\n");
          }
        });
      };
      listener(socket);
    });
  };
  return server;
}

test("Windows actual Job emptiness without the stopped ACK remains unconfirmed", { skip: !enabled, timeout: 20000 }, async t => {
  const f = fixture(t, "hold");
  let dropped = false;
  const owned = await spawnWindowsAgent(f.cwd, `"${f.wrapper}"`, ["agent", "stdio"], { env: f.env,
    createServerImpl: () => controlledServer(message => {
      if (message.state === "stopped") { dropped = true; return false; }
      return true;
    }) });
  const frames = readFrames(owned.proc);
  try {
    await owned.ready;
    owned.proc.stdin.write('{"method":"start"}\n');
    await until(() => frames.rows.some(row => row.role === "grandchild"), "owned fake grandchild started");
    assert.equal(await owned.close(), false, "transport loss must not become a stop confirmation");
    assert.equal(dropped, true, "the helper actually confirmed same-job emptiness before its ACK was dropped");
    assert.equal(owned.stopConfirmed, false);
  } finally { await owned.close(); }
});

test("Windows startup control loss cleans its already-owned fake agent without claiming ready", { skip: !enabled, timeout: 20000 }, async t => {
  const f = fixture(t, "hold");
  let readySocket;
  const owned = await spawnWindowsAgent(f.cwd, `"${f.wrapper}"`, ["agent", "stdio"], { env: f.env,
    createServerImpl: () => controlledServer((message, socket) => {
      if (message.state === "ready") { readySocket = socket; return false; }
      return true;
    }) });
  const frames = readFrames(owned.proc);
  try {
    await until(() => readySocket && frames.rows.some(row => row.role === "boot"), "owned fake booted before ready delivery");
    const pid = frames.rows.find(row => row.role === "boot").pid;
    const original = getProcessSnapshot(pid);
    assert.ok(original?.startKey);
    readySocket.destroy();
    await assert.rejects(owned.ready, /before startup/);
    assert.equal(await owned.close(), false);
    await until(() => {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
      const current = getProcessSnapshot(pid);
      return current && current.startKey !== original.startKey;
    }, "startup-failed owned fake exited");
  } finally { await owned.close(); }
});

test("Windows pinned owner death releases only its owned fake Job", { skip: !enabled, timeout: 30000 }, async t => {
  const f = fixture(t, "hold");
  const ownerScript = path.join(f.cwd, "owner.mjs");
  const moduleUrl = pathToFileURL(path.resolve("plugins/grok/scripts/lib/windows-agent.mjs")).href;
  fs.writeFileSync(ownerScript, `
    import { spawnWindowsAgent } from ${JSON.stringify(moduleUrl)};
    const owned = await spawnWindowsAgent(${JSON.stringify(f.cwd)}, ${JSON.stringify(`"${f.wrapper}"`)}, ['agent','stdio']);
    owned.proc.stdout.pipe(process.stdout);
    owned.proc.stderr.pipe(process.stderr);
    await owned.ready;
    process.stdout.write(JSON.stringify({role:'supervisor',pid:owned.proc.pid})+'\\n');
    owned.proc.stdin.write('{"method":"start"}\\n');
    process.stdin.once('data', () => process.exit(0));
  `);
  const owner = spawn(process.execPath, [ownerScript], { cwd: f.cwd, env: f.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise(resolve => owner.once("close", resolve));
  const frames = readFrames(owner);
  try {
    await until(() => ["supervisor", "root", "grandchild"].every(role => frames.rows.some(row => row.role === role)), "owned tree and supervisor observed before owner exit");
    const identities = frames.rows.filter(row => ["supervisor", "root", "grandchild"].includes(row.role)).map(row => ({ pid: row.pid, snapshot: getProcessSnapshot(row.pid) }));
    assert.ok(identities.every(row => row.snapshot?.startKey));
    owner.stdin.write("exit naturally\n");
    await exited;
    assert.equal(owner.exitCode, 0);
    for (const identity of identities) {
      await until(() => {
        try { process.kill(identity.pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
        const current = getProcessSnapshot(identity.pid);
        return current && current.startKey !== identity.snapshot.startKey;
      }, `owner-death fake identity ${identity.pid} exited`);
    }
  } finally {
    if (owner.exitCode === null) owner.stdin.end("exit naturally\n");
    await exited;
  }
});
