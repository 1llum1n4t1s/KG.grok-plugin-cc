import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("failed direct ACP initialization closes the spawned agent", async () => {
  const fake = installFakeGrok({ initializeError: "fixture initialization failed" });
  let pid;
  try {
    await assert.rejects(
      GrokAcpClient.connect(makeTempDir("grok-acp-failed-init-"), {
        disableBroker: true,
        grokBin: fake.env.GROK_BIN,
        env: fake.env
      }),
      /fixture initialization failed/
    );
    pid = fake.readState()?.pid;
    assert.ok(Number.isInteger(pid), "the fake agent must have started");
    for (let attempt = 0; attempt < 40 && processExists(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processExists(pid), false, "the rejected handshake must not leave an agent running");
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGTERM");
  }
});
