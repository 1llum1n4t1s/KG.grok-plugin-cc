# Changelog

## 1.0.3

- Fixed `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, and `/grok:x` still returning
  noisy or missing output when run in the foreground. The 1.0.2 fix only rewired the background
  flow; foreground runs kept treating the `Bash` call's own merged stdout/stderr as the report, so
  progress lines (`[grok] Tool: ...`) and Node warnings still leaked in, and some runs answered with
  a pointer or a summary instead of the report itself. Foreground now reads the finished job back
  with `grok-companion.mjs result`, exactly like the background flow, and each command spells out
  that the report only reaches the user through the assistant's own reply, verbatim, in full.

## 1.0.2

- Fixed background `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, and `/grok:x` runs
  returning noisy output: Claude Code merges a background task's stdout and stderr into a single
  file, so the companion's own progress lines (`[grok] Tool: ...`) and any Node warnings landed
  ahead of the report when that file was read back. The commands now read the finished job's
  stored report with `grok-companion.mjs result` instead, which returns the rendered output only.
- Stopped emitting Node's `DEP0190` deprecation warning on every `grok` and `grok agent stdio`
  spawn on Windows. Passing an argument array together with `shell: true` triggered the warning on
  Node 22+; the plugin now folds the command and arguments into a single shell-safe string instead.

## 0.1.0

- First release of the Grok plugin, forked from `openai/codex-plugin-cc` and retargeted from the
  OpenAI Codex CLI to xAI's Grok Build CLI.
- Talks to Grok over the Agent Client Protocol (`grok agent stdio`) instead of the Codex app-server
  protocol, so Grok reads the repository itself and its tool calls stream back live.
- `/grok:review` and `/grok:adversarial-review` run read-only, schema-constrained reviews. Read-only
  access is enforced by allowlisting the commands Grok is permitted to run, and the plugin asks Grok
  to re-emit its answer once if the structured output does not parse.
- `/grok:review` now accepts focus text, which the upstream plugin could not because it delegated to
  Codex's built-in reviewer.
- Added `/grok:audit`, which audits the entire existing codebase instead of a diff. The audit
  context is only a file inventory; Grok reads the files it inspects itself with read-only
  commands.
- Review, adversarial-review, and audit findings now follow the sender's language: the slash
  commands forward the conversation language via `--language <bcp47>`, with a fallback to the
  focus text's language and then English. The rescue path keeps the task text in the user's
  original language instead of translating it. Upstream always answered in English because every
  prompt Codex saw was English with no language directive.
- Removed `/codex:transfer`; Grok Build has no equivalent of Codex's Claude session import.
- Added `GROK_COMPANION_DISABLE_BROKER` to bypass the shared broker, and `GROK_PLUGIN_MODEL` to set
  the default model.
