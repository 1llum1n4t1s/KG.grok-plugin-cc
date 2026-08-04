---
description: Cancel an active background Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Cancel the job the user named, or the most recent active one if they named none.

- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "<job-id>"
```
- Substitute the job id the user typed. It is a plain identifier: letters, digits, `.`, `_`, and `-` only.
- If what the user typed contains anything else, do not build the command. Tell them it is not a job id and run `/grok:status` instead.
- Return the command output verbatim.
