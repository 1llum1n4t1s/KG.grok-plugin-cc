---
name: source-command-audit
description: Ask Grok for a read-only audit of the entire repository, independent of the current diff.
disable-model-invocation: true
---

# Grok repository audit

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`audit` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept `--language <bcp47>` and optional focus text.
- Follow the shared foreground execution contract. Before the focus, reject `--background` and accept legacy `--wait` only as a no-op; within focus preserve both literally.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Preserve every other flag and the focus text exactly. Do not add audit criteria the user did not
  request.
- When no focus text is supplied, let the companion apply its built-in risk-directed deep-audit
  focus. An explicit focus narrows that deep audit to the requested subsystem or concern.
- While reading leading options, consume the first standalone `--` as the boundary and preserve everything after it as focus; a token needed as an option value remains a value, not a boundary. For example `--language ja -- --background` has literal focus `--background`. Never reinterpret a later `--` inside focus. Then construct the CLI argv as `flags -- <focus1argv>`.
- Interpret only leading known options and their values; the first unknown option or ordinary text starts the original focus. Never extract flags from inside it. Pass each target flag as a distinct argument, followed by `--` and the entire focus as one argument, for example `audit --language ja -- <focus1argv>`. Preserve quotes, repeated spaces, newlines, and trailing whitespace in that focus argument.
- Run `node <plugin-root>/scripts/grok-companion.mjs audit <arguments>`, using `bun --no-env-file` in place of `node` when available as specified in the shared runtime contract.
- Allow at least 600 seconds and wait silently on the same foreground process until it completes.
- Return completed stdout faithfully. Report failure or timeout; continue conversations in Grok itself.
