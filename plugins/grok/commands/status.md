---
description: Show active and recent Grok jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show job status for this repository.

- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "<arguments>"
```
- Substitute what the user typed: an optional job id plus any of `--wait`, `--timeout-ms <ms>`, `--all`.
- A job id is a plain identifier: letters, digits, `.`, `_`, and `-` only. If the user typed anything that is not a job id or one of those flags, drop it rather than passing it through.

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
