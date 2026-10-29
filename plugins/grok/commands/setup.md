---
description: Check Grok Build installation and authentication
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup and report all checks faithfully. Follow the helper’s install and login guidance; do not install or authenticate automatically.

Run in the user’s repository, allowing at least 600000 ms for a task. Report failure or timeout without claiming completion.
