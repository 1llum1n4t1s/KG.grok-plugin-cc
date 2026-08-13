---
description: Run a Grok review that challenges the implementation approach and design choices
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run an adversarial Grok review through the shared plugin runtime. This is a challenge review of the chosen implementation, design choices, tradeoffs, and assumptions, not merely a stricter defect scan.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.
- Keep the framing focused on whether the current approach is right, what assumptions it depends on, and where it could fail in real conditions.

Execution rules:
- Always run the review in the foreground. Do not use a background task, `run_in_background`, or a detached process.
- If the raw arguments include `--background`, stop and say that background execution is no longer supported.
- A legacy `--wait` flag is harmless and may be forwarded; foreground is already the only mode.

Argument handling:
- Preserve the user's arguments exactly.
- Unless the arguments already contain `--language`, append `--language <BCP 47 tag>` for the conversation language.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- This command uses the same working-tree or branch target selection as `/grok:review`, including `--base <ref>`; it does not support staged or unstaged scope.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"
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
- Do not fix any issues mentioned in the review output.
