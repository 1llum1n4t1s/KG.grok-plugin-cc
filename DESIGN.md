# 設計

## 目的と構造

Claude Code と Codex から既存の Grok Build CLI を呼び出す薄い橋渡し。認証・モデル・外部サービス・会話の継続は Grok Build が担う。

## 主要コンポーネント

以下のパスは Git ルート基準。Claude 専用 helper と Codex 公開 skill は、それぞれの manifest が異なるディレクトリを公開し、ホスト固有の指示を混在させない。

Node.js ランタイム、管理スクリプト、テストの正本は TypeScript の `.mts`。`pnpm build` で同じ場所へ `.mjs` を生成し、配布用の生成物も Git 管理する。Windows helper の正本は `plugins/grok/native/` の Rust と Cargo.lock。PowerShell / CMD 実装は使用しない。両ホストは Node.js 22 以降で `.mjs` を直接実行し、Windows では対応アーキテクチャの同梱 executable を呼ぶ。利用者には従来どおり Node.js と Git が必要で、Rust、MSVC、コンパイラ、実行時ダウンロードは不要。生成物の照合と開発手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照する。

| 構成 | 責務 |
| --- | --- |
| `plugins/grok/commands/`、`agents/`、`claude-skills/` | Claude Code の入口と専用 helper |
| `plugins/grok/skills/` | Codex の公開入口 |
| `plugins/grok/scripts/grok-companion.mjs` | CLI 引数、対象とプロンプト、前景実行と結果表示 |
| `plugins/grok/scripts/lib/grok.mjs` と ACP 関連 | Grok の新規プロセスへの直接接続、権限と結果 |
| `plugins/grok/native/` | Windows の `supervisor`、`identity`、`git-snapshot` を実装する Rust helper とテスト用 shim |
| `plugins/grok/bin/win32-{ia32,x64,arm64}/grok-windows-helper.exe` | Rust 1.97.1 で生成し Git 管理する Windows 配布バイナリ。ビルド用 `native/target/` は配布しない |
| `plugins/grok/prompts/`、`plugins/grok/schemas/` | レビュープロンプトと構造化結果の契約 |
| `tests/` | fake Grok によるランタイムとホスト入口の検証 |

Windows 配布生成はツールチェーンと Rust flags を固定し、CI で同梱 exe と再生成物の SHA-256 一致を確認する。利用者環境でビルドしない配布方式でも、ソースから同一バイナリを再現できるようにするための境界である。固定版と再生成手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照する。

## 実行経路とデータフロー

各 review、adversarial-review、audit、task は一度だけ前景で新しい Grok ACP セッションを開始する。結果はその実行から直接返す。setup は認証状態を確認する。独自 broker、ジョブ台帳、移行、自動 hook は通常経路に含めない。会話再開は Grok 本体が担う。

POSIX では専用プロセスグループの supervisor が Grok の標準入出力を中継せず継承させ、親だけが保持する監視パイプの EOF で所有グループを停止する。親が強制終了しても supervisor は自身が leader として生きているグループに停止信号を送り、期限後は強制終了する。通常の終了確認もグループと標準入出力の終了を待つ。

Windows では `windows-agent.mjs` が Node.js の `process.arch` に対応する同梱 helper を選び、専用 Job の supervisor を起動する。helper は親 PID と作成 FILETIME、制御用名前付きパイプの所有者を照合し、Grok の起動プロセスを Job に所属させた停止状態で作成してから再開する。親の終了・制御接続の切断時は所有 Job を停止し、helper 自体の終了時も kill-on-close で子孫を回収する。Node.js 側は nonce が一致する制御接続から同じ Job の `ActiveProcesses=0` を示す停止通知を受けた場合だけ終了確認を成立させる。PID の不在や helper の終了だけでは成功扱いしない。

ホストの入口から `grok-companion.mjs` を呼び、`grok.mjs` の `foreground: true` を経て `GrokAcpClient.connectForeground` でローカルの `grok agent stdio` に接続する。ACP の初期化、新規セッション、プロンプト送信、結果受信、agent の終了を同じ呼出しが担当する。setup は新規セッションを作成して認証を確かめ、タスクのプロンプトは送らない。X 検索と rescue は `task` を利用する。

レビューでは `git.mjs` が差分またはリポジトリの対象情報を集め、`prompts/` のテンプレートと schema を載せて送信する。正常に終了した応答の JSON が壊れている場合だけ、同じセッションで一度再出力を求め、初回の権限拒否記録は保持する。task の入力は `--prompt-file`、位置引数、パイプ標準入力の順で選ぶ。JSON 出力ではレビューの原文を `reviewText`、タスクの最終応答を `finalMessage` に含め、通常出力ではレビューを描画し、タスクの応答を直接表示する。

Windows の作業ツリースナップショットでは、同梱 helper の `git-snapshot` が固定ローカルドライブのルートから各成分をハンドル相対で開き、reparse point や曖昧なパスを拒否する。ディレクトリとファイルのハンドルは応答の出力完了まで保持し、パスの差し替えによる境界外の読取りを防ぐ。`git.mjs` は応答の版・対象パス・内容・容量を検証し、安全な完全スナップショットを確立できなければ失敗させる。

この境界はプラグイン側の永続ジョブ管理と Grok 本体の会話管理を二重化しないために置く。旧状態は読み取らず、`hooks/hooks.json` の登録も空である。旧 status・result・cancel・state-lock・task-resume-candidate と再開・背景実行の指定は拒否し、旧 `--wait` は待機ジョブを作らない。

## 重要な不変条件

- レビュー・監査と読み取り専用タスクは、ACP のファイル操作と権限要求をワークスペースに制限する。シェル要求はコマンド内容を許可リストで判定し、不明な操作と書込みを拒否する。編集依頼の task のみ `--write` によって書込みを許可する。
- レビューと task の正常終了には `completed` と `end_turn`、権限拒否がないこと、agent の終了確認が必要。レビューはさらに schema に沿う結果が必要で、失敗・不完全な出力を承認結果として扱わない。有効な構造化結果でも実行が不完全なら verdict を `incomplete` にする。
- 結果受信後も agent を閉じ、終了未確認は `turnStopUnconfirmed` と非ゼロ終了コードで伝える。setup も終了未確認を成功扱いしない。
- RPC エラーはコードとデータを JSON 出力へ含める。HTTP 402 と `usage balance exhausted` が一致するときだけ利用枠不足に分類し、回復後の再実行を案内する。他の課金・接続エラーを同じ理由に決め付けない。

利用方法は [README.md](README.md)、Codex 入口の実行契約は [codex-runtime.md](plugins/grok/references/codex-runtime.md)、変更時の検証手順は [AGENTS.md](AGENTS.md) を参照する。
