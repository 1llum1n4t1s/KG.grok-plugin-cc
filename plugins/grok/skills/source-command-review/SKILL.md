---
name: source-command-review
description: Run a read-only Grok review of local git changes. Use when the user invokes grok:source-command-review or asks Grok to review the working tree or branch diff.
---

# Grok code review

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`review` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`,
  `--language <bcp47>`, and optional focus text.
- If neither execution flag is present, add `--background` unless the review is clearly limited to
  one or two small files; for a clearly tiny review, add `--wait`.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Preserve the user's target flags and focus text exactly.
- Run `node <plugin-root>/scripts/grok-companion.mjs review <arguments>`.
- For a background launch, return the launch output and job ID, then stop without polling.
- For `--wait`, allow at least 600 seconds, then run the companion's `result` command and reproduce
  the stored report verbatim, without commentary before or after it.
- If the call times out, do not rerun it; direct the user to `grok:source-command-status` and
  `grok:source-command-result`.
