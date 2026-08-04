---
description: Check whether the local Grok Build is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

Grok Build installs from x.ai, not from a package registry, so do not offer to install it
with a package manager.

If the result reports that Grok Build is not installed:
- Tell the user to install it themselves and give the command for their platform:
  - Windows: `irm https://x.ai/cli/install.ps1 | iex`
  - macOS and Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
- Then have them rerun `/grok:setup`.

If the result reports that Grok Build is installed but `grok agent stdio` is unavailable:
- Tell the user to update it with `!grok update`, then rerun `/grok:setup`.

If the result reports that Grok Build is installed but not authenticated:
- Preserve the guidance from the setup output. It offers two paths:
  - `!grok login` for a SuperGrok or X Premium+ account.
  - Setting `XAI_API_KEY` for headless or metered use, which takes precedence over browser credentials.

Output rules:
- Present the final setup output to the user.
- Do not paraphrase the check results; report the status lines as returned.
