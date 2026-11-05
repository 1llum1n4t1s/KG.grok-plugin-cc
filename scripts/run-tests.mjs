import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedRustToolchain, directRustEnvironment } from "./rust-toolchain-paths.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = path.join(root, "plugins", "grok", "native", "Cargo.toml");
let activeChild;
// 親への中断をビルド・テストにも伝え、子を残さない。
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => activeChild?.kill(signal));
}
function wait(child) {
    activeChild = child;
    return new Promise((resolve, reject) => {
        child.once("error", (error) => {
            if (activeChild === child)
                activeChild = undefined;
            reject(error);
        });
        child.once("close", (code, signal) => {
            if (activeChild === child)
                activeChild = undefined;
            resolve({ code, signal });
        });
    });
}
function finish(result) {
    if (result.signal) {
        process.removeAllListeners(result.signal);
        process.kill(process.pid, result.signal);
    }
    process.exitCode = result.code ?? 1;
}
async function buildShim() {
    const { cargo, rustc, host } = installedRustToolchain();
    {
        let executable;
        const cargoEnv = { ...directRustEnvironment(rustc), CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(path.dirname(manifest), "target") };
        const child = spawn(cargo, ["build", "--locked", "--target", host, "--manifest-path", manifest,
            "--bin", "grok-test-shim", "--message-format=json-render-diagnostics"], {
            cwd: root,
            env: cargoEnv,
            stdio: ["inherit", "pipe", "inherit"],
            windowsHide: true
        });
        const lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                process.stdout.write(line + "\n");
                return;
            }
            if (message.reason === "compiler-artifact" && message.target?.name === "grok-test-shim" && message.executable) {
                executable = message.executable;
            }
            if (message.reason === "compiler-message" && message.message?.rendered) {
                process.stderr.write(message.message.rendered);
            }
        });
        let result;
        try {
            result = await wait(child);
        }
        catch (error) {
            lines.close();
            throw error;
        }
        if (result.code !== 0 || result.signal) {
            finish(result);
            return;
        }
        if (!executable || !path.isAbsolute(executable) || !fs.statSync(executable).isFile()) {
            throw new Error("Cargo did not report the grok-test-shim executable");
        }
        // 旧シェル fixture の Job 境界検証はネイティブ実装のテストで維持する。
        const nativeTests = await wait(spawn(cargo, ["test", "--locked", "--target", host, "--manifest-path", manifest,
            "--bin", "grok-windows-helper"], {
            cwd: root, env: cargoEnv, stdio: "inherit", windowsHide: true
        }));
        if (nativeTests.code !== 0 || nativeTests.signal) {
            finish(nativeTests);
            return;
        }
        return executable;
    }
}
try {
    const env = { ...process.env };
    if (process.platform === "win32") {
        const shim = await buildShim();
        if (!shim)
            process.exit(process.exitCode ?? 1);
        env.GROK_TEST_SHIM = shim;
    }
    // Windows のシェルに依存せず、従来の tests/*.test.mjs を展開する。
    const tests = fs.readdirSync(path.join(root, "tests"), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".test.mjs"))
        .map(entry => `./tests/${entry.name}`).sort();
    if (!tests.length)
        throw new Error("No tests match tests/*.test.mjs");
    const testArguments = process.versions.bun
        ? ["--no-env-file", "--no-install", "test", "--parallel=4", ...tests]
        : ["--test", "--test-concurrency=4", ...tests];
    finish(await wait(spawn(process.execPath, testArguments, {
        cwd: root, env, stdio: "inherit", windowsHide: true
    })));
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
