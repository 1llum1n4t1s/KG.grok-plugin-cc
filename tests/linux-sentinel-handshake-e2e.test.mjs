import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 独立試作。実製品の marker 検証、PID 再利用、電源断後の耐久性を証明するものではない。
// 先行失敗条件: 未認可 sentinel の孤児化、未同期 marker の受理、期限切れ後の遅延 commit、
// commit/ready/ack 境界での親死亡、fsync 失敗、認証なしの停止、テスト後の daemon 残存。
const self = fileURLToPath(import.meta.url);
const role = process.argv[2];
const dir = process.argv[3];
const nonce = process.argv[4];
const endpoint = `\0grok-sentinel-proof-${nonce}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function syncDir(target) {
  const fd = fs.openSync(target, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncFile(target, content) {
  const fd = fs.openSync(target, "wx", 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function state(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { status: fields[0], start: fields[19] };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}
function alive(pid, start) {
  const current = state(pid);
  return !!current && current.start === start && !["Z", "X"].includes(current.status);
}

if (role === "sentinel") {
  let committed = false;
  let command = "";
  process.stdout.on("error", () => {});
  process.stdin.setEncoding("utf8");
  const timeout = setTimeout(() => { if (!committed) process.exit(0); }, 1800);
  process.stdin.on("end", () => { if (!committed) process.exit(0); });
  process.stdin.on("data", data => {
    if (committed) return;
    command += data;
    const expected = `commit:${nonce}`;
    if (!expected.startsWith(command)) process.exit(1);
    if (command !== expected) return;
    committed = true;
    clearTimeout(timeout);
    const server = net.createServer(socket => {
      let input = "";
      socket.on("data", data => {
        input += data;
        if (!input.endsWith("\n")) return;
        if (input !== `stop:${nonce}\n`) return socket.end("denied\n");
        socket.end("stopped\n", () => server.close(() => process.exit(0)));
      });
    });
    server.listen(endpoint, () => {
      syncFile(path.join(dir, "ready"), nonce);
      syncDir(dir);
      process.stdout.write("ready\n");
    });
  });
  process.stdout.write("started\n");
} else if (role === "bootstrap") {
  const child = spawn(process.execPath, [self, "sentinel", dir, nonce], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  let pending = "";
  let commitReported = false;
  let readyPending = false;
  child.stdout.on("data", data => {
    pending += data;
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) break;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line === "started") process.send?.({ stage: "started", pid: child.pid });
      if (line === "ready") {
        if (commitReported) process.send?.({ stage: "ready", pid: child.pid });
        else readyPending = true;
      }
    }
  });
  child.once("error", error => { process.send?.({ error: error.message }); process.exitCode = 1; });
  process.on("message", message => {
    try {
      switch (message) {
        case "prepare":
          syncFile(path.join(dir, "prepared"), nonce);
          process.send?.({ stage: "prepared", pid: child.pid });
          break;
        case "file-fsync-error":
          fs.writeFileSync(path.join(dir, "prepared"), nonce, { flag: "wx", mode: 0o600 });
          throw new Error("injected marker file fsync failure");
        case "link":
          fs.linkSync(path.join(dir, "prepared"), path.join(dir, "marker"));
          process.send?.({ stage: "linked", pid: child.pid });
          break;
        case "dir-fsync":
          syncDir(dir);
          process.send?.({ stage: "synced", pid: child.pid });
          break;
        case "dir-fsync-error":
          throw new Error("injected marker directory fsync failure");
        case "commit":
          child.stdin.write(`commit:${nonce}`, error => {
            if (error) return process.send?.({ error: error.message });
            commitReported = true;
            process.send?.({ stage: "committed", pid: child.pid });
            if (readyPending) process.send?.({ stage: "ready", pid: child.pid });
          });
          break;
        case "commit-pending":
          process.send?.({ stage: "commit-pending", pid: child.pid });
          child.stdin.write(`commit:${nonce}`);
          break;
        default: throw new Error("unknown command");
      }
    } catch (error) {
      process.send?.({ error: error.message }, () => process.exit(1));
    }
  });
} else {
  const root = process.env.GROK_PID_NAMESPACE_TEST_ROOT;
  const enabled = process.platform === "linux" && !!root;
  const options = { skip: enabled ? false : "set GROK_PID_NAMESPACE_TEST_ROOT to an isolated Linux tmpfs/ext4 root", timeout: 15000 };

  function request(socketPath, message) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      let result = "";
      socket.setTimeout(2000, () => socket.destroy(new Error("sentinel request timed out")));
      socket.on("connect", () => socket.write(message));
      socket.on("data", data => { result += data; });
      socket.on("end", () => resolve(result));
      socket.on("error", reject);
    });
  }
  async function eventually(check, description) {
    for (let i = 0; i < 60; i++) {
      if (check()) return;
      await wait(50);
    }
    throw new Error(description);
  }
  async function fixture(t) {
    const base = fs.realpathSync(root);
    const area = fs.mkdtempSync(path.join(base, "sentinel-handshake-"));
    const key = randomBytes(16).toString("hex");
    const address = `\0grok-sentinel-proof-${key}`;
    const owner = spawn(process.execPath, [self, "bootstrap", area, key], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const messages = [];
    const waiters = [];
    const close = new Promise(resolve => owner.once("close", resolve));
    let pid, start;
    const killOwner = async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await close;
    };
    const marker = () => fs.existsSync(path.join(area, "marker"));
    const ready = () => fs.existsSync(path.join(area, "ready"));
    t.after(async () => {
      await killOwner();
      if (!pid || !start) {
        await wait(1900);
        throw new Error(`sentinel identity unavailable; retained ${area}`);
      }
      if (alive(pid, start)) await eventually(() => ready() || !alive(pid, start), `sentinel ${pid} did not resolve authorization`);
      if (alive(pid, start) && ready()) await request(address, `stop:${key}\n`);
      await eventually(() => !alive(pid, start), `sentinel ${pid} remained alive`);
      fs.rmSync(area, { recursive: true, force: true });
    });
    owner.on("message", message => { messages.push(message); while (waiters.length) waiters.shift()(); });
    const receive = async stage => {
      for (;;) {
        if (messages.length) {
          const message = messages.shift();
          if (message.error) throw new Error(message.error);
          assert.equal(message.stage, stage);
          return message;
        }
        await Promise.race([new Promise(resolve => waiters.push(resolve)), wait(5000).then(() => { throw new Error(`missing ${stage}`); })]);
      }
    };
    const initial = await receive("started");
    pid = initial.pid;
    start = state(pid)?.start;
    assert.ok(start);
    const command = async (value, stage) => { owner.send(value); return receive(stage); };
    return { pid, start, key, address, area, owner, command, receive, killOwner, marker, ready };
  }

  for (const phase of ["started", "prepared", "linked", "synced"]) {
    test(`uncommitted sentinel exits when bootstrap dies at ${phase}`, options, async t => {
      const f = await fixture(t);
      if (phase !== "started") await f.command("prepare", "prepared");
      if (["linked", "synced"].includes(phase)) await f.command("link", "linked");
      if (phase === "synced") await f.command("dir-fsync", "synced");
      await f.killOwner();
      await eventually(() => !alive(f.pid, f.start), "uncommitted sentinel survived parent death");
      assert.equal(f.ready(), false);
    });
  }
  for (const failure of ["file-fsync-error", "dir-fsync-error"]) {
    test(`injected ${failure} never authorizes sentinel`, options, async t => {
      const f = await fixture(t);
      if (failure === "dir-fsync-error") {
        await f.command("prepare", "prepared");
        await f.command("link", "linked");
      }
      f.owner.send(failure);
      await assert.rejects(f.receive("unused"), /injected marker/);
      await f.killOwner();
      await eventually(() => !alive(f.pid, f.start), "sentinel survived fsync failure");
      assert.equal(f.ready(), false);
    });
  }
  test("expired sentinel cannot accept a delayed commit", options, async t => {
    const f = await fixture(t);
    await f.command("prepare", "prepared");
    await f.command("link", "linked");
    await f.command("dir-fsync", "synced");
    await eventually(() => !alive(f.pid, f.start), "pre-commit deadline did not expire");
    f.owner.send("commit");
    await wait(100);
    assert.equal(f.ready(), false);
  });
  test("bootstrap death during commit leaves either no ready or a stoppable sentinel", options, async t => {
    const f = await fixture(t);
    await f.command("prepare", "prepared");
    await f.command("link", "linked");
    await f.command("dir-fsync", "synced");
    await f.command("commit-pending", "commit-pending");
    await f.killOwner();
    await eventually(() => f.ready() || !alive(f.pid, f.start), "commit outcome remained unresolved");
    if (f.ready()) {
      assert.equal(f.marker(), true);
      assert.equal(await request(f.address, `stop:${f.key}\n`), "stopped\n");
      await eventually(() => !alive(f.pid, f.start), "committed sentinel did not stop");
    }
  });
  for (const delay of [1700, 1800, 1900]) {
    test(`commit racing deadline at ${delay} ms is resolved safely`, options, async t => {
      const f = await fixture(t);
      await f.command("prepare", "prepared");
      await f.command("link", "linked");
      await f.command("dir-fsync", "synced");
      await wait(delay);
      f.owner.send("commit");
      await wait(100);
      await f.killOwner();
      await eventually(() => f.ready() || !alive(f.pid, f.start), "deadline race remained unresolved");
      if (f.ready()) {
        assert.equal(f.marker(), true);
        assert.equal(alive(f.pid, f.start), true);
        assert.equal(await request(f.address, `stop:${f.key}\n`), "stopped\n");
        await eventually(() => !alive(f.pid, f.start), "deadline-race sentinel did not stop");
      }
    });
  }
  for (const phase of ["committed", "ready"]) {
    test(`authorized sentinel survives a lost ${phase} acknowledgement and stops cooperatively`, options, async t => {
      const f = await fixture(t);
      await f.command("prepare", "prepared");
      await f.command("link", "linked");
      await f.command("dir-fsync", "synced");
      await f.command("commit", "committed");
      if (phase === "ready") await f.receive("ready");
      await f.killOwner();
      await eventually(f.ready, "committed sentinel did not publish ready");
      assert.equal(f.marker(), true);
      assert.equal(alive(f.pid, f.start), true);
      assert.equal(await request(f.address, "stop:incorrect\n"), "denied\n");
      assert.equal(alive(f.pid, f.start), true);
      assert.equal(await request(f.address, `stop:${f.key}\n`), "stopped\n");
      await eventually(() => !alive(f.pid, f.start), "cooperative stop did not exit");
    });
  }
}
