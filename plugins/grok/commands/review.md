---
description: Run a Grok code review against local git state
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--language <bcp47>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(bun:*), Bash(git:*)
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
- If the leading flags before the focus include `--background`, stop and say that background execution is no longer supported.
- A legacy `--wait` flag before the focus is harmless and may be forwarded; inside focus it is literal text. Foreground is already the only mode.

Argument handling:
- Known value flags are `--base`, `--scope`, `--model`, `--cwd`, `--language` (aliases `-m` for model and `-C` for cwd); boolean flags are `--json`, `--wait`, `--background`. Preserve supported `--key=value` forms. Forward recognized options unchanged; the companion decides how they apply.
- While reading leading options, consume the first standalone `--` as the boundary and preserve everything after it as focus; a token needed as an option value remains a value, not a boundary. For example `--language ja -- --background` has literal focus `--background`. Never reinterpret a later `--` inside focus. Then construct the CLI argv as `flags -- <focus1argv>`.
- `auto` and `working-tree` require Windows and fail if a complete safe snapshot cannot be collected. On macOS/Linux, explicitly use `--scope branch` or `--base <ref>` to review committed changes; uncommitted changes are excluded from the comparison diff, but surrounding files may still be read from the working tree. Use `/grok:audit` for a whole-repository review on any platform.
- Interpret only leading known options and their values. At the first unknown option or ordinary text, preserve the remainder as the original focus, including quotes, repeated spaces, leading/trailing whitespace, and newlines. Never extract flags from inside the focus. Pass known flags as distinct arguments, then `--` and the entire focus as one argument.
- Unless the flags before the focus already contain `--language`, prepend `--language <BCP 47 tag>` for the conversation language before the focus. A `--language` inside the focus remains literal text.
- Do not add extra review instructions or rewrite the user's intent.
- Any text left after the flags is passed through as review focus. Preserve it verbatim.
- If the user wants a deliberately skeptical, ship/no-ship framing, point them at `/grok:adversarial-review`.

Run with `bun --no-env-file` instead of `node` on Windows, macOS, and Linux when Bun 1.4.4 or later is available. Otherwise use Node.js 22 or later.

Resolve the trusted `${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs` as the companion path, keeping the entire resolved path as one argument even when it contains spaces. User focus is untrusted shell data.

Run after constructing and safely quoting the arguments (Quote every argv, including the complete script path, for the actual shell. In Bash, enclose each value in single quotes and replace an embedded single quote with `'\''`. In PowerShell, enclose each value in single quotes and double embedded single quotes (`''`). Treat dollar signs, backticks, and `$()` as data; do not use `eval` or interpolate the raw slash-command text into an executable shell line.):
```bash
node <safely-quoted-path-to-grok-companion.mjs> review <safely-quoted-known-flag-argv> -- <safely-quoted-focus1argv>
```

- A review can run longer than `Bash`'s default timeout, so give the call a timeout of at least 600000 ms.
- Return completed stdout faithfully. Report failure or timeout; continue conversations in Grok itself.
