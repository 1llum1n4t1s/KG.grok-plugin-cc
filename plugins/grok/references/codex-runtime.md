# Codex runtime contract

Resolve the plugin root from the installed skill path and run node <plugin-root>/scripts/grok-companion.mjs in the user's repository. On Windows, macOS, and Linux, use `bun --no-env-file` instead of `node` when Bun 1.4.4 or later is available; Node.js 22 or later remains supported. Pass distinct arguments; do not use a second shell parser. For multiline task text, pass a UTF-8 file with --prompt-file <absolute-path> and clean it up according to the host's file policy. Do not expose credentials or configuration contents.

Each review, audit, or task runs once in the foreground with a new direct ACP connection to Grok. Do not detach or poll a separate job. Reject --background and treat legacy --wait as a no-op only before the focus; preserve both literally inside focus. Allow at least 600 seconds. In JSON mode reviews return reviewText and tasks return finalMessage. Return that completed output faithfully; report failure or timeout without claiming completion. Conversation continuation belongs to Grok itself; this plugin does not resume tasks or retrieve stored jobs.

For review, adversarial-review, and audit, interpret only leading known options and their values. The first unknown option or ordinary text starts the original focus; never extract flags from inside it. Pass target flags as distinct arguments, then `--` and the complete focus as one argument (for example `review --language ja -- <focus1argv>`). Preserve its quotes, repeated spaces, leading/trailing whitespace, and newlines.

Quote every argv, including the complete script path, for the actual shell. In Bash, enclose each value in single quotes and replace an embedded single quote with `'\''`. In PowerShell, enclose each value in single quotes and double embedded single quotes (`''`). Treat dollar signs, backticks, and `$()` as data. Do not use `eval` or interpolate raw task text into an executable shell line.

If setup or authentication is required, use grok:source-command-setup. A confirmed shell parser error occurs before Node starts and can be corrected; do not claim the request ran.

Known value flags are `--base`, `--scope`, `--model`, `--cwd`, `--language` (aliases `-m` for model and `-C` for cwd); boolean flags are `--json`, `--wait`, `--background`. Preserve supported `--key=value` forms. Forward recognized options unchanged; the companion decides how they apply.

While reading leading options, consume the first standalone `--` as the boundary and preserve everything after it as focus; a token needed as an option value remains a value, not a boundary. For example `--language ja -- --background` has literal focus `--background`. Never reinterpret a later `--` inside focus. Then construct the CLI argv as `flags -- <focus1argv>`.
