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

## Codex-managed background execution

These rules apply only when `source-command-review`, `source-command-adversarial-review`,
`source-command-audit`, `source-command-rescue`, or `source-command-x` starts a new long-running
review or task. They do not change `source-command-status --wait` or any other command's flags.

- Treat `--wait` and `--background` as Codex-side execution controls. Remove the selected control
  before constructing the companion arguments so it cannot become task or focus text.
- Do not pass `--background` to the companion. Do not use `Start-Process`, shell `&`, or another
  detached-child workaround; those bypass Codex process tracking.
- For background mode, run the companion without either execution control by using the shell tool's
  native managed background or yielded-process mechanism. The command must remain attached to Codex
  so its running state is visible in the current task.
- Read the managed process's startup output until both the Codex process or cell ID and the
  companion's `[grok] Job ID: <job-id>` line are available. Use that emitted ID directly; never infer
  it from the ordering or set difference of global status output.
- Run `status <job-id>` once and copy its status, phase, elapsed time, summary, and available progress
  preview into the response with both IDs, then stop without polling. If the managed process finishes
  before this startup handshake completes, treat it as a completed foreground run and use the
  emitted job ID to obtain the result.
- When Codex reports that the managed process finished, run the companion's `result <job-id>` command
  and return its complete output according to the invoking skill's output rules.
- If the shell tool cannot create a Codex-managed background process, do not silently fall back to
  the companion's detached background mode. Explain the limitation and ask whether to wait instead.
- For foreground mode, run the companion without either execution control, capture the emitted Grok
  job ID, and use the timeout, progress, and final-output rules from the invoking skill.
