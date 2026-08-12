---
name: source-command-audit
description: Run a read-only Grok audit of the entire existing repository, ignoring the current diff. Use when the user invokes grok:source-command-audit or asks Grok to audit the whole codebase.
---

# Grok repository audit

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`audit` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept `--wait`, `--background`, `--language <bcp47>`, and optional focus text.
- If neither execution flag is present, add `--background`; full-repository audits are normally long.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Preserve the focus text exactly. Do not add audit criteria the user did not request.
- Run `node <plugin-root>/scripts/grok-companion.mjs audit <arguments>`.
- For a background launch, return the launch output and job ID, then stop without polling.
- For `--wait`, allow at least 600 seconds. After completion, run the companion's `result` command
  and reproduce that stored report verbatim, without commentary before or after it.
- If a foreground call times out, do not rerun it; direct the user to `grok:source-command-status`
  and `grok:source-command-result`.
