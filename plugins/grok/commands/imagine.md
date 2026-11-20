---
description: Generate an image with Grok Build
argument-hint: '[--output <path>] [--aspect <ratio>] [--image-model <id>] [--image-edit-model <id>] [--allow-api-billing] [description ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(bun:*)
---

Raw slash-command arguments: `$ARGUMENTS`. Require an image description and pass the user’s text unchanged. Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" imagine once in the foreground. On Windows, macOS, and Linux use `bun --no-env-file` instead of `node` when Bun 1.4.4 or later is available; otherwise use Node.js 22 or later. Put options before the description, then `--`, then the description as one separately quoted argument; for multiline text, write it to a UTF-8 file and pass --prompt-file <absolute-path> instead, then clean it up.

Do not pass `--write`. This command only copies generated images into the workspace. The default directory is `grok-imagine/`. Forward `--output <path>` when the user names a path inside the workspace, and `--aspect <ratio>` only when the user names one. Forward `--image-model <id>` and `--image-edit-model <id>` only when the user names an image model; never invent an ID, and never reuse the generation ID for edits. The default image model is `grok-imagine-image-2.0` (highest quality, also used for edits); `--image-model auto` or `--image-edit-model auto` leaves the choice to Grok (a user-set `GROK_IMAGE_*_MODEL_OVERRIDE` is still passed through).

Subscription sign-in (`grok login`, no `XAI_API_KEY`) draws image generation from the account's shared weekly usage pool. If `XAI_API_KEY` is set, the companion stops until `--allow-api-billing` is present, because images are billed at xAI API rates (`grok-imagine-image-2.0` is listed from $0.04/img) instead of that pool. Do not add `--allow-api-billing` unless the user already passed it or explicitly accepts that charge in this turn.

Return completed stdout faithfully, including the billing notice and saved paths, and also return diagnostic lines from stderr. A non-zero exit, including `usage-balance-exhausted` and `image-entitlement-missing`, is a failure: do not claim an image was saved. To continue a conversation, use Grok itself.

Run in the user’s repository, allowing at least 600000 ms. Report failure or timeout without claiming completion.
