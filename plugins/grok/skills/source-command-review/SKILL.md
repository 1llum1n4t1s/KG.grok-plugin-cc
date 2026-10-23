---
name: source-command-review
description: Ask Grok to review working-tree changes or a branch diff, read-only.
---

# Grok code review

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`review` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept `--base <ref>`, `--scope auto|working-tree|branch`, `--language <bcp47>`, and optional focus text.
- Follow the shared foreground execution contract. Reject `--background`; accept legacy `--wait` only as a no-op.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Preserve the user's target flags and focus text exactly apart from a removed legacy `--wait`.
- Run `node <plugin-root>/scripts/grok-companion.mjs review --json <arguments>`.
- Allow at least 600 seconds and wait silently on the same foreground process until it completes.
- After any completed run, run the companion's `result <job-id>` command and reproduce the stored
  report verbatim, without commentary before or after it.
- If the call times out, do not rerun it; direct the user to `grok:source-command-status` and
  `grok:source-command-result`.
