---
description: Run a Grok review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run an adversarial Grok review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, run the review in the foreground.
- Otherwise, including when `--background` is explicit or neither execution flag is present, start
  the review immediately in a Claude background task without asking for an execution mode.

Argument handling:
- Preserve the user's arguments exactly.
- Unless the arguments already contain `--language`, append `--language <BCP 47 tag>` for the language the user has been conversing in (for example `--language ja` for Japanese, `--language en` for English). This makes Grok write its findings in the user's language.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/grok:adversarial-review` uses the same review target selection as `/grok:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/grok:review`, it can still take extra focus text after the flags.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"
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
- Capture the exact job id from the `[grok] Job ID: <job-id>` progress line. Never infer it from
  whichever job happened to finish most recently.
- Read the stored report instead, exactly as the background flow does:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "<job-id>"
```
- Substitute the exact id captured from this review. That output is the rendered report only, with
  no progress lines mixed in.
- Then follow "Returning the report" below.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Grok adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Grok adversarial review started in the background. Check `/grok:status` for progress."

When the background run finishes (a later turn):
- Do not read, quote, or paste the background task's output file, and do not call `BashOutput`.
  A background task merges the run's stderr into the same stream as its stdout, so that file holds
  the companion's progress lines (`[grok] Tool: ...`, dozens of them) and any Node warnings ahead of
  the report itself. Pasting it hands the user a wall of noise instead of the review.
- Read the stored report instead:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "<job-id>"
```
- Substitute the exact id from the completed background task's `[grok] Job ID: <job-id>` line.
  Never use a bare `result`; concurrent jobs can finish in a different order.
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
