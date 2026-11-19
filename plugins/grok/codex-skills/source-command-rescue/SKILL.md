---
name: source-command-rescue
description: Explicitly delegate investigation, fixes, or a second opinion to Grok Build.
disable-model-invocation: true
---

# Grok rescue

Read [the shared runtime contract](../../references/codex-runtime.md). Require a concrete task and invoke node <plugin-root>/scripts/grok-companion.mjs task --json once in the foreground, using `bun --no-env-file` in place of `node` when available as specified in that contract. Preserve the task language and explicit --model and --effort values (low, medium, high). Use --write for requested edits; omit it for review, diagnosis, or research. Use --prompt-file for multiline text. Return finalMessage faithfully. For conversation continuation, direct the user to Grok itself.
