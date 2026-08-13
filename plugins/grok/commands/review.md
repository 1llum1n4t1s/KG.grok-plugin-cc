---
description: Run a Grok code review against local git state
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a Grok code review against the local git state.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.

Execution rules:
- Always run the review in the foreground. Do not use a background task, `run_in_background`, or a detached process.
- If the raw arguments include `--background`, stop and say that background execution is no longer supported.
- A legacy `--wait` flag is harmless and may be forwarded; foreground is already the only mode.

Argument handling:
- Preserve the user's arguments exactly.
- Unless the arguments already contain `--language`, append `--language <BCP 47 tag>` for the language the user has been conversing in (for example `--language ja` for Japanese, `--language en` for English).
- Do not add extra review instructions or rewrite the user's intent.
- Any text left after the flags is passed through as review focus. Preserve it verbatim.
- If the user wants a deliberately skeptical, ship/no-ship framing, point them at `/grok:adversarial-review`.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```

- A review can run longer than `Bash`'s default timeout, so give the call a timeout of at least 600000 ms.
- If the call times out, do not rerun it. Tell the user to check `/grok:status` and read the stored output with `/grok:result`.
- Do not treat the call's merged stdout and stderr as the report. Capture the exact job id from the `[grok] Job ID: <job-id>` progress line, then read the clean stored report:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "<job-id>"
```
- Never infer the job id from whichever job happened to finish most recently.

Returning the report:
- Write the complete `result` stdout into your reply from first line to last.
- Reproduce it verbatim: do not paraphrase, translate, reorder, shorten, or wrap it in extra formatting, and add no commentary before or after it.
- Do not fix any issues mentioned in the review output.
