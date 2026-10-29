---
name: source-command-setup
description: Check Grok Build installation and authentication.
---

# Grok setup

Read [the shared runtime contract](../../references/codex-runtime.md), then run node <plugin-root>/scripts/grok-companion.mjs setup --json. Present all checks faithfully. If Grok is missing, use the install guidance from the helper; if agent stdio is unavailable, suggest grok update; if authentication is missing, preserve its login guidance. Do not install or authenticate automatically.
