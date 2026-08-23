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

## Foreground execution

These rules apply when `source-command-review`, `source-command-adversarial-review`,
`source-command-audit`, `source-command-rescue`, or `source-command-x` starts a Grok run.

- Always invoke the companion in the foreground. Do not use a yielded cell as a background job,
  `Start-Process`, shell `&`, or another detached-child mechanism.
- Reject `--background` with a clear explanation that Grok commands are foreground-only. Treat a
  legacy `--wait` as a no-op and remove it before constructing task or focus text.
- Add `--json` before any free-form text when starting a review, audit, task, rescue, or X-search run.
  JSON mode keeps companion progress in the job log and returns one machine-readable result only
  after the foreground process completes.
- After the initial start acknowledgement, wait on that same foreground process without repeated
  chat commentary or status polling. Waiting or polling the existing shell process is allowed; keep
  those checks silent until it completes or times out.
- Read the exact Grok job ID from the completed JSON object's `jobId` field. Never infer it from
  status ordering.
- When the call completes, use `result <job-id>` whenever the invoking skill requires clean stored
  output, then copy that complete output into the response.
- If the call times out, do not start a replacement. Use the captured job ID with `status` or
  `result`; if no ID was captured, explain that limitation and inspect status without guessing.
- `source-command-status --wait` remains a synchronous status-polling option. It does not change a
  Grok run's execution mode.
