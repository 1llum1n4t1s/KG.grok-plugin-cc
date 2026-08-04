# Changelog

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
