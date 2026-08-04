---
description: Show the stored final output for a finished Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show the stored result for the job the user named, or the most recent finished one if they named none.

- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "<job-id>"
```
- Substitute the job id the user typed. It is a plain identifier: letters, digits, `.`, `_`, and `-` only.
- If what the user typed contains anything else, do not build the command. Tell them it is not a job id and run `/grok:status` instead.

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/grok:status <id>` and `/grok:review`
