---
description: Run a Grok audit of the entire existing codebase, ignoring the current diff
argument-hint: '[--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a Grok audit of the entire existing codebase. Unlike `/grok:review`, this ignores the current git diff and reviews the source as it exists on disk.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the audit and return Grok's output verbatim to the user.

Execution rules:
- Always run the audit in the foreground. Do not use a background task, `run_in_background`, or a detached process.
- If the raw arguments include `--background`, stop and say that background execution is no longer supported.
- A legacy `--wait` flag is harmless and may be forwarded; foreground is already the only mode.

Argument handling:
- Preserve the user's arguments exactly.
- Unless the arguments already contain `--language`, append `--language <BCP 47 tag>` for the conversation language.
- Do not add audit criteria or rewrite the user's focus.
- A focus is optional. Without one, the companion applies its built-in risk-directed deep-audit focus; with one, it narrows the audit to that subsystem or concern.
- If the user wants only current changes reviewed, point them at `/grok:review`.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" audit "$ARGUMENTS"
```

- Give the `Bash` call a timeout of at least 600000 ms.
- If it times out, do not rerun it. Tell the user to check `/grok:status` and `/grok:result`.
- Capture the exact job id from `[grok] Job ID: <job-id>` and read the clean stored report:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "<job-id>"
```
- Never infer the job id from job ordering.

Returning the report:
- Write the complete `result` stdout into your reply from first line to last.
- Reproduce it verbatim with no paraphrase, translation, reordering, shortening, extra formatting, or commentary.
- Do not fix any issues mentioned in the audit output.
