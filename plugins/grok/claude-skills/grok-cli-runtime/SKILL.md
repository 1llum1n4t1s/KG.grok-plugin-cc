---
name: grok-cli-runtime
description: Run a foreground Grok companion task.
user-invocable: false
---

Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task once in the foreground. On Windows, macOS, and Linux, use `bun --no-env-file` instead of `node` when Bun 1.4.4 or later is available; Node.js 22 or later remains supported. Pass the concrete task, an explicit model or effort when requested, and --write only for requested edits. Return completed stdout faithfully and report failure. Grok itself owns conversation continuation; plugin task resumption is unavailable.
