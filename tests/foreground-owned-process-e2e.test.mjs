import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeTempFixture } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/foreground-owned-grok.mjs", import.meta.url));
const windowsFixture = fileURLToPath(new URL("./fixtures/foreground-owned-grok.cmd", import.meta.url));

test("foreground task stops the owned agent descendant before reporting success", { timeout: 20000 }, () => {
  let directory;
  try {
    let bin = windowsFixture;
    if (process.platform !== "win32") {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-foreground-owned-"));
      bin = path.join(directory, "grok");
      fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [cli, "task", "--json", "inspect"], {
      env: { ...process.env, GROK_BIN: bin, XAI_API_KEY: "fixture", GROK_COMPANION_DISABLE_BROKER: "1" },
      encoding: "utf8", timeout: 15000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
    const pid = Number(JSON.parse(result.stdout).finalMessage);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned descendant is still running");
  } finally {
    if (directory) removeTempFixture(directory, { recursive: true, force: true });
  }
});
