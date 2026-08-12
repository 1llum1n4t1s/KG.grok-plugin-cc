---
name: source-command-cancel
description: Cancel an active background Grok job for the current repository. Use when the user invokes grok:source-command-cancel or explicitly asks to stop a Grok job.
---

# Cancel a Grok job

Read [the shared runtime contract](../../references/codex-runtime.md), then run:

`node <plugin-root>/scripts/grok-companion.mjs cancel <optional-job-id>`

- Job IDs may contain only letters, digits, `.`, `_`, and `-`.
- If no ID is supplied, let the companion select the latest active job.
- Reproduce the cancellation output verbatim.
- Do not cancel any job unless the user explicitly asked to stop it.
