---
name: source-command-setup
description: Check Grok Build installation and authentication or toggle the stop-time review gate. Use for grok:source-command-setup and Grok plugin environment diagnostics.
---

# Grok setup

Read [the shared runtime contract](../../references/codex-runtime.md), then run:

`node <plugin-root>/scripts/grok-companion.mjs setup --json <arguments>`

- Accept only `--enable-review-gate` and `--disable-review-gate` as user-facing arguments.
- Present the setup output faithfully; do not hide failed checks.
- If Grok Build is missing, point to the official x.ai installer commands reported by the helper.
- If `grok agent stdio` is unavailable, tell the user to run `grok update`.
- If authentication is missing, preserve the helper's `grok login` and `XAI_API_KEY` guidance.
- Do not install or update Grok Build automatically.

