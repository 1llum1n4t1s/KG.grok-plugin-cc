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
- `/grok:status`, `/grok:result`, and `/grok:cancel` to manage background jobs
- `/grok:setup` to check that everything is wired up

## Requirements

- **Grok Build**, signed in with a SuperGrok or X Premium+ account, or an `XAI_API_KEY`.
  Usage counts against whichever one you use.
- **Node.js 18.18 or later**

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
  `/grok:setup --enable-review-gate`, ending a Claude session runs a fresh review
  first and can block until it finishes. Turn it back off with
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
/grok:review --wait
/grok:review --background
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

Without `--wait` or `--background`, Claude estimates the size of the change and asks which mode
you want.

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
/grok:audit --background
/grok:audit focus on the auth module
```

The audit context deliberately contains no diff and no file contents, only a file inventory; Grok
reads the files it decides to inspect with read-only commands. That makes an audit noticeably more
token-hungry than a diff review, and a focus is strongly recommended on large repositories so the
audit stays deep instead of broad.

The same read-only guarantees as `/grok:review` apply.

### `/grok:rescue`

Hands a problem to Grok and returns its answer. This is the command for "I am stuck, get another
set of eyes on it."

```bash
/grok:rescue why does the upload retry loop never terminate?
/grok:rescue --background investigate the flaky auth test
/grok:rescue --resume
/grok:rescue --model latest --effort high
```

Unlike the review commands, `/grok:rescue` runs write-capable by default, so Grok can edit files
while it works. Say so in the request when you only want diagnosis — "read-only", "just
investigate", "don't change anything" — and the run stays read-only.

Model aliases: `fast`, `reasoning`, `multi`, `build`, `latest`. Anything else is passed through as
a model ID, so `--model grok-4.5` works too. `--effort` accepts `low`, `medium`, or `high`.

### `/grok:x`

Searches X (Twitter) posts through Grok Build and returns the findings with author handles, dates,
and post URLs. Grok Build reaches X with its own `x_keyword_search` and `x_semantic_search` tools,
so this works with the same `grok login` credentials as every other command — no xAI API key needed.
Ordinary web search cannot read X timelines, which is why this is a separate command.

```bash
/grok:x what are people saying about the latest Avalonia release
/grok:x --background reports of regressions in Node 24 over the past week
/grok:x --model latest reaction to the new pricing announcement
```

The run is always read-only. A search drives a full Grok Build session, so it usually takes a few
minutes; pass `--background` when you would rather not wait.

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

Cancels a running background job and stops the Grok turn behind it.

```bash
/grok:cancel
/grok:cancel <job-id>
```

### `/grok:setup`

Checks the local install and optionally toggles the stop-time review gate.

```bash
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

The gate is off unless you enable it. With it enabled, ending a Claude session triggers a fresh
adversarial review and blocks until that review finishes, so session exit can take a while on a
large change. Turn it back off with `/grok:setup --disable-review-gate`.

## Typical Flows

### Review before shipping

```bash
/grok:review --wait
```

Read the findings, fix what matters, then run it again.

### Hand a problem to Grok

```bash
/grok:rescue the websocket reconnect drops messages under load
```

### Start something long-running

```bash
/grok:rescue --background port the settings screen to the new form API
/grok:status
/grok:result
```

## How It Talks To Grok

The plugin runs `grok agent stdio` and speaks the Agent Client Protocol to it. That means Grok
reads your repository itself rather than being handed a pasted diff, and you see its tool calls as
they happen.

Runs in the same repository share one Grok process through a small broker, so a review and a
delegated task do not each pay startup cost. If the broker is unreachable the plugin falls back to
starting its own Grok process.

### Choosing a model

The plugin asks for `grok-4.5` by default. Override it for a single run with `--model`, or for
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
