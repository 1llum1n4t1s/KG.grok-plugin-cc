[English](#english) | [日本語](#japanese)

<a id="english"></a>
# Grok plugin for Claude Code and Codex

Run Grok Build from Claude Code or Codex for code reviews, repository audits, X searches, and delegated tasks. This project is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see [NOTICE](NOTICE).

## Requirements and installation

Install [Grok Build](https://x.ai/cli), sign in or configure its API key, and install Node.js 22 or later and Git 2.45 or later (or a Git build with backported `--no-lazy-fetch`). Grok usage is charged to the account or API key used. Grok must support `grok agent stdio`; update it with `grok update` if needed.

In Claude Code:

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

For Codex, run:

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Start a new Codex task to load its skills. Install separately in each host if using both.

## Commands

Claude Code exposes `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:rescue`, `/grok:x`, and `/grok:setup`. In Codex, select the corresponding `grok:source-command-<name>` skill. Review and audit are read-only; rescue can request edits, while X search stays read-only. Setup checks Grok authentication.

For example, use `/grok:review --scope working-tree` to review local changes, `/grok:audit authentication` to focus an audit, or `/grok:rescue <task>` to delegate a task. Review also accepts `--base <ref>` and `--language <BCP 47 tag>`. Run `/grok:setup` when installation or authentication fails; follow its reported error and Grok’s login guidance.

Each invocation runs a new Grok session in the foreground and returns its result directly. Use Grok's own interface to continue a conversation. Automatic reviews and the former status, result, cancel, state-lock, and task-resume commands are no longer supported by the companion.

The companion starts the locally installed Grok CLI. Review and read-only tasks retain workspace and permission restrictions; explicitly requested write tasks can modify the workspace. External access and authentication are handled by Grok Build. Review Grok's output and changes before relying on them.

## Troubleshooting

If an invocation reports HTTP 402 with `usage balance exhausted`, Grok Build's usage balance is exhausted. Retry after that balance recovers. A timeout, permission denial, incomplete review, or unconfirmed agent stop is a failed invocation; do not treat partial output as a completed review or task.

For development commands and validation, see [AGENTS.md](AGENTS.md). Runtime structure and boundaries are described in [DESIGN.md](DESIGN.md).

<a id="japanese"></a>
# Claude Code・Codex 向け Grok プラグイン

Claude Code や Codex から Grok Build を使い、コードレビュー、リポジトリ監査、X 検索、タスクの委任を行えます。本プロジェクトは [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) のフォークです。詳細は [NOTICE](NOTICE) を参照してください。

## 必要環境とインストール

[Grok Build](https://x.ai/cli) をインストールし、ログインまたは API キーを設定してください。Node.js 22 以降、Git 2.45 以降（または `--no-lazy-fetch` のバックポート版）が必要です。Grok の利用は使用するアカウントまたは API キーに課金されます。`grok agent stdio` が使えない場合は `grok update` で更新してください。

Claude Code では次を実行します。

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Codex ではターミナルから次を実行します。

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

新しい Codex タスクでスキルを読み込みます。両ホストで使う場合はそれぞれにインストールしてください。

## コマンド

Claude Code では `/grok:review`、`/grok:adversarial-review`、`/grok:audit`、`/grok:rescue`、`/grok:x`、`/grok:setup` を使います。Codex では対応する `grok:source-command-<name>` スキルを選びます。レビュー・監査と X 検索は読み取り専用です。rescue は編集も依頼できます。setup は Grok の認証を確認します。

例えば `/grok:review --scope working-tree` はローカル変更をレビューし、`/grok:audit authentication` は認証に対象を絞り、`/grok:rescue <task>` はタスクを委任します。レビューには `--base <ref>` と `--language <BCP 47 tag>` も指定できます。起動や認証に失敗したら `/grok:setup` を実行し、表示されたエラーと Grok のログイン案内を確認してください。

各実行は新しい Grok セッションを前景で開始し、その結果を直接返します。会話の続きは Grok 本体で行ってください。自動レビューと旧 status・result・cancel・state-lock・タスク再開コマンドは利用できません。

ローカルにインストールされた Grok CLI を起動します。レビューと読み取り専用タスクではワークスペースと権限の制限を維持し、明示的に編集を依頼したタスクはワークスペースを変更できます。外部アクセスと認証は Grok Build が担います。結果と変更を確認してから利用してください。

## トラブルシュート

HTTP 402 と `usage balance exhausted` が表示された場合は、Grok Build の利用枠が不足しています。利用枠の回復後に再実行してください。タイムアウト、権限拒否、不完全なレビュー、agent の終了未確認は実行失敗です。途中の出力を完了したレビューやタスクとして扱わないでください。

開発用コマンドと検証手順は [AGENTS.md](AGENTS.md)、実行時の構造と境界は [DESIGN.md](DESIGN.md) を参照してください。
