import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const acp = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
const direct = acp.slice(acp.indexOf("class SpawnedAcpClient"), acp.indexOf("class BrokerAcpClient"));

test("close timeout releases references without claiming the child stopped", async () => {
  let unrefs = 0;
  let destroys = 0;
  const context = vm.createContext({ process: { platform: "linux" }, setTimeout: () => ({ unref() {} }),
    CLOSE_TIMEOUT_MS: 1000,
    waitForExitWithTimeout: async () => {},
    AcpClientBase: class { constructor() { this.framer = { close() {} }; } } });
  vm.runInContext(direct + ";globalThis.Direct = SpawnedAcpClient;", context);
  const client = new context.Direct("mock", {});
  const stream = () => ({ end() {}, destroy() { destroys += 1; } });
  client.proc = { killed: false, exitCode: null, signalCode: null, stdin: stream(), stdout: stream(), stderr: stream(), unref() { unrefs += 1; } };
  await client.close();
  assert.equal(unrefs, 1);
  assert.equal(destroys, 3);
  assert.equal(client.closeStopUnconfirmed, true);
});

test("a completed handler preserves direct cleanup uncertainty in its result", async () => {
  const context = vm.createContext({ process: { env: {} }, brokerRequests: new WeakMap(), GrokAcpClient: { connect: async () => ({
    transport: "direct", closeStopUnconfirmed: false, async close() { this.closeStopUnconfirmed = true; }
  }) } });
  vm.runInContext(grok.slice(grok.indexOf("async function withGrok"), grok.indexOf("async function withDirectGrok")), context);
  const result = await context.withGrok("mock", async () => ({ status: "completed", turnStopUnconfirmed: false }));
  assert.equal(result.turnStopUnconfirmed, true);
});

test("an EOF-ignoring child exits naturally while the closed parent returns promptly", () => {
  // 子は1.6秒後に自然終了する。kill、実ファイル作成・削除は行わない。
  const script = `
    const vm = require('node:vm');
    const { spawn } = require('node:child_process');
    const context = vm.createContext({ process: { platform: 'linux', env: {} },
      spawn: () => {
        const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setTimeout(() => {}, 1600);'], { stdio: ['pipe', 'pipe', 'pipe'] });
        // 旧close方式へ戻しても実killを起こさず、子の自然終了だけを待つ。
        child.kill = () => false;
        return child;
      },
      setTimeout, CLOSE_TIMEOUT_MS: 1000, DIRECT_HANDSHAKE_TIMEOUT_MS: 10, withTimeout: promise => promise,
      waitForExitWithTimeout: () => new Promise(resolve => setTimeout(resolve, 40)),
      AcpClientBase: class { constructor(cwd, options) { this.cwd=cwd; this.options=options; this.stderr=''; this.framer={close(){}}; } async performInitialize(){} handleExit(){} }
    });
    vm.runInContext(${JSON.stringify(direct)} + ';globalThis.Direct=SpawnedAcpClient;', context);
    (async () => { const client=new context.Direct(process.cwd(), {}); await client.initialize(); await client.close(); process.stdout.write(JSON.stringify({ pending:client.closeStopUnconfirmed })); })();
  `;
  const started = Date.now();
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 1100, `Parent remained alive for ${elapsed}ms`);
  assert.equal(JSON.parse(result.stdout).pending, true);
});
