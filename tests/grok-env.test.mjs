import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { getGrokAuthStatus, getGrokAvailability, resolveGrokBin, runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
test("injected Grok environment is used for preflight, authentication and model selection", async (t) => {
    const cwd = makeTempDir("grok-env-override-");
    const fake = installFakeGrok({ replies: [{ text: "ok" }] });
    const env = { ...fake.env, GROK_PLUGIN_MODEL: "grok-4.5" };
    const childProcess = createRequire(import.meta.url)("node:child_process");
    const originalSpawn = childProcess.spawn, owned = [];
    const observedSpawn = function (command, args, options) {
        const child = originalSpawn.apply(this, arguments);
        const directArgs = process.versions.bun ? (args?.[0] === "--no-env-file" ? args.slice(1) : null) : args;
        if (process.platform === "linux" && command === process.execPath && directArgs?.length === 4 && directArgs[0]?.endsWith("posix-agent-supervisor.mjs") &&
            directArgs[1] === fake.env.GROK_BIN && directArgs[2] === "agent" && directArgs[3] === "stdio" && options?.env?.FAKE_GROK_STATE === fake.env.FAKE_GROK_STATE) {
            const record = { child, identity: null, closed: false, error: null };
            owned.push(record);
            record.close = new Promise(resolve => child.once("close", (code, signal) => { record.closed = true; resolve({ code, signal }); }));
            child.once("error", error => { record.error = error; });
            try {
                const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
                const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                record.identity = { group: Number(fields[2]), start: fields[19] };
            }
            catch (error) {
                record.error = error;
            }
        }
        return child;
    };
    if (process.platform === "linux") {
        childProcess.spawn = observedSpawn;
        syncBuiltinESMExports();
    }
    const previousBin = process.env.GROK_BIN;
    const previousModel = process.env.GROK_PLUGIN_MODEL;
    process.env.GROK_BIN = "missing-global-grok-binary";
    process.env.GROK_PLUGIN_MODEL = "grok-4.7";
    let authStopped = false, turnStopped = false;
    try {
        assert.equal(getGrokAvailability(cwd, env).available, true);
        const auth = await getGrokAuthStatus(cwd, { env });
        authStopped = auth.turnStopUnconfirmed !== true;
        assert.equal(auth.authenticated, true);
        const result = await runGrokTurn(cwd, { env, prompt: "check injected environment", readOnly: true });
        turnStopped = result.turnStopUnconfirmed !== true;
        assert.equal(result.model, "grok-4.5");
        assert.equal(fake.readState().prompts.length, 1);
    }
    finally {
        try {
            assert.ok(authStopped && turnStopped, "authentication and turn shutdown were not confirmed");
            if (process.platform === "linux") {
                if (childProcess.spawn !== observedSpawn)
                    throw new Error("fixture agent observer was replaced");
                childProcess.spawn = originalSpawn;
                syncBuiltinESMExports();
                assert.equal(owned.length, 2, "both direct agent starts must have owned child handles");
                for (const record of owned) {
                    assert.equal(record.error, null);
                    assert.ok(Number.isInteger(record.child.pid) && record.identity?.start);
                    assert.equal(record.identity.group, record.child.pid);
                    let timer;
                    try {
                        await Promise.race([record.close, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned agent close was not confirmed")), 5000); })]);
                    }
                    finally {
                        clearTimeout(timer);
                    }
                    assert.ok(record.closed);
                    try {
                        process.kill(-record.child.pid, 0);
                        throw new Error("owned agent process group is still present");
                    }
                    catch (error) {
                        if (error.code !== "ESRCH")
                            throw error;
                    }
                }
            }
            removeTempFixture(cwd, { recursive: true, force: true });
            removeTempFixture(fake.binDir, { recursive: true, force: true });
        }
        catch (error) {
            t.diagnostic(`Fixture retained: ${cwd}; ${fake.binDir}: ${error.message}`);
            throw error;
        }
        finally {
            if (process.platform === "linux" && childProcess.spawn === observedSpawn) {
                childProcess.spawn = originalSpawn;
                syncBuiltinESMExports();
            }
            if (previousBin === undefined)
                delete process.env.GROK_BIN;
            else
                process.env.GROK_BIN = previousBin;
            if (previousModel === undefined)
                delete process.env.GROK_PLUGIN_MODEL;
            else
                process.env.GROK_PLUGIN_MODEL = previousModel;
        }
    }
});
// 失敗条件: Windows で素の `grok` を cmd.exe へ渡し、レビュー対象リポジトリ（cwd）内の
// 同名ファイルを PATH 上の本物より先に実行すること。cmd.exe の cwd 優先探索が有効な
// 環境（NoDefaultCurrentDirectoryInExePath を渡さない）で、目印を書くだけの無害な grok.cmd を置いて確認する。
test("Windows resolves a bare grok name from PATH only, never from the reviewed repository", { skip: process.platform !== "win32" }, (t) => {
    const repo = makeTempDir("grok-env-cwd-shadow-");
    const home = makeTempDir("grok-env-home-");
    const pathDir = makeTempDir("grok-env-path-");
    t.after(() => [repo, home, pathDir].forEach((dir) => removeTempFixture(dir, { recursive: true, force: true })));
    const marker = path.join(repo, "shadow-ran.txt");
    fs.writeFileSync(path.join(repo, "grok.cmd"), `@echo off\r\necho shadow> "${marker}"\r\necho grok 0.0.0\r\n`, "utf8");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const base = { SystemRoot: systemRoot, ComSpec: process.env.ComSpec, PATHEXT: ".COM;.EXE;.BAT;.CMD", USERPROFILE: home, GROK_BIN: "grok" };
    // PATH に grok が無ければ、cwd の偽物を起動せずに未導入として返す。
    const missing = getGrokAvailability(repo, { ...base, PATH: path.join(systemRoot, "System32") });
    assert.equal(missing.available, false);
    assert.equal(missing.reason, "not-installed");
    assert.equal(fs.existsSync(marker), false, "the repository grok.cmd must not run");
    // PATH 上にあれば絶対パスへ固定する。環境変数名の大文字小文字（Path）も区別しない。
    const real = path.join(pathDir, "grok.cmd");
    fs.writeFileSync(real, "@echo off\r\necho grok 9.9.9\r\n", "utf8");
    const resolved = resolveGrokBin({ ...base, Path: `${path.join(systemRoot, "System32")};${pathDir}` });
    assert.equal(resolved.toLowerCase(), real.toLowerCase());
    assert.equal(fs.existsSync(marker), false, "the repository grok.cmd must not run");
});
