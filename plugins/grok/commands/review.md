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
- Unless the flags before the focus already contain `--language`, prepend `--language <BCP 47 tag>` for the conversation language to the raw argument string. Use that updated string in place of `$ARGUMENTS` below. Keep all flags before the focus text; a `--language` mentioned inside the focus is literal focus text.
- Do not add extra review instructions or rewrite the user's intent.
- Any text left after the flags is passed through as review focus. Preserve it verbatim.
- If the user wants a deliberately skeptical, ship/no-ship framing, point them at `/grok:adversarial-review`.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```

- A review can run longer than `Bash`'s default timeout, so give the call a timeout of at least 600000 ms.
- Return completed stdout faithfully. Report failure or timeout; continue conversations in Grok itself.
