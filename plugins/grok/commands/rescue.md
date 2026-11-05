---
description: Delegate a concrete task to Grok Build
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(bun:*)
---

Raw slash-command arguments: `$ARGUMENTS`. Require a concrete task and pass the user’s task text. Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task once in the foreground, passing the task and explicit model or effort. On Windows, macOS, and Linux use `bun --no-env-file` instead of `node` when Bun 1.4.4 or later is available; otherwise use Node.js 22 or later. Use --write for requested edits; omit it for read-only work. Return completed stdout faithfully. To continue a conversation, use Grok itself.

Run in the user’s repository, allowing at least 600000 ms for a task. Report failure or timeout without claiming completion.
