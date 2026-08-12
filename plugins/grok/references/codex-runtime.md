# Codex runtime contract

- Resolve the plugin root from the installed path of the selected `SKILL.md`: ascend from
  `skills/<skill>/SKILL.md` to the plugin root. If `PLUGIN_ROOT` is set, it may be used after
  confirming that it contains `scripts/grok-companion.mjs`.
- Run `node <plugin-root>/scripts/grok-companion.mjs ...` in the user's current repository. Do not
  invoke `grok` directly or reimplement the companion's authentication, job tracking, or safety
  checks.
- Pass arguments as distinct shell arguments. Never use `Invoke-Expression`, `eval`, or another
  second shell parser to interpolate user text.
- Do not expose environment variables, credentials, or the contents of Grok configuration files.
- When the companion says setup or authentication is required, stop and direct the user to the
  `grok:source-command-setup` skill. Do not improvise another authentication flow.
- Tool output is not automatically visible to the user. Copy the required companion output into the
  response according to the selected skill's output rules.
