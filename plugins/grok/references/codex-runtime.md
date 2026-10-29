# Codex runtime contract

Resolve the plugin root from the installed skill path and run node <plugin-root>/scripts/grok-companion.mjs in the user's repository. Pass distinct arguments; do not use a second shell parser. For multiline task text, pass a UTF-8 file with --prompt-file <absolute-path> and clean it up according to the host's file policy. Do not expose credentials or configuration contents.

Each review, audit, or task runs once in the foreground with a new direct ACP connection to Grok. Do not detach or poll a separate job. Reject --background; legacy --wait is a no-op. Allow at least 600 seconds. In JSON mode reviews return reviewText and tasks return finalMessage. Return that completed output faithfully; report failure or timeout without claiming completion. Conversation continuation belongs to Grok itself; this plugin does not resume tasks or retrieve stored jobs.

If setup or authentication is required, use grok:source-command-setup. A confirmed shell parser error occurs before Node starts and can be corrected; do not claim the request ran.
