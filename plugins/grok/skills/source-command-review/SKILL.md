---
name: source-command-review
description: Run a read-only Grok review of local git changes. Use when the user invokes grok:source-command-review or asks Grok to review the working tree or branch diff.
---

# Grok code review

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`review` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`,
  `--language <bcp47>`, and optional focus text.
- If neither execution flag is present, select Codex-managed background mode and start immediately.
  Honor explicit `--wait` as foreground mode and explicit `--background` as background mode.
- Follow the shared Codex-managed background execution contract for the selected mode.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Preserve the user's target flags and focus text exactly apart from the execution control removed
  by the shared contract.
- Run `node <plugin-root>/scripts/grok-companion.mjs review <arguments>`.
- For foreground mode, allow at least 600 seconds and surface concise progress.
- After any completed run, run the companion's `result <job-id>` command and reproduce the stored
  report verbatim, without commentary before or after it.
- If the call times out, do not rerun it; direct the user to `grok:source-command-status` and
  `grok:source-command-result`.
