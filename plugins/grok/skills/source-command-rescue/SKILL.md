---
name: source-command-rescue
description: Delegate investigation, implementation, or follow-up work to Grok Build. Use when the user invokes grok:source-command-rescue or explicitly asks Grok for a second opinion or fix.
---

# Grok rescue

Read [the shared runtime contract](../../references/codex-runtime.md), then invoke the companion's
`task` subcommand exactly once. Do not inspect the repository or solve the delegated task yourself.

- Require a concrete task unless the user explicitly asks to resume the previous Grok task.
- Preserve explicit `--model` and `--effort` values. Accepted effort values are `low`, `medium`, and
  `high`.
- Map `--resume` to `--resume-last`; preserve `--fresh`. Strip `--wait` because foreground is the
  default. Pass `--background` through to the companion.
- Default to `--write`, unless the user asks for review, diagnosis, research, or other read-only work.
- If neither resume nor fresh is explicit, use `task-resume-candidate --json`: resume only for a
  clear follow-up; otherwise start with `--fresh`.
- Keep the task in the user's language and pass it as one prompt argument.
- Run `node <plugin-root>/scripts/grok-companion.mjs task <flags> <prompt>`.
- For a background launch, return the launch output and job ID, then stop without polling.
- For a foreground run, reproduce the companion's final stdout verbatim. Do not summarize it or
  continue the implementation yourself.

