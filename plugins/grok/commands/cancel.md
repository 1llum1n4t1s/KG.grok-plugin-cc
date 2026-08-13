---
description: Cancel an active background Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Cancel the job the user named. If they named none, let the companion cancel the only active job in
the current session. When multiple jobs are active, require a job id instead of choosing one.

- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "<job-id>"
```
- Substitute the job id the user typed. It is a plain identifier: letters, digits, `.`, `_`, and `-` only.
- If what the user typed contains anything else, do not build the command. Tell them it is not a job id and run `/grok:status` instead.
- If no job id was supplied, do not select a job yourself. The companion handles the safe
  single-active-job default and reports when the user must disambiguate with `/grok:status`.
- Return the command output verbatim.
