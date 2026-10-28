import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

const sentinel = fileURLToPath(new URL("../plugins/grok/scripts/lib/linux-state-sentinel.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/linux-sentinel-fdinfo-preload.mjs", import.meta.url));

// 故障条件: 明示的な root lock FD が欠落・別 inode/mount・不正引数でも
// marker を変更する、または sentinel を spawn する。Mac 上の fdinfo は模擬値。
for (const variant of ["missing", "different-root", "different-mount", "named-mount", "invalid-option"]) {
  test(`Linux bootstrap rejects ${variant} inherited root lock before writing`, {
    skip: process.platform !== "darwin", timeout: 30000
  }, async t => {
    const root = fs.realpathSync(makeTempDir("grok-linux-sentinel-root-fd-")), barrier = path.join(root, "state.lock");
    const marker = path.join(barrier, "prepared.json"), lock = path.join(barrier, "native.lock"), other = path.join(root, "other-root");
    fs.mkdirSync(barrier, { mode: 0o700 }); fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(marker, "prepared evidence\n", { mode: 0o600, flag: "wx" });
    fs.writeFileSync(lock, "lock evidence\n", { mode: 0o600, flag: "wx" });
    const fds = [];
    for (const [name, flags] of [[lock, "r"], [marker, "r+"], [barrier, "r"], [root, "r"]]) fds.push(fs.openSync(name, flags));
    if (variant === "different-root") fds.push(fs.openSync(other, "r"));
    if (variant === "different-mount" || variant === "named-mount") fds.push(fs.openSync(root, "r"));
    let child, closed, verifiedDone = false;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (closed) await closed;
      for (const fd of fds) fs.closeSync(fd);
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained sentinel root FD fixture: ${root}`);
    });
    const stat = fs.fstatSync(fds[3], { bigint: true });
    const payload = Buffer.from(JSON.stringify({ directoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
      sentinel: { generation: "11111111-1111-4111-8111-111111111111", nonce: "0123456789abcdef0123456789abcdef" } })).toString("base64url");
    const option = variant === "invalid-option" ? "--history-root-lock-fd=8" : "--history-root-lock-fd=7";
    const scenario = variant === "different-mount" ? { fd: 7, fault: "different" }
      : variant === "named-mount" ? { fd: -1, fault: "different", namedRootPath: root }
        : { fd: -1, fault: "none" };
    child = spawn(process.execPath, ["--import", preload, sentinel, "bootstrap", root, barrier, marker, payload, option], {
      env: { ...process.env, GROK_TEST_SENTINEL_FDINFO: JSON.stringify(scenario) }, stdio: ["ignore", "pipe", "pipe", ...fds]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const result = await closed;
    assert.notEqual(result.code, 0, "unverified root FD must fail");
    assert.equal(result.signal, null); assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /fixture-unexpected-spawn/, "sentinel must not start");
    if (variant === "different-mount") assert.match(stderr, /^fixture-fd:7:/m);
    if (variant === "named-mount") assert.match(stderr, /^fixture-named-root-open:\d+$/m);
    assert.equal(fs.readFileSync(marker, "utf8"), "prepared evidence\n");
    assert.equal(fs.readFileSync(lock, "utf8"), "lock evidence\n");
    assert.deepEqual(fs.readdirSync(barrier).sort(), ["native.lock", "prepared.json"]);
    verifiedDone = true;
  });
}
