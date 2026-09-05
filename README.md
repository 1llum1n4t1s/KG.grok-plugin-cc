[English](#english) | [日本語](#japanese)

<a id="english"></a>

# Grok plugin for Claude Code and Codex

Use Grok Build from inside Claude Code or Codex for code reviews, repository audits, X searches,
or delegated tasks.

This plugin is for Claude Code and Codex users who already have Grok Build installed and want to
reach it from the workflow they are already in.

It is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), retargeted
from the OpenAI Codex CLI to xAI's Grok Build CLI. See [NOTICE](./NOTICE) for attribution and a
summary of what changed.

## What You Get

The examples below use Claude Code's `/grok:<name>` slash commands. In Codex, open `/skills` and
choose the matching `grok:source-command-<name>` skill, or ask Codex to use it by name. The explicit
`source-command-` prefix prevents Claude's slash commands from colliding with Codex skills. Both
hosts route through the same companion runtime and job store.

- `/grok:review` for a read-only Grok review of your local git state
- `/grok:adversarial-review` for a deliberately skeptical ship/no-ship review
- `/grok:audit` for a read-only audit of the entire existing codebase, ignoring the current diff
- `/grok:rescue` to hand a problem to Grok and get a worked answer back
- `/grok:x` to search X (Twitter) posts, which plain web search cannot read
- `/grok:status`, `/grok:result`, and `/grok:cancel` to inspect, recover, or stop tracked jobs
- `/grok:setup` to check that everything is wired up

## Requirements

- **Grok Build**, signed in with a SuperGrok or X Premium+ account, or an `XAI_API_KEY`.
  Usage counts against whichever one you use.
- **Node.js 22 or later**

Install Grok Build from [x.ai/cli](https://x.ai/cli):

```bash
irm https://x.ai/cli/install.ps1 | iex
```

On macOS or Linux:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

The plugin talks to Grok over `grok agent stdio`, so you need a build recent enough to expose that
subcommand. `/grok:setup` tells you if yours is too old.

## Install

### Claude Code

Add the marketplace in Claude Code:

```bash
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
```

Install the plugin:

```bash
/plugin install grok@kagayoi-grok
```

### Codex

Add the same marketplace and install the plugin from a terminal:

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Start a new Codex task after installation so its skill catalog includes the plugin. Open `/skills`
and select `grok:source-command-setup` to verify Grok Build and authentication. Codex may also ask
you to trust the plugin's lifecycle hooks the first time it loads them.
Keep all four Grok plugin hooks enabled, including on Windows. The plugin resolves its paths
through Node.js; a separate user-level hook bridge is not required.

To use Claude Code and Codex together, install the plugin in each application.
Keep the plugin data directories assigned by each application separate; job state and
review-gate settings are stored independently, even when both use the same repository.

Reload plugins:

```bash
/reload-plugins
```

### What the plugin runs on your machine

Worth knowing before you install, because this plugin does more than add prompts:

- It starts `grok agent stdio` as a child process and talks to it over the Agent
  Client Protocol. Grok Build itself comes from x.ai, not from this repository.
- Runs in the same repository share one Grok process through a small broker that
  stays resident between commands. `/grok:status` shows what is running and
  `/grok:cancel` stops it.
- Job records and Grok's output are written under the plugin's own data
  directory, scoped per repository.
- Grok reads your repository to answer, so the code it opens goes to xAI under
  the account Grok Build is signed in with. Nothing is sent anywhere else, and
  this plugin has no backend of its own.
- The stop-time review gate is **off by default**. If you turn it on with
  `/grok:setup --enable-review-gate`, each assistant turn that changes the repository runs a fresh
  review before it stops and can block until the issue is fixed. Continuations from other Stop
  hooks are skipped when they make no repository changes. Turn it back off with
  `/grok:setup --disable-review-gate`.

Then run `/grok:setup` in Claude Code, or select `grok:source-command-setup` from `/skills` in Codex:

```bash
/grok:setup
```

`/grok:setup` reports whether Grok Build is installed, whether `grok agent stdio` is available,
and whether you are signed in. It does not install anything for you — Grok Build ships from x.ai,
not from a package registry.

### Signing in

Either sign in interactively:

```bash
grok login
```

...or set an API key from [console.x.ai](https://console.x.ai) for headless or metered use:

```bash
$env:XAI_API_KEY = "xai-..."
```

The API key takes precedence over browser credentials.

## Usage

### `/grok:review`

Runs a read-only review of your local git state and returns Grok's findings verbatim.

```bash
/grok:review
/grok:review --base main
/grok:review --scope working-tree
/grok:review focus on the retry logic
```

Any text left after the flags is passed to Grok as review focus.

Findings come back in your language: when run as a slash command, Claude forwards the conversation
language with `--language <bcp47>` automatically. When calling the companion script directly, pass
`--language` yourself, or the review falls back to the language of the focus text, then English.
This applies to `/grok:adversarial-review` and `/grok:audit` as well.

The review is read-only: Grok may read files and run read-only commands such as `git diff` and
`git log`, but the plugin denies anything that would write to disk. Grok reports what it thinks
should change; it does not change it.

Every Grok command runs in the foreground in both Claude Code and Codex. This keeps command output,
the exact Grok job ID, cancellation, and stored results under one consistent lifecycle. The old
`--wait` flag is accepted as a no-op for compatibility; `--background` is rejected instead of
silently changing execution behavior.

Codex skills use the companion's buffered JSON mode, so long-running reviews, audits, delegated
tasks, and X searches stay quiet in chat until Grok finishes. Detailed progress remains available
in the stored job log and through the status command. Claude Code keeps its native foreground Bash
display.

### `/grok:adversarial-review`

Same targeting as `/grok:review`, but Grok is told to argue against shipping and to report the
strongest reasons the change should not land yet.

```bash
/grok:adversarial-review
/grok:adversarial-review --base main
/grok:adversarial-review focus on the migration path
```

Use this when you want pushback rather than a balanced summary.

### `/grok:audit`

Audits the entire existing codebase instead of a diff. Use it when you want Grok's opinion on the
source as it stands, independent of whatever you are currently changing.

```bash
/grok:audit
/grok:audit focus on the auth module
```

The audit context deliberately contains no diff and no file contents, only a file inventory; Grok
reads the files it decides to inspect with read-only commands. With no focus text, it performs a
risk-directed deep audit by mapping the architecture, selecting the highest-risk execution paths,
and tracing their callers, state transitions, boundaries, failure paths, concurrency behavior, and
tests. An explicit focus is still useful on large repositories when you want that deep pass confined
to a particular subsystem or concern.

The same read-only guarantees as `/grok:review` apply.

### `/grok:rescue`

Hands a problem to Grok and returns its answer. This is the command for "I am stuck, get another
set of eyes on it."

```bash
/grok:rescue why does the upload retry loop never terminate?
/grok:rescue --resume
/grok:rescue --model latest --effort high
```

Unlike the review commands, `/grok:rescue` runs write-capable by default, so Grok can edit files
while it works. Say so in the request when you only want diagnosis — "read-only", "just
investigate", "don't change anything" — and the run stays read-only.

Model aliases: `fast`, `reasoning`, `multi`, `build`, `latest`. Anything else is passed through as
a model ID, so `--model grok-4.6` works too. `--effort` accepts `low`, `medium`, or `high`.

### `/grok:x`

Searches X (Twitter) posts through Grok Build and returns the findings with author handles, dates,
and post URLs. Grok Build reaches X with its own `x_keyword_search` and `x_semantic_search` tools,
so this works with the same `grok login` credentials as every other command — no xAI API key needed.
Ordinary web search cannot read X timelines, which is why this is a separate command.

```bash
/grok:x what are people saying about the latest Avalonia release
/grok:x --model latest reaction to the new pricing announcement
```

The run is always read-only. A search drives a full Grok Build session, so it usually takes a few
minutes and remains attached until it completes.

### `/grok:status`

Shows active and recent Grok jobs for the repository, plus the state of the review gate.

```bash
/grok:status
/grok:status --all
/grok:status <job-id> --wait
```

### `/grok:result`

Prints the stored final output of a finished job.

```bash
/grok:result
/grok:result <job-id>
```

Each result includes the Grok session ID and the `grok --resume <id>` command, so you can pick the
conversation back up in Grok's own TUI.

### `/grok:cancel`

Cancels a running tracked job and stops the Grok turn behind it.

```bash
/grok:cancel
/grok:cancel <job-id>
```

Without a job ID, cancel selects the only active job in the current session. If multiple jobs are
active, it stops without guessing and asks for a job ID; use `/grok:status` to choose one.

### `/grok:setup`

Checks the local install and optionally toggles the stop-time review gate.

```bash
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

The gate is off unless you enable it. With it enabled, an assistant turn that changes the repository
triggers a fresh adversarial review and blocks until that review finishes. Unchanged turns, including
continuations caused only by another Stop hook, do not start Grok. A large change can still take a
while to review. Turn the gate back off with `/grok:setup --disable-review-gate`.

## Typical Flows

### Review before shipping

```bash
/grok:review
```

Read the findings, fix what matters, then run it again.

### Hand a problem to Grok

```bash
/grok:rescue the websocket reconnect drops messages under load
```

### Run something long-running

```bash
/grok:rescue port the settings screen to the new form API
```

## How It Talks To Grok

The plugin runs `grok agent stdio` and speaks the Agent Client Protocol to it. That means Grok
reads your repository itself rather than being handed a pasted diff, and you see its tool calls as
they happen.

Runs in the same repository share one Grok process through a small broker, so a review and a
delegated task do not each pay startup cost. If the broker is unreachable the plugin falls back to
starting its own Grok process.

### Choosing a model

The plugin asks for `grok-4.6` by default. Override it for a single run with `--model`, or for
every run by setting `GROK_PLUGIN_MODEL`.

This matters more than it looks: when you authenticate with `XAI_API_KEY`, Grok's own default for a
new session is a non-reasoning model, which reviews noticeably worse.

## FAQ

### Do I need a separate account for this plugin?

No. It uses whatever Grok Build on your machine is already signed in with.

### Does it use my existing Grok configuration?

Yes, with one exception: reviews start with no MCP servers attached, so your global MCP setup does
not get loaded into every review and inflate the token count. Delegated `/grok:rescue` runs use
your normal configuration.

### Is `/grok:review` really read-only?

Grok may read files and run read-only commands. Every permission request for anything else is
denied by the plugin, including shell commands that are not on a read-only allowlist and anything
that redirects output to a file.

### Why is there no `/grok:transfer`?

The upstream Codex plugin could import a Claude Code session into a Codex thread. Grok Build has no
equivalent, so the command was removed rather than faked.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

<a id="japanese"></a>

# Claude Code / Codex 向け Grok プラグイン

Claude Code や Codex の中から Grok Build を使い、コードレビュー、リポジトリ監査、X の検索、
タスクの委任を行えます。

このプラグインは、Grok Build をすでにインストールしており、普段使っている Claude Code や
Codex のワークフローからそのまま呼び出したい方を対象としています。

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) をフォークし、OpenAI Codex
CLI 向けの実装を xAI の Grok Build CLI 向けに変更したものです。帰属表示と主な変更点については
[NOTICE](./NOTICE) を参照してください。

## 主な機能

以下の例では、Claude Code の `/grok:<name>` スラッシュコマンドを使用します。Codex では
`/skills` を開き、対応する `grok:source-command-<name>` スキルを選択するか、スキル名を指定して
Codex に実行を依頼してください。明示的な `source-command-` プレフィックスにより、Claude の
スラッシュコマンドと Codex のスキルが衝突するのを防いでいます。どちらのホストも、同じ
コンパニオンランタイムとジョブストアを使用します。

- `/grok:review`: ローカルの Git 状態を Grok が読み取り専用でレビュー
- `/grok:adversarial-review`: 出荷可否を意図的かつ懐疑的にレビュー
- `/grok:audit`: 現在の差分を無視し、既存コードベース全体を読み取り専用で監査
- `/grok:rescue`: 問題を Grok に任せ、具体的な回答を取得
- `/grok:x`: 通常の Web 検索では読み取れない X（Twitter）の投稿を検索
- `/grok:status`、`/grok:result`、`/grok:cancel`: 追跡ジョブの確認、結果復旧、停止
- `/grok:setup`: 必要な設定が正しく機能しているか確認

## 必要要件

- **Grok Build**: SuperGrok または X Premium+ アカウントでサインインするか、
  `XAI_API_KEY` を設定してください。使用量は、利用した認証方式のアカウントに計上されます。
- **Node.js 22 以降**

[x.ai/cli](https://x.ai/cli) から Grok Build をインストールします。

```bash
irm https://x.ai/cli/install.ps1 | iex
```

macOS または Linux の場合:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

このプラグインは `grok agent stdio` を介して Grok と通信するため、このサブコマンドを提供する
新しいバージョンの Grok Build が必要です。バージョンが古い場合は `/grok:setup` で確認できます。

## インストール

### Claude Code

Claude Code にマーケットプレイスを追加します。

```bash
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
```

プラグインをインストールします。

```bash
/plugin install grok@kagayoi-grok
```

### Codex

ターミナルから同じマーケットプレイスを追加し、プラグインをインストールします。

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

インストール後は、新しい Codex タスクを開始して、プラグインのスキルをスキルカタログへ反映させます。
`/skills` を開いて `grok:source-command-setup` を選択し、Grok Build と認証を確認してください。
ライフサイクルフックを初めて読み込むときは、Codex からプラグインを信頼するか確認される場合があります。
Windows を含め、Grok プラグインの4個のフックをすべて ON にして使います。
プラグイン自身が Node.js でパスを解決するため、ユーザー設定への別のフック登録は不要です。

Claude Code と Codex を併用するときは、それぞれにプラグインをインストールします。
各アプリが割り当てるプラグインのデータ保存先は別々に維持してください。
同じリポジトリを使う場合も、ジョブ状態とレビューゲートの設定は個別に保存されます。

プラグインを再読み込みするには、次を実行します。

```bash
/reload-plugins
```

### このプラグインがローカル環境で実行する処理

このプラグインはプロンプトを追加するだけではありません。インストール前に次の点を確認してください。

- `grok agent stdio` を子プロセスとして起動し、Agent Client Protocol を介して通信します。
  Grok Build 自体はこのリポジトリではなく、x.ai から提供されます。
- 同じリポジトリ内の実行は、小さなブローカーを介して 1 つの Grok プロセスを共有します。
  このプロセスはコマンド間も常駐します。実行中の処理は `/grok:status` で確認でき、
  `/grok:cancel` で停止できます。
- ジョブ記録と Grok の出力は、リポジトリごとに分けられたプラグイン専用のデータディレクトリへ
  書き込まれます。
- Grok は回答のためにリポジトリを読み取ります。そのため、Grok が開いたコードは Grok Build の
  サインイン先アカウントを通じて xAI へ送信されます。それ以外の場所へは送信されず、この
  プラグイン独自のバックエンドもありません。
- 終了時のレビューゲートは**既定で無効**です。`/grok:setup --enable-review-gate` で有効にすると、
  リポジトリを変更した各アシスタントターンの終了前に新しいレビューが実行され、問題が解消するまで
  終了をブロックできます。別のStopフックが継続させても、リポジトリ変更がなければ再実行しません。
  `/grok:setup --disable-review-gate` で再び無効にできます。

続いて、Claude Code では `/grok:setup` を実行します。Codex では `/skills` から
`grok:source-command-setup` を選択します。

```bash
/grok:setup
```

`/grok:setup` は、Grok Build がインストール済みか、`grok agent stdio` が利用可能か、
サインイン済みかを報告します。Grok Build はパッケージレジストリではなく x.ai から提供されるため、
このコマンド自体は何もインストールしません。

### サインイン

対話形式でサインインする場合:

```bash
grok login
```

ヘッドレス環境または従量課金で利用する場合は、[console.x.ai](https://console.x.ai) で取得した
API キーを設定します。

```bash
$env:XAI_API_KEY = "xai-..."
```

API キーはブラウザの認証情報より優先されます。

## 使い方

### `/grok:review`

ローカルの Git 状態を読み取り専用でレビューし、Grok の指摘をそのまま返します。

```bash
/grok:review
/grok:review --base main
/grok:review --scope working-tree
/grok:review focus on the retry logic
```

フラグより後に残ったテキストは、レビューの注目点として Grok に渡されます。

指摘は利用者の言語で返されます。スラッシュコマンドとして実行した場合、Claude は会話の言語を
`--language <bcp47>` で自動的に渡します。コンパニオンスクリプトを直接呼び出す場合は、
`--language` を自分で指定してください。指定しなければ、注目点として渡したテキストの言語、
それも判定できなければ英語が使われます。これは `/grok:adversarial-review` と `/grok:audit` にも
適用されます。

レビューは読み取り専用です。Grok はファイルを読み、`git diff` や `git log` などの読み取り専用
コマンドを実行できますが、ディスクへ書き込む操作はプラグインによって拒否されます。Grok は
変更すべき内容を報告しますが、実際の変更は行いません。

Claude Code と Codex のどちらでも、すべての Grok コマンドをフォアグラウンドで実行します。
コマンド出力、正確な Grok ジョブ ID、キャンセル、保存済み結果を一つの一貫したライフサイクルで
扱えるためです。旧 `--wait` は互換性のため何もしないフラグとして受け付けますが、`--background` は
実行方法を暗黙に変えず、明確なエラーとして拒否します。

Codex向けスキルはコンパニオンのバッファ済みJSONモードを使用するため、長時間のレビュー、監査、
委任タスク、X検索ではGrokの完了までチャットへ途中経過を流しません。詳細な進捗は保存済みジョブログと
statusコマンドから確認できます。Claude Codeでは従来どおり、ネイティブの前景Bash表示を維持します。

### `/grok:adversarial-review`

対象の指定方法は `/grok:review` と同じですが、Grok は出荷に反対する立場から、変更をまだ
取り込むべきでない最も強い理由を報告します。

```bash
/grok:adversarial-review
/grok:adversarial-review --base main
/grok:adversarial-review focus on the migration path
```

バランスの取れた要約ではなく、強い反論が欲しい場合に使用します。

### `/grok:audit`

差分ではなく、既存コードベース全体を監査します。現在の変更内容とは無関係に、現状のソースに
対する Grok の見解が欲しい場合に使用します。

```bash
/grok:audit
/grok:audit focus on the auth module
```

監査コンテキストには意図的に差分もファイル内容も含めず、ファイル一覧だけを渡します。Grok は
読み取り専用コマンドを使い、調査対象のファイルを自分で選んで読み取ります。注目点を指定しない場合は、
アーキテクチャを把握し、最もリスクの高い実行経路を選び、呼び出し元、状態遷移、境界、失敗経路、
並行処理、テストまで追跡する、リスク指向の詳細監査を実行します。大規模なリポジトリでは、特定の
サブシステムや観点に詳細監査を絞りたいときに注目点を指定すると効果的です。

`/grok:review` と同じ読み取り専用の保証が適用されます。

### `/grok:rescue`

問題を Grok に渡し、その回答を返します。「行き詰まったので、別の視点で見てほしい」という場合に
使うコマンドです。

```bash
/grok:rescue why does the upload retry loop never terminate?
/grok:rescue --resume
/grok:rescue --model latest --effort high
```

レビューコマンドとは異なり、`/grok:rescue` は既定で書き込み可能な状態で実行されるため、Grok は
作業中にファイルを編集できます。診断だけが必要な場合は、依頼文に `read-only`、`just investigate`、
`don't change anything` などと明記すると、読み取り専用で実行されます。

モデルの別名は `fast`、`reasoning`、`multi`、`build`、`latest` です。それ以外の値はモデル ID として
そのまま渡されるため、`--model grok-4.6` のような指定もできます。`--effort` には `low`、`medium`、
`high` を指定できます。

### `/grok:x`

Grok Build を介して X（Twitter）の投稿を検索し、投稿者のハンドル、日付、投稿 URL を含む結果を
返します。Grok Build 独自の `x_keyword_search` と `x_semantic_search` ツールを使って X へ
アクセスするため、他のコマンドと同じ `grok login` の認証情報で利用でき、xAI API キーは不要です。
通常の Web 検索では X のタイムラインを読み取れないため、独立したコマンドとして用意されています。

```bash
/grok:x what are people saying about the latest Avalonia release
/grok:x --model latest reaction to the new pricing announcement
```

実行は常に読み取り専用です。1 回の検索で Grok Build の完全なセッションを実行するため、通常は
数分かかり、完了まで接続を維持します。

### `/grok:status`

リポジトリの実行中および最近の Grok ジョブと、レビューゲートの状態を表示します。

```bash
/grok:status
/grok:status --all
/grok:status <job-id> --wait
```

### `/grok:result`

完了したジョブの保存済み最終出力を表示します。

```bash
/grok:result
/grok:result <job-id>
```

各結果には Grok セッション ID と `grok --resume <id>` コマンドが含まれるため、Grok 独自の TUI で
会話を再開できます。

### `/grok:cancel`

実行中の追跡ジョブをキャンセルし、そのジョブで動いている Grok のターンを停止します。

```bash
/grok:cancel
/grok:cancel <job-id>
```

ジョブ ID を省略すると、現在のセッションで唯一実行中のジョブが選択されます。複数のジョブが
実行中の場合は推測で選ばずに停止し、ジョブ ID の指定を求めます。`/grok:status` で対象を
選んでください。

### `/grok:setup`

ローカル環境のインストール状態を確認し、必要に応じて終了時のレビューゲートを切り替えます。

```bash
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

ゲートは有効にするまで無効です。有効にすると、リポジトリを変更したアシスタントターンの終了時に
新しい adversarial review が実行され、その完了まで終了がブロックされます。変更のないターンや、
別のStopフックが継続させただけのターンではGrokを起動しません。大きな変更のレビューには時間が
かかる場合があります。`/grok:setup --disable-review-gate` で再び無効にできます。

## よくある使い方

### 出荷前にレビューする

```bash
/grok:review
```

指摘を読み、必要な箇所を修正してから、もう一度実行します。

### 問題を Grok に任せる

```bash
/grok:rescue the websocket reconnect drops messages under load
```

### 時間のかかる処理を実行する

```bash
/grok:rescue port the settings screen to the new form API
```

## Grok との通信方法

このプラグインは `grok agent stdio` を実行し、Agent Client Protocol を介して通信します。
貼り付けた差分を Grok に渡す方式ではなく、Grok 自身がリポジトリを読み取るため、実行中の
ツール呼び出しも確認できます。

同じリポジトリ内の実行は、小さなブローカーを介して 1 つの Grok プロセスを共有します。そのため、
レビューと委任タスクのたびに起動コストが発生することはありません。ブローカーへ接続できない場合は、
プラグインが独自の Grok プロセスを起動します。

### モデルの選択

このプラグインは既定で `grok-4.6` を指定します。1 回の実行だけ変更するには `--model` を、
すべての実行で変更するには `GROK_PLUGIN_MODEL` を設定してください。

これは見た目以上に重要です。`XAI_API_KEY` で認証した場合、Grok の新しいセッションでは既定で
推論を行わないモデルが使われ、レビューの品質が明確に低下するためです。

## よくある質問

### このプラグイン専用のアカウントは必要ですか？

いいえ。ローカル環境の Grok Build が現在サインインしているアカウントをそのまま使用します。

### 既存の Grok 設定は使用されますか？

はい。ただし 1 つ例外があります。レビューは MCP サーバーを接続せずに開始されるため、グローバルの
MCP 設定がレビューのたびに読み込まれてトークン数を増やすことはありません。委任された
`/grok:rescue` の実行では通常の設定が使用されます。

### `/grok:review` は本当に読み取り専用ですか？

Grok はファイルを読み、読み取り専用コマンドを実行できます。それ以外の権限要求は、読み取り専用の
許可リストにないシェルコマンドやファイルへの出力リダイレクトを含め、すべてプラグインによって
拒否されます。

### `/grok:transfer` がないのはなぜですか？

上流の Codex プラグインは Claude Code のセッションを Codex のタスクへ取り込めましたが、
Grok Build には同等の機能がありません。そのため、不完全な代替機能を装うのではなく、コマンドを
削除しています。

## ライセンス

Apache-2.0 です。[LICENSE](./LICENSE) と [NOTICE](./NOTICE) を参照してください。
