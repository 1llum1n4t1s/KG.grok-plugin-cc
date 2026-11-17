# リポジトリ作業規約

## 正本と構造

- 利用者向け手順は [README.md](README.md)、構造と不変条件は [DESIGN.md](DESIGN.md) を参照する。DESIGN.md は設計資料として扱う。
- 配布実装は `plugins/grok/`。Claude Code の入口は `commands/` と `agents/`、Claude 専用 helper は `claude-skills/`、Codex の入口は `skills/`、共通実装は `scripts/` に置く。
- コマンドの挙動を変えるときは両ホストの入口、共通ランタイム、関連テストを照合する。CLI の引数や起動手順は `scripts/grok-companion.mjs` の引数処理・ヘルプとも照合し、`tests/commands.test.mjs` と `tests/runtime.test.mjs` の関連ケースを確認する。Codex の実行契約（前景実行、プロンプトファイル、起動失敗時の復旧）は [codex-runtime.md](plugins/grok/references/codex-runtime.md) を参照する。
- marketplace は `.claude-plugin/marketplace.json` と `.agents/plugins/marketplace.json`、配布 manifest は `plugins/grok/.claude-plugin/plugin.json` と `plugins/grok/.codex-plugin/plugin.json` を照合する。
- skill の追加・移動時は、両 manifest の `skills` と `tests/commands.test.mjs` を照合し、Claude 専用 helper を Codex の公開 skill ディレクトリへ混在させない。構成は [DESIGN.md](DESIGN.md#主要コンポーネント) を参照する。

## コマンドと検証

- 開発用package scriptはBun 1.4.4以降を使う。Node互換CIは `package.json` の `volta.node` 指定版で `.mjs` を明示実行する。配布ランタイムは Node.js 22 以降、または Windows・macOS・Linux で Bun 1.4.4 以降にも対応する。両方ある場合は Bun を優先する。依存導入は `packageManager` 指定のpnpmで `pnpm install --frozen-lockfile`。lockfile は `pnpm-lock.yaml`。
- 既存 Node.js / TypeScript は Node.js 22 以降で動作する配布ランタイムとホスト連携の互換性を保つ用途で維持する。PowerShell（7 を含む）・Windows バッチは既存分を含め実装に使用しない。Bash は使用できる。移行は依頼範囲に限り、Windows helper は `plugins/grok/native/` の Rust を正本とする。
- TypeScript の正本は `.mts`。同じ場所の `.mjs` は `pnpm build` で生成し、直接編集しない。以下で参照する `.mjs` の実装・テストを変更するときも対応する `.mts` を編集する。利用者環境でビルドせず実行できるよう生成物も Git 管理する。Windows helper は `plugins/grok/bin/win32-{ia32,x64,arm64}/grok-windows-helper.exe` を Git 管理し、利用者環境でのダウンロード・ビルドは行わない。
- Windows helper 変更時は Rust 1.97.1、VS 18.11.12328.437、既定 VC toolset 14.51.36231、Windows SDK 10.0.26100.0 を用意して `pnpm build:native`、`pnpm check:native`、`cargo test --locked --manifest-path plugins/grok/native/Cargo.toml` と Windows の所有プロセス・Git 境界テストを実行する。配布生成は固定 Rust flags を使用し、VS / VC の版の相違や SDK 不足は失敗する。CI の `windows-2025-vs2026` は同梱 exe を上書きせず SHA-256 の完全一致を必須確認する。再生成手順は CONTRIBUTING.md を参照する。
- 実装変更後は `pnpm build`、`pnpm check-generated`、`pnpm test` を実行する。`build` は `tsconfig.acp.json` の TypeScript を型検査し、同じ場所へ `.mjs` を生成する。CI は `check-generated` で型検査付きコンパイルとコミット済み生成物との一致を確認し、別のビルド工程は持たない。
- manifest の整合性は `pnpm check-version` で確認する。
- ホスト連携を変えるときは `tests/commands.test.mjs` の関連ケースと `hooks/hooks.json` の空の登録を照合する。テストの fake Grok と一時ディレクトリを使って、実アカウントへの実行と分離する。一時領域は `tests/helpers.mjs` と同様にリポジトリ外へ置き、Git 基点の検出がテスト対象へ干渉しないようにする。
- 標準入力の読取りを変えるときは `scripts/lib/fs.mjs` の非同期 API と全呼出し元の `await` を照合し、`tests/runtime.test.mjs` のパイプ入力・プロンプト優先順位を確認する。
- 前景実行を変えるときは `tests/foreground-bridge-e2e.test.mjs` で旧状態を読まないこと、読み取り専用権限、agent の終了と終了未確認時の失敗、RPC エラー・利用枠不足の表示、再開オプションの拒否を確認する。この E2E は Windows で skip されるため、未実行と成功を区別する。
- 既定モデル・推論深度・別名（`grok-companion.mts` の `aliases`、`grok.mts` の `DEFAULT_MODEL_CANDIDATES`）を変えるときは `tests/model-defaults.test.mjs` と `tests/runtime.test.mjs` の関連ケースを確認し、明示指定を既定候補で置き換えない契約を保つ。
- Grok の起動環境や ACP 接続・権限処理を変えるときは `tests/grok-env.test.mjs`、`tests/acp.test.mjs`、`tests/runtime.test.mjs` の関連ケースを確認する。JSONL 受信を変えるときは `tests/acp-transport-e2e.test.mjs` で巨大・分割応答、受信中のキャンセル、不正 JSON 後の終了も確認する。
- 文書だけの変更は参照先、実装との整合性、`git diff --check` を確認する。利用者向けの変更を README に反映するときは、英語の `README.md`（正本）と `README.ja.md`・`README.zh-CN.md`・`README.zh-TW.md`・`README.ko.md`・`README.es.md`・`README.fr.md`・`README.de.md`・`README.pt-BR.md` の全言語版を同時に直す。コマンド・パス・設定キー・製品名・URL は訳さない。
- 利用者へ直接見せる文言（companion の出力・エラー・ヘルプ・レビューの見出し）は `plugins/grok/scripts/locales/<タグ>.json` の 9 言語（ja・en・zh-CN・zh-TW・ko・es・fr・de・pt-BR）の辞書に置き、コードは `scripts/lib/i18n.mts` の `t(キー)` で参照する。文言を足したら 9 言語の辞書を同時に更新し、`tests/i18n.test.mts`（キー集合・プレースホルダーの整合）を通す。言語は `GROK_PLUGIN_LANGUAGE` → `LC_ALL` → `LC_MESSAGES` → `LANG` → OS の表示言語 → 英語の順に判定する。AI が読む文言（プロンプト・skills・コマンド定義・スキーマ）は英語に統一し、訳さない。`--language` は Grok の応答言語の指定で、表示言語とは別である。

## 実装上の制約

- 公開 CLI は前景・新規セッションの直接接続を維持する。通常経路へ旧 broker、状態の読込み・移行、自動 hook を接続しない。責務の境界は [DESIGN.md](DESIGN.md#実行経路とデータフロー) を参照する。
- 両ホストの入口で plugin root と空白を含むパスを扱う。複数行タスクのプロンプトファイルと引数の渡し方は Codex 実行契約にそろえる。
- 権限や構造化レビュー出力を変更するときは [設計の不変条件](DESIGN.md#重要な不変条件) と対応するテストを照合する。レビュー結果の契約は `schemas/review-output.schema.json`、`prompts/`、共通ランタイムの判定・表示をそろえ、`tests/render.test.mjs` と前景 E2E で確認する。
- 読み取り専用シェル許可リストの変更は `tests/shell-allowlist.test.mjs` を確認する。agent の停止と終了確認を変えるときは `tests/foreground-owned-process-e2e.test.mjs` と各 OS の所有プロセス関連テストを確認する。
- ランタイムは配布される `.mjs` を直接実行する。型検査だけに存在する生成物へ実行を依存させず、`plugins/grok/.generated/` は生成領域として扱う。
