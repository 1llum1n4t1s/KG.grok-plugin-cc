---
name: source-command-audit
description: Run a read-only Grok audit of the entire existing repository, ignoring the current diff. Use when the user invokes grok:source-command-audit or asks Grok to audit the whole codebase.
---

# Grok repository audit

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`audit` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept `--language <bcp47>` and optional focus text.
- Follow the shared foreground execution contract. Reject `--background`; accept legacy `--wait` only as a no-op and never treat it as audit focus.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Preserve every other flag and the focus text exactly. Do not add audit criteria the user did not
  request.
- When no focus text is supplied, let the companion apply its built-in risk-directed deep-audit
  focus. An explicit focus narrows that deep audit to the requested subsystem or concern.
- Run `node <plugin-root>/scripts/grok-companion.mjs audit <arguments>`.
- Allow at least 600 seconds and surface concise progress.
- After any completed run, run the companion's `result <job-id>` command and reproduce the stored
  report verbatim, without commentary before or after it.
- If the call times out, do not rerun it; direct the user to `grok:source-command-status`
  and `grok:source-command-result`.
