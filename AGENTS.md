# リポジトリ作業規約

## 正本と構造

- 利用者向け手順は [README.md](README.md)、構造と不変条件は [DESIGN.md](DESIGN.md) を参照する。DESIGN.md は設計資料として扱う。
- 配布実装は `plugins/grok/`。Claude Code の入口は `commands/` と `agents/`、Codex の入口は `skills/`、共通実装は `scripts/` に置く。
- コマンドの挙動を変えるときは両ホストの入口、共通ランタイム、関連テストを照合する。Codex の実行契約は `plugins/grok/references/codex-runtime.md` を参照する。
- marketplace は `.claude-plugin/marketplace.json` と `.agents/plugins/marketplace.json`、配布 manifest は `plugins/grok/.claude-plugin/plugin.json` と `plugins/grok/.codex-plugin/plugin.json` を照合する。

## コマンドと検証

- Node.js 22 以降と `package.json` の `packageManager` 指定の pnpm を使う。依存導入は `pnpm install --frozen-lockfile`。lockfile は `pnpm-lock.yaml`。
- 実装変更後は CI と同じ `pnpm test`、`pnpm build` を実行する。`build` は `tsconfig.acp.json` に列挙された JavaScript の型検査で、成果物を生成しない。
- manifest の整合性は `pnpm check-version` で確認する。
- フックやホスト連携を変えるときは `tests/hooks.test.mjs`、`tests/commands.test.mjs`、`tests/coexistence.test.mjs` の関連ケースを確認する。テストの fake Grok と一時ディレクトリを使って、実アカウントへの実行と分離する。
- 文書だけの変更は参照先、実装との整合性、`git diff --check` を確認する。利用者向けの変更は README の英語・日本語をそろえる。

## 実装上の制約

- フックのパスは `hooks/hooks.json` の Node.js 起動方式にそろえ、両ホストの root/data 環境変数と空白を含むパスを扱う。
- 状態の読み書きは `scripts/lib/state.mjs` の API を使い、ホスト別の保存先とワークスペース境界を維持する。
- 権限、ジョブ所有者、キャンセル、構造化レビュー出力を変更するときは [設計の不変条件](DESIGN.md#重要な不変条件) と対応するテストを照合する。
- ランタイムは配布される `.mjs` を直接実行する。型検査だけに存在する生成物へ実行を依存させず、`plugins/grok/.generated/` は生成領域として扱う。
