#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedRustToolchain, directRustEnvironment, rustToolchainVersion } from "./rust-toolchain-paths.mjs";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeRoot = path.join(root, "plugins/grok/native");
const targets = [
    ["ia32", "i686-pc-windows-msvc"],
    ["x64", "x86_64-pc-windows-msvc"],
    ["arm64", "aarch64-pc-windows-msvc"],
];
const toolchain = rustToolchainVersion;
const visualStudioVersion = "18.11.12328.437";
const vcToolsVersion = "14.51.36231";
const sdkVersion = "10.0.26100.0";
function pinnedWindowsTools() {
    const programFiles = process.env["ProgramFiles(x86)"];
    if (!programFiles)
        throw new Error("ProgramFiles(x86) is required to locate the pinned Windows build tools.");
    const vswhere = path.join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
    const result = spawnSync(vswhere, ["-all", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json", "-utf8"], {
        encoding: "utf8", windowsHide: true, shell: false,
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(`vswhere failed: ${result.stderr}`);
    const installations = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    const installation = installations.find((item) => item.installationVersion === visualStudioVersion);
    if (!installation)
        throw new Error(`Visual Studio ${visualStudioVersion} is required; found ${installations.map((item) => item.installationVersion).join(", ") || "none"}.`);
    const versionFile = path.join(installation.installationPath, "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt");
    const actualVcVersion = fs.readFileSync(versionFile, "utf8").trim();
    if (actualVcVersion !== vcToolsVersion)
        throw new Error(`Default VC toolset ${vcToolsVersion} is required; found ${actualVcVersion}.`);
    const sdk = path.join(programFiles, "Windows Kits/10");
    for (const directory of [path.join(sdk, "Lib", sdkVersion), path.join(sdk, "Include", sdkVersion)]) {
        if (!fs.existsSync(directory))
            throw new Error(`Windows SDK ${sdkVersion} is required: ${directory}`);
    }
    console.log(`Canonical native toolchain: Rust ${toolchain}, VS ${visualStudioVersion}, VC ${vcToolsVersion}, SDK ${sdkVersion}`);
    return { visualStudio: installation.installationPath, vc: path.join(installation.installationPath, "VC/Tools/MSVC", vcToolsVersion), sdk };
}
function hash(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function main() {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check") || args.length > 1)
        throw new Error("Usage: build-windows-helper.mjs [--check]");
    if (process.platform !== "win32")
        throw new Error("Build on Windows with the MSVC C++ toolchain and Windows SDK installed.");
    const check = args.includes("--check");
    const tools = pinnedWindowsTools();
    // 通常ビルドのキャッシュと照合用出力を分け、配布物は全ターゲット成功後だけ更新する。
    if (process.env.CARGO_TARGET_DIR && !path.isAbsolute(process.env.CARGO_TARGET_DIR)) {
        throw new Error("CARGO_TARGET_DIR must be an absolute path.");
    }
    const targetRoot = process.env.CARGO_TARGET_DIR || path.join(nativeRoot, "target");
    const targetDir = path.join(targetRoot, check ? "check-native" : "distribution");
    const { cargo, rustc } = installedRustToolchain(targets.map(([, target]) => target));
    const rustEnv = directRustEnvironment(rustc);
    const rustcVersion = spawnSync(rustc, ["--version"], { encoding: "utf8", windowsHide: true, shell: false });
    if (rustcVersion.error)
        throw rustcVersion.error;
    if (rustcVersion.status !== 0 || rustcVersion.stdout.trim().split(/\s+/)[1] !== toolchain) {
        throw new Error(`Rust ${toolchain} is required; found ${rustcVersion.stdout.trim() || rustcVersion.stderr.trim()}.`);
    }
    // 配布物は固定 flags で生成し、呼出し元の RUSTFLAGS を混入させない。
    const flags = ["-C", "target-feature=+crt-static", "-C", "link-arg=/Brepro",
        `--remap-path-prefix=${root}=/grok-plugin`,
        `--remap-path-prefix=${tools.visualStudio}=/visual-studio`,
        `--remap-path-prefix=${tools.sdk}=/windows-sdk`];
    const cargoHome = process.env.CARGO_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cargo") : undefined);
    if (cargoHome)
        flags.push(`--remap-path-prefix=${path.resolve(cargoHome)}=/cargo-home`);
    // 通常生成と照合生成で出力先が異なっても、埋込みパスは同じ仮想ルートにする。
    flags.push(`--remap-path-prefix=${targetDir}=/grok-native-target`);
    const artifacts = [];
    for (const [arch, target] of targets) {
        const msvcArch = arch === "ia32" ? "x86" : arch;
        const hostTools = path.join(tools.vc, "bin/Hostx64", msvcArch);
        const linker = path.join(hostTools, "link.exe");
        const libDirectories = [path.join(tools.vc, "lib", msvcArch),
            path.join(tools.sdk, "Lib", sdkVersion, "ucrt", msvcArch), path.join(tools.sdk, "Lib", sdkVersion, "um", msvcArch)];
        for (const item of [linker, ...libDirectories]) {
            if (!fs.existsSync(item))
                throw new Error(`Pinned native build tool or library is missing: ${item}`);
        }
        const env = { ...rustEnv };
        // Windows の環境変数名は大文字小文字を区別しない。重複する別表記も除く。
        const replaced = new Set(["rustflags", "cargo_encoded_rustflags", "rustc", "rustc_wrapper", "rustc_workspace_wrapper",
            "cargo_build_rustc", "cargo_build_rustc_wrapper", "cargo_build_rustc_workspace_wrapper",
            ...targets.map(([, triple]) => `cargo_target_${triple.replaceAll("-", "_")}_linker`),
            "path", "lib", "libpath", "include", "windowssdkdir", "windowssdkversion", "vcinstalldir", "vctoolsinstalldir", "vsinstalldir"]);
        for (const key of Object.keys(env))
            if (replaced.has(key.toLowerCase()))
                delete env[key];
        Object.assign(env, {
            CARGO_ENCODED_RUSTFLAGS: [...flags, "-C", `linker=${linker}`].join("\x1f"),
            RUSTC: rustc,
            RUSTC_WRAPPER: "",
            RUSTC_WORKSPACE_WRAPPER: "",
            WindowsSdkDir: tools.sdk + path.sep,
            WindowsSDKVersion: sdkVersion + path.sep,
            VCToolsInstallDir: tools.vc + path.sep,
            VCINSTALLDIR: path.join(tools.visualStudio, "VC") + path.sep,
            VSINSTALLDIR: tools.visualStudio + path.sep,
            LIB: libDirectories.join(path.delimiter),
            INCLUDE: [path.join(tools.vc, "include"), ...["ucrt", "shared", "um", "winrt"].map((name) => path.join(tools.sdk, "Include", sdkVersion, name))].join(path.delimiter),
            PATH: [hostTools, path.join(tools.sdk, "bin", sdkVersion, "x64"), process.env.PATH || ""].join(path.delimiter),
        });
        const result = spawnSync(cargo, ["build", "--locked", "--release", "--bin", "grok-windows-helper",
            "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--target", target,
            "--target-dir", targetDir, "--message-format=json-render-diagnostics"], {
            cwd: root,
            env,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
            shell: false,
        });
        if (result.stderr)
            process.stderr.write(result.stderr);
        if (result.error)
            throw result.error;
        let executable;
        for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
            const message = JSON.parse(line);
            if (message.reason === "compiler-message" && message.message?.rendered) {
                process.stderr.write(message.message.rendered);
            }
            if (message.reason === "compiler-artifact" && message.target?.name === "grok-windows-helper" && message.executable) {
                executable = path.resolve(message.executable);
            }
        }
        if (result.status !== 0)
            throw new Error(`Native build failed for ${target} (exit ${result.status}).`);
        if (!executable || !fs.statSync(executable).isFile())
            throw new Error(`Cargo did not emit grok-windows-helper for ${target}.`);
        artifacts.push({ source: executable, destination: path.join(root, "plugins/grok/bin", `win32-${arch}`, "grok-windows-helper.exe") });
    }
    for (const { source, destination } of artifacts) {
        if (check) {
            if (!fs.existsSync(destination) || hash(source) !== hash(destination))
                throw new Error(`Native distribution differs: ${path.relative(root, destination)}. Rebuild with the matching MSVC/SDK toolset.`);
            console.log(`SHA-256 matches: ${path.relative(root, destination)}`);
        }
        else {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(source, destination);
            console.log(`${path.relative(root, destination)} ${hash(destination)}`);
        }
    }
}
try {
    main();
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
