---
name: grok-imagine-runtime
description: Generate an image with the Grok companion imagine command and copy it into the workspace.
user-invocable: false
---

Use this helper when another workflow needs a generated image. Run node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" imagine once in the foreground. On Windows, macOS, and Linux, use `bun --no-env-file` instead of `node` when Bun 1.4.4 or later is available; Node.js 22 or later remains supported. Run it in the target repository, allowing at least 600000 ms, and report failure or timeout without claiming completion.

Prefer `--json` and read `status` and `images[].saved` for the saved paths. Put options before the description, then `--`, then the description as one separately quoted argument; for multiline text, use --prompt-file <absolute-path> with a UTF-8 file and clean it up afterwards. Use `--cwd <path>` to choose the workspace, `--output <path>` only for a path inside that workspace, `--aspect <ratio>` only when a ratio is required, and `--image-model <id>` (generation) or `--image-edit-model <id>` (editing) only when the user or the workflow specifies an image model. Never invent an ID or reuse the generation ID for edits; `--effort` is not image quality. The JSON `requestedImageModel` is what was requested, not a confirmation of the model used. The default image model is `grok-imagine-image-2.0` (highest quality, also used for edits); `--image-model auto` or `--image-edit-model auto` leaves the choice to Grok (a user-set `GROK_IMAGE_*_MODEL_OVERRIDE` is still passed through). The default directory is `grok-imagine/`.

Do not pass `--write`. This command only copies generated images into the workspace. Grok decides the output format, and on Windows it is often JPEG, so read the saved path instead of assuming an extension. There is no dedicated option for a reference image: copy it inside the `--cwd` workspace and name its relative path in the description, and Grok reads it.

Subscription sign-in (`grok login`, no `XAI_API_KEY`) draws image generation from the account's shared weekly usage pool. If `XAI_API_KEY` is set, the companion stops until `--allow-api-billing` is present, because images are billed at xAI API rates instead of that pool. Do not add `--allow-api-billing` unless the user explicitly accepted that charge in this task.

A non-zero exit or a `status` other than completed, including `usage-balance-exhausted`, `image-entitlement-missing`, and `api-billing-required`, is a failure: report it with the stderr diagnostics and do not claim an image was saved.
