import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeTempFixture } from "./helpers.mjs";

const sentinel = fileURLToPath(new URL("../plugins/grok/scripts/lib/linux-state-sentinel.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/linux-sentinel-fdinfo-preload.mjs", import.meta.url));
const directPreload = fileURLToPath(new URL("./fixtures/linux-sentinel-direct-preload.mjs", import.meta.url));
const scenarios = [
  { fd: 5, fault: "different", visited: [6, 5] },
  { fd: 3, fault: "different", visited: [6, 5, 3] },
  { fd: 4, fault: "different", visited: [6, 5, 3, 4] },
  ...["unavailable", "missing", "malformed", "duplicate"].map(fault => ({ fd: 6, fault, visited: [6] }))
];

// 失敗条件: fdinfo の異常や mount 不一致を無視し、sentinel を起動したり marker を変更する。
for (const scenario of scenarios) {
  test(`simulated Mac bootstrap rejects fd ${scenario.fd} ${scenario.fault} before side effects`,
    { skip: process.platform !== "darwin", timeout: 15000 }, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sentinel-fdinfo-"));
      const barrier = path.join(root, "state.lock");
      const marker = path.join(barrier, "prepared.json");
      const lock = path.join(barrier, "native.lock");
      const fds = [];
      try {
        fs.mkdirSync(barrier, { mode: 0o700 });
        fs.writeFileSync(marker, "prepared evidence\n", { mode: 0o600 });
        fs.writeFileSync(lock, "lock evidence\n", { mode: 0o600 });
        for (const [name, flags] of [[lock, "r"], [marker, "r+"], [barrier, "r"], [root, "r"]]) {
          fds.push(fs.openSync(name, flags));
        }
        const expected = fds.map(fd => {
          const stat = fs.fstatSync(fd, { bigint: true });
          return `${stat.dev}:${stat.ino}`;
        });
        const payload = Buffer.from(JSON.stringify({ sentinel: { generation: "test", nonce: "test" } })).toString("base64url");
        const child = spawn(process.execPath, ["--import", preload, sentinel, "bootstrap", root, barrier, marker, payload], {
          env: { ...process.env, GROK_TEST_SENTINEL_FDINFO: JSON.stringify(scenario) },
          stdio: ["ignore", "pipe", "pipe", ...fds]
        });
        let stdout = "", stderr = "", timedOut = false;
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 8000);
        let status;
        try {
          status = await new Promise(resolve => {
            let error;
            child.on("error", cause => { error = cause; });
            child.once("close", (code, signal) => resolve({ code, signal, error }));
          });
        } finally { clearTimeout(timeout); }
        assert.equal(status.error, undefined);
        assert.equal(timedOut, false, "direct bootstrap child did not exit in time");
        assert.equal(status.signal, null);
        assert.notEqual(status.code, 0);
        assert.equal(stdout, "");
        assert.doesNotMatch(stderr, /fixture-unexpected-spawn/);
        const observed = [...stderr.matchAll(/^fixture-fd:(\d+):(\d+):(\d+)$/gm)];
        assert.deepEqual(observed.map(match => Number(match[1])), scenario.visited);
        for (const match of observed) assert.equal(`${match[2]}:${match[3]}`, expected[Number(match[1]) - 3]);
        assert.deepEqual(fs.readdirSync(barrier).sort(), ["native.lock", "prepared.json"]);
        assert.equal(fs.readFileSync(marker, "utf8"), "prepared evidence\n");
        assert.equal(fs.readFileSync(lock, "utf8"), "lock evidence\n");
      } finally {
        for (const fd of fds) fs.closeSync(fd);
        removeTempFixture(root, { recursive: true, force: true });
      }
    });
}

// 失敗条件: commit 前に ready を出す、FD 3 と barrier が異なる、ready FD を保持しない。
// bootstrap から sentinel への FD 継承と Linux 固有の proc・socket の挙動は検証しない。
test("simulated Mac direct sentinel commits and holds its barrier and ready descriptors",
  { skip: process.platform !== "darwin", timeout: 15000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sentinel-direct-"));
    const barrier = path.join(root, "state.lock");
    const generation = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const nonce = "0123456789abcdef0123456789abcdef";
    let barrierFd, child, closed;
    try {
      fs.mkdirSync(barrier, { mode: 0o700 });
      fs.mkdirSync(path.join(root, "other-barrier"), { mode: 0o700 });
      barrierFd = fs.openSync(barrier, "r");
      const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
      const expectedBarrier = identity(fs.fstatSync(barrierFd, { bigint: true }));
      child = spawn(process.execPath, ["--import", directPreload, sentinel, "sentinel", barrier, generation, nonce], {
        env: { ...process.env, GROK_TEST_SENTINEL_BARRIER: barrier },
        stdio: ["pipe", "pipe", "pipe", barrierFd, "ipc"]
      });
      let output = "", stderr = "", isClosed = false;
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => {});
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", () => {});
      closed = new Promise(resolve => child.once("close", (code, signal) => { isClosed = true; resolve({ code, signal }); }));

      const waitForLine = line => new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); child.stdout.off("data", check); child.off("close", onClose); };
        const check = () => {
          if (output.split("\n").includes(line)) { cleanup(); resolve(); }
        };
        const onClose = () => { cleanup(); reject(new Error(`sentinel closed before ${line}: ${stderr}`)); };
        child.stdout.on("data", check); child.once("close", onClose);
        timer = setTimeout(() => { cleanup(); reject(new Error(`sentinel did not report ${line}: ${stderr}`)); }, 3000);
        if (isClosed) onClose(); else check();
      });
      let nextRequest = 0;
      const inspect = (ready, verify) => new Promise((resolve, reject) => {
        const request = ++nextRequest;
        let timer;
        const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("close", onClose); };
        const onClose = () => { cleanup(); reject(new Error(`sentinel closed during inspection: ${stderr}`)); };
        const onMessage = message => {
          if (message?.type !== "inspection" || message.request !== request) return;
          cleanup();
          if (message.error) reject(new Error(message.error)); else resolve(message);
        };
        child.on("message", onMessage); child.once("close", onClose);
        timer = setTimeout(() => { cleanup(); reject(new Error("sentinel inspection timed out")); }, 3000);
        if (isClosed) return onClose();
        child.send({ type: "inspect", request, ready, verify }, error => { if (error) { cleanup(); reject(error); } });
      });

      await waitForLine("started");
      assert.deepEqual((await inspect(false)).barrier, expectedBarrier);
      assert.equal(fs.existsSync(path.join(barrier, "sentinel-ready.json")), false);
      assert.equal(output.split("\n").includes("ready"), false);
      const ready = waitForLine("ready");
      child.stdin.write(`commit:${nonce}`);
      await ready;
      const inspected = await inspect(true);
      assert.deepEqual(inspected.barrier, expectedBarrier);
      const readyPath = path.join(barrier, "sentinel-ready.json");
      assert.deepEqual({ dev: inspected.ready.dev, ino: inspected.ready.ino }, identity(fs.statSync(readyPath, { bigint: true })));
      const readyData = JSON.parse(inspected.ready.content);
      assert.deepEqual(readyData, { generation, nonce, pid: child.pid, startTick: "123456" });
      assert.deepEqual(JSON.parse(fs.readFileSync(readyPath, "utf8")), readyData);

      // ここで /proc の namespace、cmdline、fdinfo と mount ID は fixture 値。
      // FD の identity は子自身の fstat、または実在する別ファイルの stat を使う。
      const cases = [
        [{}, true],
        [{ legacy: true }, true],
        [{ alias: true }, true],
        [{ legacy: true, alias: true }, false, /ENOENT/],
        [{ legacy: true, fd3: "absent" }, true],
        [{ fd3: "absent" }, false, /fixture fd 3 absent/],
        [{ fd3: "file" }, false, /held barrier identity/],
        [{ fd3: "other" }, false, /held barrier identity/],
        [{ invalidFd: true }, false, /invalid sentinel barrier descriptor marker/]
      ];
      for (const [scenario, expected, reason] of cases) {
        const result = (await inspect(true, scenario)).verification;
        assert.equal(result.ok, expected, JSON.stringify(scenario));
        if (reason) assert.match(result.reason, reason, JSON.stringify(scenario));
      }
      fs.chmodSync(barrier, 0o755);
      try {
        const result = (await inspect(true, {})).verification;
        assert.equal(result.ok, false);
        assert.match(result.reason, /state identity is invalid/);
      } finally { fs.chmodSync(barrier, 0o700); }
    } finally {
      if (child && closed) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
      if (barrierFd !== undefined) fs.closeSync(barrierFd);
      removeTempFixture(root, { recursive: true, force: true });
    }
  });
