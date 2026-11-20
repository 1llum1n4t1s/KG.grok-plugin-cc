---
name: source-command-imagine
description: Explicitly ask Grok Build to generate an image and save it in the workspace.
disable-model-invocation: true
---

# Imagine with Grok

Read [the shared runtime contract](../../references/codex-runtime.md). Require an image description. Run node <plugin-root>/scripts/grok-companion.mjs imagine --json once in the foreground, using `bun --no-env-file` in place of `node` when available as specified in that contract. Preserve the description language and any explicit --model, --effort, --aspect, --output, --image-model, and --image-edit-model values. Never invent an image model ID or reuse the generation ID for edits. The default image model is `grok-imagine-image-2.0` (highest quality, also used for edits); `--image-model auto` or `--image-edit-model auto` leaves the choice to Grok (a user-set `GROK_IMAGE_*_MODEL_OVERRIDE` is still passed through). Do not pass --write. Use --prompt-file for multiline text. Put options before the description, then `--`, then the description as one argument.

Subscription sign-in (`grok login`, no XAI_API_KEY) draws image generation from the shared weekly usage pool. If XAI_API_KEY is set, the companion refuses until `--allow-api-billing` is present, because images are billed at xAI API rates (grok-imagine-image-2.0 is listed from $0.04/img). Do not add `--allow-api-billing` unless the user already supplied it or explicitly accepts that charge in this turn. Show the billing notice and saved paths from the JSON (`billing`, `images`). If the result classifies `image-entitlement-missing` or `usage-balance-exhausted`, return that guidance and do not claim an image was saved. Return failure or timeout without claiming completion. For conversation continuation, direct the user to Grok itself.
