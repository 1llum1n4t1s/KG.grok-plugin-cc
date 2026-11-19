[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Grok plugin for Claude Code and Codex

Run Grok Build from Claude Code or Codex for code reviews, repository audits, X searches, delegated tasks, and image generation. This project is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see [NOTICE](NOTICE).

## Requirements and installation

Install [Grok Build](https://x.ai/cli), sign in or configure its API key, and install Git 2.45 or later (or a Git build with backported `--no-lazy-fetch`). On Windows, macOS, and Linux, install Bun 1.4.4 or later or Node.js 22 or later; Bun is preferred when both are available. Grok usage is charged to the account or API key used. Grok must support `grok agent stdio`; update it with `grok update` if needed.

On Windows, the plugin includes native helpers for ia32, x64, and arm64 runtimes. No Rust or MSVC installation is required.

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

### Updates

Claude Code turns auto-update off by default for third-party marketplaces such as `kagayoi-grok`. To turn it on, run `/plugin` in a Claude Code session, open the **Marketplaces** tab, select `kagayoi-grok`, and choose **Enable auto-update**. Claude Code then refreshes the marketplace after a session starts and updates the installed plugin; run `/reload-plugins` or start a new session to load the new version. To update immediately instead, run `claude plugin update grok@kagayoi-grok` in your shell.

For Codex, run `codex plugin marketplace upgrade kagayoi-grok` to refresh the marketplace, then start a new Codex task.

## Commands

Claude Code exposes `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:imagine`, `/grok:rescue`, `/grok:x`, and `/grok:setup`. In Codex, select the corresponding `grok:source-command-<name>` skill. Review and audit are read-only; rescue can request edits, while X search stays read-only. `/grok:imagine <description>` asks Grok Build to generate an image and copies it into `grok-imagine/` in the workspace, or into `--output <path>` when that path stays inside the workspace. It does not otherwise edit the repository. With `grok login`, generation uses the subscription's shared weekly usage pool. When `XAI_API_KEY` is set, the command stops until `--allow-api-billing` is passed: API images are billed at xAI rates (`grok-imagine-image-2.0` is listed from $0.04/img) instead of that pool. Setup checks Grok authentication.

On Windows, use `/grok:review --scope working-tree` to review local changes. The `auto` and `working-tree` scopes require a complete safe Windows snapshot and fail if it cannot be collected. On macOS/Linux, explicitly use `/grok:review --scope branch` or `--base <ref>` to review committed changes; uncommitted changes are excluded from the comparison diff, but surrounding files may still be read from the working tree. Use `/grok:audit authentication` to focus a whole-repository audit on any platform, or `/grok:rescue <task>` to delegate a task. Review, adversarial review, and audit also accept `--language <BCP 47 tag>`. Run `/grok:setup` when installation or authentication fails; follow its reported error and Grok’s login guidance.

Each invocation runs a new Grok session in the foreground and returns its result directly. Use Grok's own interface to continue a conversation. Automatic reviews and the former status, result, cancel, state-lock, and task-resume commands are no longer supported by the companion.

The companion starts the locally installed Grok CLI. It checks paths on ACP file requests and applies a read-only permission allowlist; explicitly requested write tasks can modify the workspace. Grok Build handles its built-in filesystem and shell operations, external access, and authentication. The companion does not mediate every I/O operation or provide an OS sandbox, and does not guarantee complete access isolation, including through symlinks. Review Grok's output and changes before relying on them.

## Display language

The companion's own messages (setup results, review headings, diagnostics, and help) are shown in the language of your environment. It checks `GROK_PLUGIN_LANGUAGE`, then `LC_ALL`, `LC_MESSAGES`, and `LANG`, then the system display language, and falls back to English. Supported languages are `ja`, `en`, `zh-CN`, `zh-TW`, `ko`, `es`, `fr`, `de`, and `pt-BR`. This is separate from `--language`, which sets the language of Grok's review text. Grok's own output and error details from the OS or Grok are not translated.

## Troubleshooting

If an invocation reports HTTP 402 with `usage balance exhausted`, Grok Build's usage balance is exhausted. Retry after that balance recovers. Subscription image generation draws from that same shared pool. If image generation reports that Grok Build's image tools need a SuperGrok subscription, this sign-in does not include Imagine; use a plan that includes it, or an API key with `--allow-api-billing`. A timeout, permission denial, incomplete review, or unconfirmed agent stop is a failed invocation; do not treat partial output as a completed review or task.

During read-only reviews and read-only tasks (`task` without `--write`), Python, Node.js, Bun, and shell wrappers are denied even for scripts intended only to read files. Grok Build can end the turn with `cancelled` after a permission rejection. Use built-in file tools to inspect JSON and other evidence; unavailable evidence remains unverified. The review prompt, and the guidance appended after your request in a read-only task, supply these restrictions before inspection starts.

For source builds, development commands, and validation, see [Development](CONTRIBUTING.md#english). Runtime structure and boundaries are described in [DESIGN.md](DESIGN.md).
