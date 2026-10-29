# 設計

## 目的と構造

Claude Code と Codex から既存の Grok Build CLI を呼び出す薄い橋渡し。認証・モデル・外部サービス・会話の継続は Grok Build が担う。

## 主要コンポーネント

以下のパスは Git ルート基準。Claude 専用 helper と Codex 公開 skill は、それぞれの manifest が異なるディレクトリを公開し、ホスト固有の指示を混在させない。

| 構成 | 責務 |
| --- | --- |
| `plugins/grok/commands/`、`agents/`、`claude-skills/` | Claude Code の入口と専用 helper |
| `plugins/grok/skills/` | Codex の公開入口 |
| `plugins/grok/scripts/grok-companion.mjs` | CLI 引数、対象とプロンプト、前景実行と結果表示 |
| `plugins/grok/scripts/lib/grok.mjs` と ACP 関連 | Grok の新規プロセスへの直接接続、権限と結果 |
| `plugins/grok/prompts/`、`plugins/grok/schemas/` | レビュープロンプトと構造化結果の契約 |
| `tests/` | fake Grok によるランタイムとホスト入口の検証 |

## 実行経路とデータフロー

各 review、adversarial-review、audit、task は一度だけ前景で新しい Grok ACP セッションを開始する。結果はその実行から直接返す。setup は認証状態を確認する。独自 broker、ジョブ台帳、移行、自動 hook は通常経路に含めない。会話再開は Grok 本体が担う。

ホストの入口から `grok-companion.mjs` を呼び、`grok.mjs` の `foreground: true` を経て `GrokAcpClient.connectForeground` でローカルの `grok agent stdio` に接続する。ACP の初期化、新規セッション、プロンプト送信、結果受信、agent の終了を同じ呼出しが担当する。setup は新規セッションを作成して認証を確かめ、タスクのプロンプトは送らない。X 検索と rescue は `task` を利用する。

レビューでは `git.mjs` が差分またはリポジトリの対象情報を集め、`prompts/` のテンプレートと schema を載せて送信する。正常に終了した応答の JSON が壊れている場合だけ、同じセッションで一度再出力を求め、初回の権限拒否記録は保持する。task の入力は `--prompt-file`、位置引数、パイプ標準入力の順で選ぶ。JSON 出力ではレビューの原文を `reviewText`、タスクの最終応答を `finalMessage` に含め、通常出力ではレビューを描画し、タスクの応答を直接表示する。

この境界はプラグイン側の永続ジョブ管理と Grok 本体の会話管理を二重化しないために置く。旧状態は読み取らず、`hooks/hooks.json` の登録も空である。旧 status・result・cancel・state-lock・task-resume-candidate と再開・背景実行の指定は拒否し、旧 `--wait` は待機ジョブを作らない。

## 重要な不変条件

- レビュー・監査と読み取り専用タスクは、ACP のファイル操作と権限要求をワークスペースに制限する。シェル要求はコマンド内容を許可リストで判定し、不明な操作と書込みを拒否する。編集依頼の task のみ `--write` によって書込みを許可する。
- レビューと task の正常終了には `completed` と `end_turn`、権限拒否がないこと、agent の終了確認が必要。レビューはさらに schema に沿う結果が必要で、失敗・不完全な出力を承認結果として扱わない。有効な構造化結果でも実行が不完全なら verdict を `incomplete` にする。
- 結果受信後も agent を閉じ、終了未確認は `turnStopUnconfirmed` と非ゼロ終了コードで伝える。setup も終了未確認を成功扱いしない。
- RPC エラーはコードとデータを JSON 出力へ含める。HTTP 402 と `usage balance exhausted` が一致するときだけ利用枠不足に分類し、回復後の再実行を案内する。他の課金・接続エラーを同じ理由に決め付けない。

## 旧内部実装との境界

旧 broker、状態管理、移行、hook 等の内部実装とテストは残るが、公開された通常実行から呼び出さない。`GrokAcpClient.connect` などの旧接続 API と、CLI が使用する `connectForeground` は別経路である。旧データの移行は行わない。

利用方法は [README.md](README.md)、Codex 入口の実行契約は [codex-runtime.md](plugins/grok/references/codex-runtime.md)、変更時の検証手順と旧内部実装のテスト範囲は [AGENTS.md](AGENTS.md) を参照する。
