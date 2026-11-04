import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const rustToolchainVersion = "1.97.1";
function hostCandidates() {
    const machine = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || os.machine();
    const hosts = {
        arm64: ["aarch64", "x86_64", "i686"], aarch64: ["aarch64", "x86_64", "i686"],
        amd64: ["x86_64", "i686"], x86_64: ["x86_64", "i686"], x64: ["x86_64", "i686"],
        x86: ["i686"], i386: ["i686"], i686: ["i686"], ia32: ["i686"],
    }[machine.toLowerCase()];
    if (!hosts)
        throw new Error("Cannot determine the Windows Rust host architecture; no tool was executed.");
    return hosts.map(host => `${host}-pc-windows-msvc`);
}
/** rustup/proxy を起動せず、導入済み固定 toolchain の実体だけを選ぶ。 */
export function installedRustToolchain(targets = []) {
    if (process.platform !== "win32")
        throw new Error("Windows Rust toolchain selection requires Windows.");
    const home = process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup");
    if (!path.isAbsolute(home))
        throw new Error("RUSTUP_HOME must be an absolute path.");
    const requestedCargo = process.env.CARGO;
    if (requestedCargo && (!path.isAbsolute(requestedCargo) || !fs.existsSync(requestedCargo))) {
        throw new Error("CARGO must name the installed pinned toolchain's cargo.exe directly; remove proxy/PATH overrides.");
    }
    const requestedReal = requestedCargo ? fs.realpathSync(requestedCargo).toLowerCase() : undefined;
    const missing = [];
    for (const host of hostCandidates()) {
        const toolchain = path.join(home, "toolchains", `${rustToolchainVersion}-${host}`);
        const cargo = path.join(toolchain, "bin", "cargo.exe");
        const rustc = path.join(toolchain, "bin", "rustc.exe");
        if (![cargo, rustc].every(file => fs.existsSync(file) && fs.statSync(file).isFile())) {
            missing.push(`${host}: cargo.exe/rustc.exe missing`);
            continue;
        }
        if (requestedReal && requestedReal !== fs.realpathSync(cargo).toLowerCase())
            continue;
        const absent = [...new Set([host, ...targets])].filter(target => {
            const lib = path.join(toolchain, "lib", "rustlib", target, "lib");
            return !fs.existsSync(lib) || !fs.statSync(lib).isDirectory();
        });
        if (absent.length) {
            missing.push(`${host}: standard libraries missing for ${absent.join(", ")}`);
            continue;
        }
        return { cargo: fs.realpathSync(cargo), rustc: fs.realpathSync(rustc), host };
    }
    throw new Error(`Installed Rust ${rustToolchainVersion} with required Windows standard libraries was not found, or CARGO does not match its real cargo.exe. Run rustup toolchain install explicitly and remove proxy overrides. ${missing.join("; ")}`);
}
/** Cargo の compiler/wrapper override 経由でも rustup proxy を呼ばない。 */
export function directRustEnvironment(rustc) {
    const env = { ...process.env };
    const replaced = new Set(["rustc", "rustc_wrapper", "rustc_workspace_wrapper", "cargo_build_rustc",
        "cargo_build_rustc_wrapper", "cargo_build_rustc_workspace_wrapper", "rustup_toolchain", "rustup_auto_install"]);
    for (const key of Object.keys(env))
        if (replaced.has(key.toLowerCase()))
            delete env[key];
    return { ...env, RUSTC: rustc, RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" };
}
