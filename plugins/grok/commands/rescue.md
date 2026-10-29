---
description: Delegate a concrete task to Grok Build
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw slash-command arguments: `$ARGUMENTS`. Require a concrete task and pass the user’s task text. Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task once in the foreground, passing the task and explicit model or effort. Use --write for requested edits; omit it for read-only work. Return completed stdout faithfully. To continue a conversation, use Grok itself.

Run in the user’s repository, allowing at least 600000 ms for a task. Report failure or timeout without claiming completion.
