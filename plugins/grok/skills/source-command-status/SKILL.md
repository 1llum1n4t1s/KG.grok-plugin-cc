---
name: source-command-status
description: Show active and recent Grok jobs and review-gate status for the current repository. Use when the user invokes grok:source-command-status or asks about Grok job progress.
---

# Grok job status

Read [the shared runtime contract](../../references/codex-runtime.md), then run:

`node <plugin-root>/scripts/grok-companion.mjs status <arguments>`

- Accept an optional job ID and `--wait`, `--timeout-ms <ms>`, and `--all`.
- Job IDs may contain only letters, digits, `.`, `_`, and `-`.
- Without a job ID, present the command output as one compact Markdown table.
- With a job ID, reproduce the full status output without summarizing it.
