---
name: source-command-adversarial-review
description: Read-only Grok review challenging the approach, design, and ship-or-no-ship decision.
---

# Grok adversarial review

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`adversarial-review` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept the same flags as `grok:source-command-review` and preserve any focus text exactly.
- Follow its platform restrictions: `auto` and `working-tree` require Windows and a complete safe snapshot. On macOS/Linux, explicitly use `--scope branch` or `--base <ref>` for committed changes; uncommitted changes are excluded from the comparison diff, but surrounding files may still be read from the working tree. Use `grok:source-command-audit` for a whole-repository review on any platform.
- Follow the shared foreground execution contract. Before the focus, reject `--background` and accept legacy `--wait` only as a no-op; within focus preserve both literally.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Do not weaken or supplement the adversarial framing.
- While reading leading options, consume the first standalone `--` as the boundary and preserve everything after it as focus; a token needed as an option value remains a value, not a boundary. For example `--language ja -- --background` has literal focus `--background`. Never reinterpret a later `--` inside focus. Then construct the CLI argv as `flags -- <focus1argv>`.
- Interpret only leading known options and their values; the first unknown option or ordinary text starts the original focus. Never extract flags from inside it. Pass each target flag as a distinct argument, followed by `--` and the entire focus as one argument, for example `adversarial-review --language ja -- <focus1argv>`. Preserve quotes, repeated spaces, newlines, and trailing whitespace in that focus argument.
- Run `node <plugin-root>/scripts/grok-companion.mjs adversarial-review <arguments>`, using `bun --no-env-file` in place of `node` when available as specified in the shared runtime contract.
- Allow at least 600 seconds and wait silently on the same foreground process until it completes.
- Return completed stdout faithfully. Report failure or timeout; continue conversations in Grok itself.
