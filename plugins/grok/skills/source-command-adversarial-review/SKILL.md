---
name: source-command-adversarial-review
description: Run a read-only Grok review that challenges the implementation approach and design choices. Use for grok:source-command-adversarial-review or a skeptical ship-or-no-ship review.
---

# Grok adversarial review

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`adversarial-review` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept the same flags as `grok:source-command-review` and preserve any focus text exactly.
- If neither `--wait` nor `--background` is present, add `--background` unless the review is clearly
  tiny.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Do not weaken or supplement the adversarial framing.
- Run `node <plugin-root>/scripts/grok-companion.mjs adversarial-review <arguments>`.
- For a background launch, return the launch output and job ID, then stop without polling.
- For `--wait`, allow at least 600 seconds, then run the companion's `result` command and reproduce
  the stored report verbatim, without commentary before or after it.
- If the call times out, do not rerun it; direct the user to `grok:source-command-status` and
  `grok:source-command-result`.
