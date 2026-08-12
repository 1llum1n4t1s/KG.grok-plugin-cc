---
name: source-command-result
description: Show the stored final output of a finished Grok job. Use when the user invokes grok:source-command-result or asks to read a completed Grok result.
---

# Grok job result

Read [the shared runtime contract](../../references/codex-runtime.md), then run:

`node <plugin-root>/scripts/grok-companion.mjs result <optional-job-id>`

- Job IDs may contain only letters, digits, `.`, `_`, and `-`.
- Reproduce the complete command output, including findings, paths, line numbers, parse errors, and
  follow-up commands. Do not summarize or truncate it.
- If the job is still running, direct the user to `grok:source-command-status`; do not start a
  replacement job.
