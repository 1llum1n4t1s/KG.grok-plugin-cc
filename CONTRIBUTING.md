# Development / 開発

## English


For development, use Bun 1.4.4 or later for package scripts and the pnpm version pinned in `packageManager` for the committed lockfile. Node compatibility CI uses the version pinned under `volta.node`. The distributed plugin supports Bun 1.4.4 or later and Node.js 22 or later on Windows, macOS, and Linux; Bun is preferred when both are available.

The `.mts` files in `plugins/grok/scripts/`, `scripts/`, and `tests/` are the TypeScript sources. Edit these files, then run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check-generated
pnpm test
pnpm check-version
```

After installing dependencies with the pinned pnpm and `pnpm-lock.yaml`, package scripts use Bun with environment-file loading and automatic installation disabled. Use `bun --no-env-file --no-install --bun run build` for the TypeScript build. Missing dependencies fail without installation. Node compatibility CI invokes the corresponding `.mjs` scripts explicitly with Node.

`build` type-checks all TypeScript sources and emits adjacent `.mjs` files. Commit both sources and generated JavaScript. Keep `.mjs` extensions in imports and host commands: the distributed plugin runs directly on Bun or Node.js without a compiler. Prefer Rust first, Bun (TypeScript / JavaScript) second, and C# third for implementations. Languages needed for compatibility with existing products, frameworks, or SDKs may be used for that purpose only. PowerShell (including 7) and Windows batch implementations remain prohibited, including existing implementations. Bash is permitted. Preserve the existing Node.js runtime compatibility and limit migrations to the requested scope.

The Windows helper source of truth is `plugins/grok/native/` and its checked-in `Cargo.lock`. It implements `supervisor`, `identity`, and `git-snapshot`; the plugin includes `plugins/grok/bin/win32-{ia32,x64,arm64}/grok-windows-helper.exe`. Users need Bun 1.4.4 or later or Node.js 22 or later, plus Git: there is no runtime Rust build or download.

To update these binaries, use Windows with Visual Studio **18.11.12328.437**, default VC toolset **14.51.36231** (observed linker file version **14.51.36260.0**), Windows SDK **10.0.26100.0**, and Rust **1.97.1** (`rust-toolchain.toml`). Install the matching Visual Studio C++ x86/x64 and ARM64 tools and SDK through the Visual Studio installer. The script locates Visual Studio using `vswhere`, requires the exact Visual Studio and default VC toolset versions, and explicitly selects that SDK and each target's linker/libraries without invoking `vcvars`, PowerShell, or batch files. Missing tools or version differences fail the build rather than silently selecting another environment. Install the three Rust targets explicitly in your development environment, then regenerate and verify all distribution binaries with:

```sh
rustup toolchain install 1.97.1 --profile minimal --target i686-pc-windows-msvc,x86_64-pc-windows-msvc,aarch64-pc-windows-msvc
pnpm build
pnpm build:native
pnpm check:native
pnpm test
```

The scripts never invoke rustup or its proxies. After the developer explicitly installs Rust, they select existing cargo.exe and rustc.exe under RUSTUP_HOME/toolchains/1.97.1-<host>-pc-windows-msvc/bin (RUSTUP_HOME defaults to ~/.rustup), pin RUSTC to that compiler, and require the host and requested targets' lib/rustlib/<target>/lib directories to exist. No toolchain or target is downloaded; missing installations fail before Cargo runs. Windows host detection uses PROCESSOR_ARCHITEW6432, then PROCESSOR_ARCHITECTURE, then os.machine(); an unknown host fails. Compatible installed hosts are tried in order: ARM64 uses aarch64, x86_64, i686; x64 uses x86_64, i686; x86 uses i686. The test launcher builds for the selected host. CARGO is accepted only as an absolute path whose canonical file matches the selected toolchain's cargo.exe; proxy/PATH overrides are rejected without execution. RUSTUP does not select an executable for these scripts. Run the installation command above explicitly when needed. Direct rustup or rustup-managed cargo commands retain normal rustup behavior, including automatic installation where rustup permits it. Windows CI explicitly installs all three targets before verification.

`build:native` uses `cargo build --locked --release`, static CRT, MSVC `/Brepro`, and source path remapping for all three targets. It captures executable paths from Cargo JSON and copies only the helper into the distribution. `CARGO` may select only the installed pinned toolchain's real cargo.exe, as described above. Distribution builds use fixed canonical Rust flags and ignore inherited `RUSTFLAGS` and `CARGO_ENCODED_RUSTFLAGS`; linker, library, include, and SDK environment variables are set to the pinned toolsets. The script does not install tools. Build output defaults to the ignored `plugins/grok/native/target/` directory. An absolute `CARGO_TARGET_DIR` selects another output root; normal and verification builds use its `distribution/` and `check-native/` subdirectories, both remapped to the same virtual source prefix.

`check:native` builds separately and requires SHA-256 equality with every checked-in executable without overwriting them. Windows CI uses `windows-2025-vs2026` and runs this check before testing the checked-in binaries. The runner image may receive updates: a toolset version change intentionally fails the check and requires reviewing the pinned toolchain and regenerating all three binaries in the matching environment. Do not bypass mismatches or run `build:native` in CI to hide stale distribution files. Keep the binaries checked in with their source changes.

`check-generated` compiles into the ignored `plugins/grok/.generated/check/` build directory and compares the output with the checked-in JavaScript, allowing Git line-ending conversion. CI runs this check **before** building to catch stale or missing distribution files. It also rejects `.mjs` files without a corresponding `.mts` source. The check directory is reusable build output, not part of the distribution runtime.

Tests use the `node:test` API and fake Grok processes, with Bun as the default runner and actual Node in compatibility CI; they do not require a real Grok account. Some E2E tests require POSIX and are skipped on Windows: process lifecycle and spawn failure, the foreground bridge, foreground language handling, and setup guidance. Run those tests on Linux or macOS before treating that coverage as verified.

CI runs the full suite, build, generated-file check, and the independent version check on Linux with the pinned development Node.js. It invokes `node scripts/check-generated.mjs`, `node scripts/run-tests.mjs`, and `node scripts/bump-version.mjs --check` explicitly. An additional job runs committed foreground and runtime smoke tests on Node.js 22.0.0. Windows CI also uses `node scripts/build-windows-helper.mjs --check` and the Node test runner to build the native test shim, run Rust unit tests, and exercise process ownership, shutdown, and Git snapshot boundaries. The runner passes the shim as `GROK_TEST_SHIM`; `GROK_GIT_NATIVE_FIXTURE_ROOT` points under runner temp. Keep the live repository version check separate from version fixture tests.

For local Windows validation where Prunlet must manage deletion, use a dedicated `TEMP`/`TMP` directory and set both `GROK_TEST_DEFER_CLEANUP=1` and `GROK_BUMP_TEST_DEFER_CLEANUP=1`. The first defers shared fixture and workspace-link cleanup; the second defers version-script fixture cleanup. Fixtures remain in that dedicated temporary directory until the parent agent cleans them with Prunlet after the test processes exit and process termination is confirmed. Cleanup is deferred, not omitted. Normal CI runs leave these variables unset and retain the usual fixture cleanup.

## 日本語

開発用package scriptはBun 1.4.4以降を使い、lockfile管理は `packageManager` で固定したpnpmを使います。Node互換CIは `volta.node` の固定版を使います。配布プラグインは Windows・macOS・Linux で Bun 1.4.4 以降と Node.js 22 以降に対応し、両方ある場合は Bun を優先します。

固定pnpmと `pnpm-lock.yaml` で依存導入後、package scriptは環境ファイル読込みと自動導入を無効にしたBunで動きます。TypeScriptビルドは `bun --no-env-file --no-install --bun run build` を使います。依存が不足している場合は導入せず失敗します。Node互換CIは対応する `.mjs` をNodeで明示実行します。

`plugins/grok/scripts/`、`scripts/`、`tests/` の `.mts` が TypeScript の正本です。編集後は上記のコマンドを実行し、ソースと生成された `.mjs` を一緒にコミットします。import とホストの起動コマンドは `.mjs` のまま維持します。利用者はコンパイラなしで Bun または Node.js から直接実行できます。実装は Rust を第一候補、Bun（TypeScript / JavaScript）を第二候補、C# を第三候補とします。既存製品・フレームワーク・SDK との互換性に必要な言語は、その用途に限って使用できます。PowerShell（7 を含む）・Windows バッチは既存分を含め実装に使用せず、Bash は使用できます。既存 Node.js ランタイムの互換性を保ち、移行は依頼範囲に限定します。

Windows helper の正本は `plugins/grok/native/` と Git 管理する `Cargo.lock` です。`supervisor`、`identity`、`git-snapshot` を実装し、`plugins/grok/bin/win32-{ia32,x64,arm64}/grok-windows-helper.exe` を同梱します。利用者に必要なのは Bun 1.4.4 以降または Node.js 22 以降と Git で、実行時の Rust ビルドやダウンロードはありません。

バイナリ更新には Windows、Visual Studio **18.11.12328.437**、既定 VC toolset **14.51.36231**（実測 linker ファイル版 **14.51.36260.0**）、Windows SDK **10.0.26100.0**、`rust-toolchain.toml` で固定する Rust **1.97.1** を使用します。Visual Studio Installer で対応する C++ x86/x64・ARM64 ツールと SDK を導入してください。スクリプトは `vswhere` で VS を検出し、本体と既定 VC toolset の完全一致を確認して各ターゲットの linker・ライブラリと SDK を明示選択します。`vcvars`、PowerShell、バッチは呼びません。ツール不足・版の相違は明示的な失敗となります。開発環境へ3ターゲットを明示導入し、上記のコマンドで全配布バイナリを再生成・照合してください。

スクリプトは rustup やその proxy を一切起動しません。開発者が上記の rustup toolchain install コマンドで明示導入した後、RUSTUP_HOME/toolchains/1.97.1-<host>-pc-windows-msvc/bin の既存 cargo.exe と rustc.exe を直接実行し、RUSTC を同じ compiler に固定します。RUSTUP_HOME の既定は ~/.rustup です。ホストと要求ターゲットの lib/rustlib/<target>/lib が存在することを確認し、不足時は Cargo 実行前に失敗します。自動導入・ダウンロードは行いません。Windows ホストは PROCESSOR_ARCHITEW6432、PROCESSOR_ARCHITECTURE、os.machine() の順で判定し、判定不能なら停止します。互換ホスト候補は ARM64 で aarch64・x86_64・i686、x64 で x86_64・i686、x86 で i686 の順です。テストは選定したホスト向けにビルドします。CARGO は選定 toolchain の cargo.exe と正規化後の実体パスが一致する絶対パスだけを受け付け、proxy・PATH 指定は起動せず拒否します。RUSTUP による実行ファイル指定は使用しません。rustup または rustup 管理下の cargo を直接実行した場合は、rustup が許す自動導入を含め通常の挙動に従います。Windows CI は検証前に3ターゲットを明示導入します。

`build:native` は `cargo build --locked --release`、static CRT、MSVC `/Brepro`、ソースパスの置換を使用し、Cargo JSON から得た executable のうち配布 helper のみコピーします。`CARGO` は前述の固定 toolchain の cargo.exe 実体だけを指定できます。配布生成の Rust flags は固定し、継承した `RUSTFLAGS` / `CARGO_ENCODED_RUSTFLAGS` は使用しません。linker・ライブラリ・include・SDK の環境変数も固定ツールセットにそろえます。スクリプト自身はツールを導入しません。ビルド出力の既定は Git 除外した `plugins/grok/native/target/` 内です。絶対パスの `CARGO_TARGET_DIR` で出力ルートを変更でき、通常生成は `distribution/`、照合生成は `check-native/` に分け、どちらも同じ仮想パスへ置換します。

`check:native` は別領域へビルドし、Git 管理する3つの executable と SHA-256 の完全一致を要求します。配布物は上書きしません。Windows CI は `windows-2025-vs2026` を指定し、同梱バイナリの動作テスト前にこの照合を必須実行します。runner image は更新されるため、ツールセットが変われば意図的に失敗します。その際は固定版を見直し、一致した環境で3バイナリを再生成してください。不一致の無視や CI での `build:native` による上書きは行わず、ソースとバイナリを一緒に管理します。

`build` は全 TypeScript の型検査と隣接する `.mjs` の生成を行います。`check-generated` は Git 除外済みの `plugins/grok/.generated/check/` へ生成し、コミット対象の JavaScript と比較します。Git による改行変換は許容します。CI ではビルド前に照合し、生成物の更新漏れ・欠落と、対応する `.mts` がない `.mjs` を検出します。照合ディレクトリは再利用できるビルド出力であり、配布ランタイムからは参照しません。

テストは `node:test` APIとfake Grokを使い、既定はBun、互換CIは実際のNodeで実行します。実アカウントは必要ありません。POSIX専用のE2E（プロセス終了・起動失敗、前景ブリッジ、前景の言語処理、setup案内）はWindowsでスキップされるため、検証済みとするにはLinuxまたはmacOSでも実行してください。

CIは固定Node.jsのLinuxで全テスト・ビルド・生成物照合・独立した実リポジトリのversion検証を行います。`node scripts/check-generated.mjs`、`node scripts/run-tests.mjs`、`node scripts/bump-version.mjs --check` を明示実行し、追加ジョブはNode.js 22.0.0で前景接続とランタイムのsmoke testを行います。Windowsも `node scripts/build-windows-helper.mjs --check` とNodeのtest runnerを使い、native shim・Rust単体テスト・プロセス所有・終了・Git snapshot境界を検証します。shimは `GROK_TEST_SHIM`、隔離領域はrunner temp内の `GROK_GIT_NATIVE_FIXTURE_ROOT` で渡します。実リポジトリのversion検証はversion fixtureテストと独立して維持します。

Prunlet による削除管理が必要な Windows ローカル検証では、専用の `TEMP` / `TMP` を用意し、`GROK_TEST_DEFER_CLEANUP=1` と `GROK_BUMP_TEST_DEFER_CLEANUP=1` の両方を設定します。前者は共通 fixture と workspace リンク、後者はバージョンスクリプトの fixture の清掃を保留します。fixture を専用の一時領域内に保持し、テストプロセス終了と関連プロセスの終了を確認してから、親エージェントが Prunlet で清掃します。清掃を省略するのではなく、後へ保留する指定です。通常の CI はこれらを未設定とし、従来どおり fixture を清掃します。
