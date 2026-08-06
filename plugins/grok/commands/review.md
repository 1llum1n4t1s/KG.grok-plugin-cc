---
description: Run a Grok code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok code review against the local git state.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Unless the arguments already contain `--language`, append `--language <BCP 47 tag>` for the language the user has been conversing in (for example `--language ja` for Japanese, `--language en` for English). This makes Grok write its findings in the user's language.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- Any text left after the flags is passed through as review focus. Preserve it verbatim.
- If the user wants a deliberately skeptical, ship/no-ship framing, point them at `/grok:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```
- A review drives a full Grok Build session and can run longer than `Bash`'s default timeout, so
  give the `Bash` call a timeout of at least 600000 ms. Without it the call is cut off while the
  review is still running and you get no output at all, even though the run finishes and stores
  its result.
- If the call times out anyway, do not re-run the review. Tell the user to check `/grok:status` and
  read the stored output with `/grok:result` — the finished run is already recorded.
- Do not treat that call's own output as the report, and do not quote it. `Bash` hands you the run's
  stdout and stderr merged into a single result, so it opens with the companion's progress lines
  (`[grok] Tool: ...`, dozens of them) and any Node warnings, and where the report actually begins is
  ambiguous.
- Read the stored report instead, exactly as the background flow does:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result
```
- With no job id it resolves the most recent finished job for this session — foreground runs are
  recorded the same way background ones are, so this is the review you just ran. That output is the
  rendered report only, with no progress lines mixed in.
- Then follow "Returning the report" below.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"`,
  description: "Grok review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Grok review started in the background. Check `/grok:status` for progress."

When the background run finishes (a later turn):
- Do not read, quote, or paste the background task's output file, and do not call `BashOutput`.
  A background task merges the run's stderr into the same stream as its stdout, so that file holds
  the companion's progress lines (`[grok] Tool: ...`, dozens of them) and any Node warnings ahead of
  the report itself. Pasting it hands the user a wall of noise instead of the review.
- Read the stored report instead:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result
```
- With no job id it resolves the most recent finished job for this session, which is the run you
  launched. That output is the rendered report only, with no progress lines mixed in.
- Then follow "Returning the report" below.
- If the command reports that the job is still running, do not re-run the review. Tell the user to
  check `/grok:status`.

Returning the report (both flows):
- The user cannot see command output. Nothing the `result` call printed is on their screen, so the
  report reaches them only through the text you write in your own reply.
- Write the whole thing out in that reply, from the first line of that stdout to the last.
- Never answer with a pointer to it ("the review result is above", "see the output"), with a count of
  findings, or with a summary. That leaves the user with nothing.
- Reproduce it verbatim: do not paraphrase, translate, reorder, shorten, or wrap it in extra
  formatting, and add no commentary before or after it.
- Do not fix any issues mentioned in the review output.
