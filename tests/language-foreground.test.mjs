import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, removeTempFixture } from "./helpers.mjs";
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
test("foreground audit preserves invalid review text without exposing a partial result", { skip: process.platform === "win32" }, (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-invalid-review-work-"));
    const partial = JSON.stringify({ verdict: "approve", summary: "Partial review" });
    const fake = installFakeGrok({ replies: [{ text: partial, stopReason: "cancelled" }] });
    let stopped = false;
    const confirmStopped = (response) => {
        assert.equal(response.error, undefined);
        assert.equal(response.signal, null);
        assert.doesNotMatch(response.stderr, /stop could not be confirmed|終了を確認でき/);
        const pid = fake.readState()?.pid;
        assert.ok(Number.isInteger(pid) && pid > 0, "fake agent PID must be known");
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    };
    try {
        initGitRepo(workspace);
        const invoke = (args) => spawnSync(process.execPath, [cli, "audit", ...args], { cwd: workspace, env: fake.env, encoding: "utf8", timeout: 15000 });
        const text = invoke([]);
        assert.equal(text.status, 1);
        assert.match(text.stdout, /Review incomplete/);
        assert.ok(text.stdout.includes(partial));
        confirmStopped(text);
        const raw = JSON.stringify({ verdict: "approve", summary: "Reviewed", findings: "invalid", next_steps: [] });
        fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ text: raw }] }));
        const result = invoke(["--json"]);
        assert.equal(result.status, 1);
        const invalidPayload = JSON.parse(result.stdout);
        assert.equal(invalidPayload.result, null);
        assert.equal(invalidPayload.reviewText, raw);
        assert.ok(invalidPayload.parseError);
        assert.equal(invalidPayload.turnStopUnconfirmed, false);
        confirmStopped(result);
        stopped = true;
    }
    finally {
        if (stopped) {
            try {
                removeTempFixture(workspace, { recursive: true, force: true });
                removeTempFixture(fake.binDir, { recursive: true, force: true });
            }
            catch (error) {
                t.diagnostic(`Fixture retained: ${workspace}; ${fake.binDir}: ${error.message}`);
                throw error;
            }
        }
        else {
            t.diagnostic(`Fixture retained because CLI shutdown was not confirmed: ${workspace}; ${fake.binDir}`);
        }
    }
});
