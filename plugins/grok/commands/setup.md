---
description: Check Grok Build installation and authentication
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(bun:*)
---

Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup and report all checks faithfully. On Windows, macOS, and Linux use `bun --no-env-file` instead of `node` when Bun 1.4.4 or later is available; otherwise use Node.js 22 or later. Follow the helper’s install and login guidance; do not install or authenticate automatically.

Run in the user’s repository, allowing at least 600000 ms for a task. Report failure or timeout without claiming completion.
