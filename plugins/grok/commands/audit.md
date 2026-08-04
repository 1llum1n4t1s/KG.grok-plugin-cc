---
description: Run a Grok audit of the entire existing codebase, ignoring the current diff
argument-hint: '[--wait|--background] [--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok audit of the entire existing codebase. Unlike `/grok:review`, this ignores the current git diff and reviews the source as it exists on disk.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the audit and return Grok's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the audit in the foreground.
- If the raw arguments include `--background`, do not ask. Run the audit in a Claude background task.
- Otherwise ask, and recommend background: a full-repository audit reads many files and usually takes longer than a diff review. Use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`

Argument handling:
- Preserve the user's arguments exactly.
- Unless the arguments already contain `--language`, append `--language <BCP 47 tag>` for the language the user has been conversing in (for example `--language ja` for Japanese, `--language en` for English). This makes Grok write its findings in the user's language.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra audit instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- Any text left after the flags is passed through as audit focus (for example a module or concern to concentrate on). Preserve it verbatim.
- A focus is optional but strongly recommended on large repositories: it keeps the audit deep instead of broad.
- If the user actually wants the current changes reviewed, point them at `/grok:review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" audit "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the audit output.

Background flow:
- Launch the audit with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" audit "$ARGUMENTS"`,
  description: "Grok audit",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Grok audit started in the background. Check `/grok:status` for progress."
