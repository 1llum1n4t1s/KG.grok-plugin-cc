# リポジトリ作業規約

## 正本と構造

- 利用者向け手順は [README.md](README.md)、構造と不変条件は [DESIGN.md](DESIGN.md) を参照する。DESIGN.md は設計資料として扱う。
- 配布実装は `plugins/grok/`。Claude Code の入口は `commands/` と `agents/`、Claude 専用 helper は `claude-skills/`、Codex の入口は `skills/`、共通実装は `scripts/` に置く。
- コマンドの挙動を変えるときは両ホストの入口、共通ランタイム、関連テストを照合する。CLI の引数や起動手順は `scripts/grok-companion.mjs` の引数処理・ヘルプとも照合し、`tests/commands.test.mjs` と `tests/runtime.test.mjs` の関連ケースを確認する。Codex の実行契約（前景実行、プロンプトファイル、起動失敗時の復旧）は [codex-runtime.md](plugins/grok/references/codex-runtime.md) を参照する。
- marketplace は `.claude-plugin/marketplace.json` と `.agents/plugins/marketplace.json`、配布 manifest は `plugins/grok/.claude-plugin/plugin.json` と `plugins/grok/.codex-plugin/plugin.json` を照合する。
- skill の追加・移動時は、両 manifest の `skills` と `tests/commands.test.mjs` を照合し、Claude 専用 helper を Codex の公開 skill ディレクトリへ混在させない。構成は [DESIGN.md](DESIGN.md#主要コンポーネント) を参照する。

## コマンドと検証

- Node.js 22 以降と `package.json` の `packageManager` 指定の pnpm を使う。依存導入は `pnpm install --frozen-lockfile`。lockfile は `pnpm-lock.yaml`。
- 実装変更後は CI と同じ `pnpm test`、`pnpm build` を実行する。`build` は `tsconfig.acp.json` で指定した配布ランタイムとバージョン管理スクリプトの型検査・未使用定義の検出で、成果物を生成しない。
- manifest の整合性は `pnpm check-version` で確認する。
- ホスト連携を変えるときは `tests/commands.test.mjs`、`tests/coexistence.test.mjs` の関連ケースと `hooks/hooks.json` の空の登録を照合する。テストの fake Grok と一時ディレクトリを使って、実アカウントへの実行と分離する。一時領域は `tests/helpers.mjs` と同様にリポジトリ外へ置き、Git 基点の検出がテスト対象へ干渉しないようにする。
- 標準入力の読取りを変えるときは `scripts/lib/fs.mjs` の非同期 API と全呼出し元の `await` を照合し、`tests/runtime.test.mjs` のパイプ入力・プロンプト優先順位を確認する。
- 前景実行を変えるときは `tests/foreground-bridge-e2e.test.mjs` で旧状態を読まないこと、読み取り専用権限、agent の終了と終了未確認時の失敗、RPC エラー・利用枠不足の表示、再開オプションの拒否を確認する。この E2E は Windows で skip されるため、未実行と成功を区別する。
- Grok の起動環境や ACP 接続・権限処理を変えるときは `tests/grok-env.test.mjs`、`tests/acp.test.mjs`、`tests/runtime.test.mjs` の関連ケースを確認する。JSONL 受信やブローカーの接続・セッション所有権を変えるときは `tests/acp-transport-e2e.test.mjs` で直接起動とブローカー経由の巨大・分割応答、受信中のキャンセル、不正 JSON 後の終了、切断後の遅延要求とセッション再利用も確認する。
- 文書だけの変更は参照先、実装との整合性、`git diff --check` を確認する。利用者向けの変更は README の英語・日本語をそろえる。

## 実装上の制約

- 公開 CLI は前景・新規セッションの直接接続を維持する。通常経路へ旧 broker、状態の読込み・移行、自動 hook を接続しない。責務の境界は [DESIGN.md](DESIGN.md#実行経路とデータフロー) を参照する。
- 両ホストの入口で plugin root と空白を含むパスを扱う。複数行タスクのプロンプトファイルと引数の渡し方は Codex 実行契約にそろえる。
- 権限や構造化レビュー出力を変更するときは [設計の不変条件](DESIGN.md#重要な不変条件) と対応するテストを照合する。レビュー結果の契約は `schemas/review-output.schema.json`、`prompts/`、共通ランタイムの判定・表示をそろえ、`tests/render.test.mjs` と前景 E2E で確認する。保存結果の再表示は旧経路の `tests/runtime.test.mjs` で扱う。
- 読み取り専用シェル許可リストの変更は `tests/shell-allowlist.test.mjs`、ジョブのプロセス識別・状態遷移・停止の変更は `tests/process.test.mjs`、`tests/tracked-jobs.test.mjs`、`tests/runtime.test.mjs`、`tests/hooks.test.mjs` の関連ケースで確認する。照会の期限や Windows の停止コマンドを変えるときは `tests/process-deadline-e2e.test.mjs` で外部照会の停止、再試行全体の時間予算、開始時の登録拒否を確認し、Windows では長い PATH と実際の CIM 照会のケースも確認する。
- Windows のプロセス照会診断を変えるときは、Windows 上で `tests/process-diagnostics-e2e.test.mjs` の実 PowerShell / CIM、段階別タイムアウト、機密値の除外、ジョブログ保存、callback 例外・stderr 切断のケースを確認する。このテストは非 Windows では skip されるため、CI の成功だけを Windows 実機検証の代わりにしない。
- ランタイムは配布される `.mjs` を直接実行する。型検査だけに存在する生成物へ実行を依存させず、`plugins/grok/.generated/` は生成領域として扱う。

## 旧内部実装を変更する場合

旧ライブラリとテストは残っているが、公開 CLI の利用手順ではない。以下は該当する内部実装を変更する場合だけ適用する。

- 状態の読み書きは `scripts/lib/state.mjs` の API を使い、ホスト別の保存先とワークスペース境界を維持する。
- hook 処理は両ホストの root/data 環境変数と空白を含むパスを扱い、`tests/hooks.test.mjs`、`tests/coexistence.test.mjs`、分割標準入力を確認する。旧 SessionEnd 処理の timeout は3秒枠に収める。
- 起動受付・世代・取消・所有権は `tests/broker-admission-async-e2e.test.mjs`、`tests/direct-admission-e2e.test.mjs`、`tests/cancel-repair-e2e.test.mjs`、Windows では `tests/windows-agent-owned-e2e.test.mjs` で確認する。
- 再開は `tests/cancel-repair-e2e.test.mjs` の索引と詳細の矛盾・並行更新・実行 ID と broker 世代の照合、`tests/acp-transport-e2e.test.mjs` の欠落・未知・不正型の終了理由、`tests/runtime.test.mjs` の再開経路を確認する。
- state lock・移行・lease・履歴整理は `tests/state-lock-*.test.mjs`、`tests/posix-state-lock-e2e.test.mjs` と該当 OS の `tests/linux-*.test.mjs`、`tests/darwin-*.test.mjs` で確認する。模擬ケースと実機専用ケースを区別し、Ubuntu の CI 成功を Windows/macOS の実機確認の代わりにしない。
- snapshot・終了時ゲートは `tests/git-windows-snapshot-reader.test.mjs`、`tests/git-worktree-snapshot-memory.test.mjs`、`tests/stop-gate-snapshot*.test.mjs` で確認する。
