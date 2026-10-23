---
name: source-command-adversarial-review
description: Read-only Grok review challenging the approach, design, and ship-or-no-ship decision.
---

# Grok adversarial review

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`adversarial-review` subcommand. This workflow is review-only: do not fix findings or edit files.

- Accept the same flags as `grok:source-command-review` and preserve any focus text exactly.
- Follow the shared foreground execution contract. Reject `--background`; accept legacy `--wait` only as a no-op.
- Unless supplied, add `--language` for the conversation language before the focus text.
- Do not weaken or supplement the adversarial framing.
- Run `node <plugin-root>/scripts/grok-companion.mjs adversarial-review --json <arguments>`.
- Allow at least 600 seconds and wait silently on the same foreground process until it completes.
- After any completed run, run the companion's `result <job-id>` command and reproduce the stored
  report verbatim, without commentary before or after it.
- If the call times out, do not rerun it; direct the user to `grok:source-command-status` and
  `grok:source-command-result`.
