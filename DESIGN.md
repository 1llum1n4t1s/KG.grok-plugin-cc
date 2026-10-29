# 設計

## 目的と構造

Claude Code と Codex から既存の Grok Build CLI を呼び出す薄い橋渡し。認証・モデル・外部サービス・会話の継続は Grok Build が担う。

| 構成 | 責務 |
| --- | --- |
| `plugins/grok/commands/`、`agents/`、`claude-skills/` | Claude Code の入口と専用 helper |
| `plugins/grok/skills/` | Codex の公開入口 |
| `plugins/grok/scripts/grok-companion.mjs` | CLI 引数、対象とプロンプト、前景実行と結果表示 |
| `plugins/grok/scripts/lib/grok.mjs` と ACP 関連 | Grok の新規プロセスへの直接接続、権限と結果 |
| `plugins/grok/prompts/`、`schemas/` | レビュープロンプトと構造化結果の契約 |
| `tests/` | fake Grok によるランタイムとホスト入口の検証 |

## 実行と不変条件

各 review、adversarial-review、audit、task は一度だけ前景で新しい Grok ACP セッションを開始する。結果はその実行から直接返す。setup は認証状態を確認する。独自 broker、ジョブ台帳、移行、自動 hook は通常経路に含めない。会話再開は Grok 本体が担う。

レビュー・監査と読み取り専用タスクはワークスペースおよび権限の制約を維持する。編集が必要な task だけ明示的に write を指定する。レビューの構造化結果と不完全な結果の扱いは schema と描画処理で検証する。

旧 broker、状態管理、移行、hook 等の内部実装は履歴上の互換性とテストの参考として残る場合があるが、公開された通常実行から呼び出さない。旧データの移行は行わない。利用方法は [README.md](README.md)、Codex 入口の実行契約は [codex-runtime.md](plugins/grok/references/codex-runtime.md) を参照する。
