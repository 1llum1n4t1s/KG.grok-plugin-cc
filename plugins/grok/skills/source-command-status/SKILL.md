---
name: source-command-status
description: Show active/recent Grok jobs and the current repository's review-gate status.
---

# Grok job status

Read [the shared runtime contract](../../references/codex-runtime.md), then run:

`node <plugin-root>/scripts/grok-companion.mjs status <arguments>`

- Accept an optional job ID and `--wait`, `--timeout-ms <ms>`, and `--all`.
- Job IDs may contain only letters, digits, `.`, `_`, and `-`.
- Without a job ID, present the command output as one compact Markdown table.
- With a job ID, reproduce the full status output without summarizing it.
