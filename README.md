[English](#english) | [日本語](#japanese)

<a id="english"></a>

# Grok plugin for Claude Code and Codex

Use Grok Build from inside Claude Code or Codex for code reviews, repository audits, X searches,
or delegated tasks.

This plugin is for Claude Code and Codex users who already have Grok Build installed and want to
reach it from the workflow they are already in.

State writes and locked state snapshots require explicit offline migration, even for a new state
directory. Supported local filesystems are Windows NTFS fixed volumes, macOS APFS, and Linux
ext4/tmpfs, with the OS utilities and host identity described in [setup and migration](#groksetup).
Unknown or unsupported filesystems and missing prerequisites are refused. Plain state reads can
still inspect saved data, without a transactional consistency guarantee. Git worktree snapshots and
the DPAPI stop gate retain their separate Windows-only limits.

It is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), retargeted
from the OpenAI Codex CLI to xAI's Grok Build CLI. See [NOTICE](./NOTICE) for attribution and a
summary of what changed.

## What You Get

The examples below use Claude Code's `/grok:<name>` slash commands. In Codex, open `/skills` and
choose the matching `grok:source-command-<name>` skill, or ask Codex to use it by name. The explicit
`source-command-` prefix prevents Claude's slash commands from colliding with Codex skills. Both
hosts use the same companion runtime, with job state stored separately in each host's data directory.
Codex's skill list contains only these public workflows; Claude's internal helpers are not shown there.

- `/grok:review` for a read-only Grok review of your local git state
- `/grok:adversarial-review` for a deliberately skeptical ship/no-ship review
- `/grok:audit` for a read-only audit of the entire existing codebase, ignoring the current diff
- `/grok:rescue` to hand a problem to Grok and get a worked answer back
- `/grok:x` to search X (Twitter) posts, which plain web search cannot read
- `/grok:status`, `/grok:result`, and `/grok:cancel` to inspect, recover, or stop tracked jobs
- `/grok:setup` to check that everything is wired up

## Requirements

- **Grok Build**, signed in with a SuperGrok or X Premium+ account, or an `XAI_API_KEY`.
  Usage counts against whichever one you use.
- **Node.js 22 or later**
- **Git 2.45 or later**, or a Git build with backported `--no-lazy-fetch`, for repository operations

Install Grok Build from [x.ai/cli](https://x.ai/cli):

```bash
irm https://x.ai/cli/install.ps1 | iex
```

On macOS or Linux:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

The plugin talks to Grok over `grok agent stdio`, so you need a build recent enough to expose that
subcommand. If `/grok:setup` reports that it is unavailable in an older build, run `grok update`
in a terminal, then run setup again.

## Install

### Claude Code

Add the marketplace in Claude Code:

```bash
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
```

Install the plugin:

```bash
/plugin install grok@kagayoi-grok
```

### Codex

Add the same marketplace and install the plugin from a terminal:

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Start a new Codex task after installation so its skill catalog includes the plugin. Open `/skills`
and select `grok:source-command-setup` to verify Grok Build and authentication. Codex may also ask
you to trust the plugin's lifecycle hooks the first time it loads them.
Keep all four Grok plugin hooks enabled, including on Windows. The plugin resolves its paths
through Node.js; a separate user-level hook bridge is not required.

To use Claude Code and Codex together, install the plugin in each application.
Keep the plugin data directories assigned by each application separate; job state and
review-gate settings are stored independently, even when both use the same repository.

Reload plugins:

```bash
/reload-plugins
```

### What the plugin runs on your machine

Worth knowing before you install, because this plugin does more than add prompts:

- It starts `grok agent stdio` as a child process and talks to it over the Agent
  Client Protocol. Grok Build itself comes from x.ai, not from this repository.
- Within each app, runs in the same repository share one Grok process through a small broker that
  stays resident between commands. If the broker is unreachable and startup admission permits it, the plugin starts its own
  process. `/grok:status` shows running jobs, and `/grok:cancel` requests cancellation.
  A saved broker that cannot confirm its generation is rejected; its record is retained. An incompatible
  authentication mode or an orphaned startup lock with a confirmed journal can leave later runs in direct
  mode, without automatic recovery. Invalid saved broker records are retained and rejected. If a startup
  lock remains while its journal is missing, startup is refused and the lock is retained for investigation.
  This differs from an unresolved startup admission journal:
  the broker admission journal under the repository's plugin state directory blocks startup
  explicitly if pending, corrupt, or full; it does not silently fall back to a direct agent.
  Startup reservation and cancellation ownership are described in [DESIGN.md](DESIGN.md#データフローと設計判断).
  The append-only journal has a 4 MiB limit and reserves space for three following records. Even normal
  long-term use can exhaust it and block new broker generations before 4 MiB; automatic rotation or
  compaction is not implemented. Keep the journal and logs for investigation rather than deleting them.
  Windows and macOS do not currently have a built-in way to preserve and recover an exhausted or
  unresolved broker or direct admission record. The Linux epoch recovery command does not recover these
  Windows or macOS records.
  Parent death, corrupt records, or uncertain I/O can leave a child, agent, or supervisor running or
  able to start later. Before explicit offline recovery, confirm that all runtimes and processes that
  could start later have stopped, prevent their restart, and confirm no other host uses this state.
  Preserve the startup records; state-lock migration alone does not resolve uncertain startup admission.
- Job records and Grok's output are written under the plugin's own data
  directory, scoped per repository.
- Grok reads your repository to answer, so the code it opens goes to xAI under
  the account Grok Build is signed in with. Nothing is sent anywhere else, and
  this plugin has no backend of its own.
- The stop-time review gate is **off by default**. If you turn it on with
  `/grok:setup --enable-review-gate`, each assistant turn that changes the repository runs a fresh
  review of that turn's changes before it stops and can block until the issue is fixed. This requires
  the supported Windows snapshot path described below. Turn it back off with
  `/grok:setup --disable-review-gate`.

Then run `/grok:setup` in Claude Code, or select `grok:source-command-setup` from `/skills` in Codex:

```bash
/grok:setup
```

`/grok:setup` reports whether Grok Build is installed, whether `grok agent stdio` is available,
and whether you are signed in. It does not install anything for you — Grok Build ships from x.ai,
not from a package registry.

### Signing in

Either sign in interactively:

```bash
grok login
```

If browser login is blocked, retry with `grok login --device-auth`.

Alternatively, set an API key from [console.x.ai](https://console.x.ai) for headless or metered use:

```bash
$env:XAI_API_KEY = "xai-..."
```

The API key takes precedence over browser credentials.

## Usage

### `/grok:review`

Runs a read-only review of your local git state and displays Grok's verdict, findings, and next steps.

```bash
/grok:review
/grok:review --base main
/grok:review --scope working-tree
/grok:review focus on the retry logic
```

The default `auto` scope and `--scope working-tree` collect a snapshot without running Git
clean/process filters. This is supported only on Windows local fixed drives, using verified file
handles. Other operating systems, network/UNC paths, links/reparse points, unsafe or changing files,
unsupported EOL/encoding/filter attributes or configuration, sparse/unmerged indexes, submodules,
and content beyond the snapshot limits fail explicitly with `Review incomplete`.
`core.filemode` must be explicitly `false`. With `core.autocrlf=true` or `input`, tracked files whose
raw blob OID matches the index remain clean, including unchanged binary or index-CRLF content.
Otherwise, index comparison supports limited CRLF-to-LF normalization: ordinary valid UTF-8 text with only LF
or only CRLF line endings, and an index blob containing no CR. Mixed endings, bare CR, binary or unsupported control
content, and CR/CRLF in the index fail closed when this conversion applies. Explicit `-text`/`-crlf`
paths retain raw bytes. This does not implement all Git clean conversions. Fingerprints and turn
diffs retain the raw worktree bytes, so line-ending changes remain visible to the stop gate.
Use `--base main` or `--scope branch` for committed comparisons, or `/grok:audit` for repository
inventory. Branch comparisons also fail as incomplete when submodules change; their contents are
not silently omitted.
Large branch comparisons remain available through self-collection using the exact fixed OID range
provided in the review context. Shell diff accepts that range immediately after its two execution
guards, with paths only after `--`; branch names, `HEAD`, extra revisions and `--no-index` are rejected.
When enabled, the stop gate blocks explicitly on fingerprint failure without starting Grok or treating
the turn as reviewed. Repeated Stop events do not start additional reviews while collection fails.

Any text left after the flags is passed to Grok as review focus.

Findings come back in your language: when run as a slash command, Claude forwards the conversation
language with `--language <bcp47>` automatically. When calling the companion script directly, pass
`--language` yourself, or the review falls back to the language of the focus text, then English.
This applies to `/grok:adversarial-review` and `/grok:audit` as well.

Review permissions deny file-write requests and unsupported shell commands. The permission filter
is not an OS sandbox. Filter-capable worktree Git queries and inline submodule diffs are blocked
before execution; unsupported collection fails explicitly as described above.
For recent commit history, Grok can use `git log` with `--since=YYYY-MM-DD` and `--oneline`
under the review's Git safeguards.
Grok reports suggested changes without editing files directly.
In read-only runs, `Test-Path -LiteralPath` is also allowed for one path inside the repository,
including an absolute path. Paths outside the repository and paths through links that leave it
are denied.
Each built-in `WebFetch` request for an HTTP(S) URL without credentials receives one-time permission, so
read-only rescue and reviews can consult public sources. Extra input fields remain denied.

Reviews and audits cover all review perspectives in one Grok session; subagent delegation is
not available in the read-only runtime. If a permission request is denied or Grok reports that
required inspection is unfinished, the result is `incomplete` and the job fails instead of
reporting approval. The stop-time review gate also fails when a permission request is denied or
its Grok turn does not finish normally.
If a review stops before its final response, partial text is reported as incomplete and is not
sent back as a completed review for JSON repair.
Use `/grok:result <job-id>` to inspect the saved result and any reported permission denials;
an incomplete review remains marked as incomplete when displayed again.

Every Grok command runs in the foreground in both Claude Code and Codex. This keeps command output,
the exact Grok job ID, cancellation, and stored results under one consistent lifecycle. The old
`--wait` flag on review, audit, and task execution is accepted as a no-op for compatibility;
`--background` is rejected. `status <job-id> --wait` still waits for that job to finish.

Codex skills use the companion's buffered JSON mode, so long-running reviews, audits, delegated
tasks, and X searches stay quiet in chat until Grok finishes. Detailed progress remains available
in the stored job log and through the status command. Claude Code keeps its native foreground Bash
display.

If a review's JSON re-emission also fails, the saved result contains the latest reply and error.
The review job is marked failed if no valid structured result is obtained. Use `/grok:result <job-id>`
to inspect the saved output.

### `/grok:adversarial-review`

Same targeting as `/grok:review`, but Grok is told to argue against shipping and to report the
strongest reasons the change should not land yet.

```bash
/grok:adversarial-review
/grok:adversarial-review --base main
/grok:adversarial-review focus on the migration path
```

Use this when you want pushback rather than a balanced summary.

### `/grok:audit`

Audits the entire existing codebase instead of a diff. Use it when you want Grok's opinion on the
source as it stands, independent of whatever you are currently changing.

```bash
/grok:audit
/grok:audit focus on the auth module
```

The audit context deliberately contains no diff and no file contents, only a file inventory; Grok
reads the files it decides to inspect with read-only commands. With no focus text, it performs a
risk-directed deep audit by mapping the architecture, selecting the highest-risk execution paths,
and tracing their callers, state transitions, boundaries, failure paths, concurrency behavior, and
tests. An explicit focus is still useful on large repositories when you want that deep pass confined
to a particular subsystem or concern.

The same permission rules and limitations as `/grok:review` apply.

### `/grok:rescue`

Hands a problem to Grok and returns its answer. This is the command for "I am stuck, get another
set of eyes on it."

```bash
/grok:rescue why does the upload retry loop never terminate?
/grok:rescue --resume
/grok:rescue --model latest --effort high
```

Plugin-managed resumption requires the target session's terminal state to have been confirmed in
the same broker generation that will resume it. After a broker restart, or for direct-mode and
older-version history without that confirmation, `--resume` is rejected. A saved session ID or
completed job record alone is insufficient; start a fresh task when resumption cannot be verified.

Unlike the review commands, `/grok:rescue` runs write-capable by default, so Grok can edit files
while it works. Say so in the request when you only want diagnosis — "read-only", "just
investigate", "don't change anything" — and the run stays read-only.

For direct Companion calls, use `task --json --fresh --prompt-file <absolute-path>` for a
multiline UTF-8 request. Omit `--write` for read-only work; `--read-only` is not a CLI flag.
In PowerShell, prefer the prompt file to embedding a long request in a here-string.

Model aliases: `fast`, `reasoning`, `multi`, `build`, `latest`. Anything else is passed through as
a model ID, so `--model grok-4.7` works too. `--effort` accepts `low`, `medium`, or `high`.

### `/grok:x`

Searches X (Twitter) posts through Grok Build and returns the findings with author handles, dates,
and post URLs. Grok Build reaches X with its own `x_keyword_search` and `x_semantic_search` tools,
so this works with the same `grok login` credentials as every other command — no xAI API key needed.
Ordinary web search cannot read X timelines, which is why this is a separate command.
The date range is unrestricted unless you explicitly request a time period.

```bash
/grok:x what are people saying about the latest Avalonia release
/grok:x --model latest reaction to the new pricing announcement
```

The run is always read-only. A search drives a full Grok Build session, so it usually takes a few
minutes and remains attached until it completes.

### `/grok:status`

Shows active and recent Grok jobs for the repository, plus the state of the review gate.

```bash
/grok:status
/grok:status --all
/grok:status <job-id> --wait
```

### `/grok:result`

Prints the stored final output of a finished job.

```bash
/grok:result
/grok:result <job-id>
```

Each result includes the Grok session ID and the `grok --resume <id>` command, so you can pick the
conversation back up in Grok's own TUI. That external command is not evidence that plugin-managed
resumption is safe; `/grok:rescue --resume` still requires terminal confirmation in the same broker generation.

### `/grok:cancel`

Requests cancellation of a tracked job and its Grok turn.

```bash
/grok:cancel
/grok:cancel <job-id>
```

Without a job ID, cancel selects the only active job in the current session. If multiple jobs are
active, it stops without guessing and asks for a job ID; use `/grok:status` to choose one.
If the plugin cannot confirm that the process stopped, the job stays pending in `/grok:status`.
Retry `/grok:cancel <job-id>`; results and task resumption remain unavailable until cancellation completes.
Active and pending jobs remain tracked even as finished history grows. A cancellation-log write failure
is reported as a warning and does not prevent process termination.
The current runtime refuses state writes until explicit migration; it does not acquire or reclaim a
legacy file lock. Older runtimes still have non-atomic ownership-check/removal races and no automatic
dead-lock recovery. Stop every old runtime before migration; existing legacy lock files are left untouched.
Cancellation requires worker-stop confirmation. Except for jobs confirmed unsent before connection
preparation, broker jobs also require an execution-scoped broker cancellation reservation and confirmed turn
termination. Direct jobs use the cooperative confirmation described below; older jobs without stop evidence can remain
termination-pending even after the worker stops; retrying alone cannot supply the missing evidence.
They are not reported as cancelled, and their results remain unavailable.
If startup or prompt transmission is uncertain, the job remains termination-pending even if the
worker exits.
Even completed history cannot be resumed through the plugin unless the target session has confirmed
terminal state in the same broker generation. Broker restart, direct-mode history, and unconfirmed
older history therefore block resumption independently of the saved job status.
Windows cancellation stops the tracked worker without a tree-wide kill to protect a shared broker.
Windows checks the full-precision start time and stops the worker through the same process handle.
Older CIM-based identifiers cannot be verified this way, so their cancellation remains pending.
On POSIX, the plugin does not signal tracked workers by numeric PID; it waits for their natural exit.

For direct Grok agent launches on Windows 10 / Windows Server 2016 or later, a supervisor owns a
dedicated Job Object containing the agent and its descendants; the worker and shared broker stay
outside it. Cleanup is confirmed only by the supervisor's acknowledgement after the Job reports
`ActiveProcesses = 0`. Startup/cleanup failure or a missing acknowledgement remains unconfirmed.
`/grok:cancel` asks the owning worker to close its direct agent cooperatively. The caller verifies
the persisted stop proof for the same generation and worker identity before confirming cancellation.
Older jobs, worker death before proof is saved, and confirmation timeouts remain pending; a timeout
leaves the owner able to finish confirmation, so retry `/grok:cancel <job-id>`.

On POSIX, direct cancellation sends SIGTERM only to the detached process group owned by that launch
and confirms both the child closing after its output drains and the group's absence. Descendants
that escaped into a different session or group are not covered. If descendants remain after the
direct child exits, cancellation stays pending; the plugin does not signal the group again after
the child exits. Signaling assumes the standard Node.js/libuv runtime;
native extensions that reap or regroup processes independently are outside this guarantee.
On every platform, session-end cleanup first confirms agent-stop evidence, then worker exit, and
retains unconfirmed jobs. If broker startup fails on POSIX, cleanup targets only the detached process
group created by that launch and confirms its absence; descendants that moved to other groups are not covered.
Normal idle broker cleanup also requires stop evidence: the same generation's empty agent Job on
Windows, or the broker's owned process group being absent on POSIX. An accepted shutdown request
or the broker PID disappearing alone is not sufficient.

On Windows, failed process lookups emit `Process lookup diagnostic` JSON records to stderr and,
when available, the existing job log shown by `/grok:status`. Search for that string to find diagnostics.
Keep these records when investigating a pending cancellation. `not-observed` means no start record
was observed; it does not prove that the process never started. Successful lookups emit no diagnostic
records. See [process lookup diagnostics](DESIGN.md#プロセス照会診断) for record fields,
privacy boundaries, and interpretation, and [AGENTS.md](AGENTS.md) for development verification.

### `/grok:setup`

Checks the local install and optionally toggles the stop-time review gate.

```bash
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

The gate is off unless you enable it. On the supported Windows snapshot path, it captures a baseline
at user submission and reviews only that turn's changes, skipping unchanged turns. The baseline is
compressed and protected with Windows DPAPI for the current user, bound to the workspace, session,
and turn. If it is missing, invalid, or too large, the gate blocks; submit a new user turn to capture
a fresh baseline. Unsupported snapshot collection also blocks before Grok starts.
Snapshot collection and protection share the remaining portion of a 45-second budget started before
workspace lookup. The initial synchronous lookup itself is not interrupted by that budget. If the
enabled gate cannot initialize baseline state after lookup, the prompt is blocked; resolve the error
and retry.
Disable it with `/grok:setup --disable-review-gate`.

State lock migration is mandatory before any state update or locked state snapshot, including for a
new state directory, and is never automatic. Unmigrated state is rejected rather than using the legacy
file lock. Plain reads of saved state remain available but are not locked snapshots.

| Platform | Supported local storage and required tools |
| --- | --- |
| Windows | NTFS fixed volume; Windows PowerShell and verifiable directory/volume identity. FAT, ReFS, network and unknown volumes are refused. |
| macOS | Local APFS; `/usr/bin/lockf`, `/sbin/mount`, and `/usr/sbin/ioreg` with a valid `IOPlatformUUID`. |
| Linux | Local ext4 or tmpfs; `/usr/bin/flock`, readable `/etc/machine-id` and `/proc`, and matching filesystem/device inspection. All users of the state must share the sentinel's PID, time and network namespaces and a compatible `/proc` view. |

Missing tools, unknown host identity, or unverifiable filesystem/marker identity fail explicitly.
Before running from the plugin directory, stop every old runtime, broker, agent, worker, supervisor,
and process that could spawn one later on every host, prevent their restart, and exclude concurrent
access from other hosts (including synchronized copies). The old writer barrier alone cannot prevent
an old agent from starting later.

Use the exact workspace and runtime environment of the host being migrated. A manually opened shell
may not inherit the host's `CLAUDE_PLUGIN_DATA` or `PLUGIN_DATA`: reproduce their actual values and
unset/set status before running the command. `CLAUDE_PLUGIN_DATA` takes precedence, then `PLUGIN_DATA`;
if neither is set, storage falls back to the OS temporary directory. Different values, temporary
directories, or workspace aliases can select a different, empty state directory. Migrate Claude Code
and Codex separately against each host's actual state location; do not treat success elsewhere as migration of existing data.
The required `--expected-state-dir` value is the actual absolute path represented by the
`State directory (data):` line in that host's unmigrated-state error, not a directory chosen in the manual shell. Missing,
relative, or mismatched values are refused before migration creates anything. Confirm the effective
`stateDir` in the success output (also returned with `--json`).

```powershell
node scripts/grok-companion.mjs state-lock migrate --offline-confirmed --local-only --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

Replace the placeholders with the actual paths, keeping PowerShell's single quotes so dollar signs
and backticks are not expanded. Inside a single-quoted PowerShell path, write an apostrophe as `''`.

On macOS/Linux, use a POSIX shell. On macOS this command initializes a new state directory;
existing legacy file locks and older markers are refused as described below:

```sh
node scripts/grok-companion.mjs state-lock migrate --offline-confirmed --local-only --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

Keep the single quotes to prevent shell expansion. An apostrophe inside a POSIX-shell path must be
written by ending the quoted part, adding `"'"`, then reopening it: `'before'"'"'after'`.

On Windows and Linux, if migration refuses an existing legacy lock file:

1. First confirm that every old runtime on every host is stopped and will stay stopped, and that no
   other host can access this state concurrently. Match the host environment and workspace above.
2. Inspect the exact absolute `state.lock` path printed by the refusal. Only if it is a regular file
   at a verified link-free real path (see the POSIX path check below), manually rename it to an unused name
   in the same directory and retain it. Do not delete it or overwrite another entry. Do not apply this
   procedure to a symbolic link, junction, directory barrier, or any unknown state.
3. With all old runtimes still stopped, rerun the same explicit migration. It creates the new barrier
   at the original `state.lock` path while the archived legacy file remains beside it. Keep both.

On macOS/Linux, a known system alias in an ancestor, such as macOS `/var` → `/private/var`, can appear
in the reported path. Before archiving, resolve both the host-reported state directory and the exact
reported `state.lock`; this read-only check rejects a linked `state.lock` and requires its real parent
to equal the real state directory:

```sh
node -e 'const fs=require("node:fs"),p=require("node:path");const [reported,lock]=process.argv.slice(1);if(!p.isAbsolute(reported)||!p.isAbsolute(lock))throw Error("Absolute paths required");const s=fs.lstatSync(lock);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error("Unsupported state.lock");const realStateDir=fs.realpathSync(reported),realLock=fs.realpathSync(lock);if(p.dirname(realLock)!==realStateDir||p.basename(realLock)!=="state.lock")throw Error("State directory mismatch");console.log(JSON.stringify({realStateDir,realLock,kind:s.isFile()?"file":"directory"},null,2));' '<host-reported-state-dir>' '<exact-reported-state.lock>'
```

For the Linux recovery steps, confirm that the printed real paths are the intended host/workspace state, then archive only the
verified real `state.lock` to an unused sibling name. Do not resolve and archive unknown links,
a symbolic-link `state.lock`, or a junction. For the CLI, continue to use the **original host-reported
state directory** as `--expected-state-dir`, with the same workspace and environment; do not substitute
the resolved path merely because it was used for manual inspection.

These flags confirm your prerequisites; the plugin cannot prove that other hosts or old runtimes are
absent. You are responsible for these prerequisites even for machines cloned with the same MachineGuid;
host identity checks do not prove machine uniqueness or exclusive use by one host. The migration preserves state and jobs,
refuses existing legacy lock files without deleting them, and leaves a permanent compatibility barrier.
Retain the barrier and prepared metadata. On Windows, rerun the same explicit migration after interruption.
Legacy lock files are not deleted, and the migration marker is not rolled back. An incomplete or
invalid marker fails explicitly. Older runtimes still have the legacy locking risks, so keep them
stopped; the current runtime refuses unmigrated writes.

On macOS/Linux, `state.lock/native.lock` is a permanent lock file; `protocol.json` and
`prepared-*.json` remain alongside it. The OS releases the held lock when the owner closes its file
descriptor or exits, including a crash; it does not require deleting these files. The marker checks
the host, filesystem, and device/inode identities of the state directory, barrier and managed files.
POSIX state directories and managed entries must belong to the runtime user and have private permissions.
If `st_dev` changes, or the marker is invalid/incomplete, migration does not overwrite it automatically.
Successful filesystem synchronization is not a guarantee of physical durability after power loss;
an incomplete migration is retained for investigation or the platform-specific offline recovery below.
For Linux offline recovery, first stop **all** runtimes and processes that could start later, prevent their
restart, and confirm single-host
use. Verify that the exact `state.lock` is the expected directory barrier at a link-free real path,
using the POSIX path check above when a known system alias appears in an ancestor;
rename the whole barrier to an unused sibling name inside the same state directory and retain it.
Then rerun migration with the same host environment, workspace and correct `--expected-state-dir`.
Do not apply this recovery to symbolic links or unknown paths. Keep the archived barrier and all state data.

On macOS the current marker is `posix-local-v4`. Older markers are retained and refused;
they are not upgraded automatically. Legacy file-lock migration requires
`--all-old-processes-stopped` and the exact state directory, but currently refuses even with these
confirmations because migration completion evidence is not integrated. Keep the old processes stopped
and preserve the records; changing flags or markers does not make this migration available.
Migration also checks the existing state and job records and refuses unknown, missing, inconsistent, or oversized records. In particular, an
archived lock or barrier left beside `state.lock` is an unknown state-directory entry and prevents
migration. If migration refuses an existing lock, marker, or inventory, keep the old processes stopped
and preserve the state, jobs, and barrier for investigation. Do not delete or manually alter records to
force migration; an automatic archive or general recovery command for these macOS cases is not provided.

macOS tracks workers using 256 lease slots. When no slot is available, it sweeps at most 16 slots
with a five-second limit. If the sweep succeeds, it retries reservation once; a timeout or still unavailable
capacity causes the new job to fail.
The sweep preserves slots when identity, records, references, or turn/worker termination cannot be
confirmed. Its reverse-reference check is limited to 4,096 state jobs and 4,096 jobs-directory entries;
exceeding a limit does not establish that a slot is safe to reclaim. If capacity is exhausted, allow
active jobs to finish and retry; if the error persists, preserve the records for investigation rather
than deleting lease files or assuming an unconfirmed job or turn has stopped.

On Linux, migration starts a long-lived sentinel and creates a new epoch. All processes using the state
must remain in the same PID, time and network namespaces as the sentinel, with a compatible `/proc` view.
If the sentinel stops or becomes unavailable, stop all runtimes and processes that could start later,
prevent their restart, and confirm that no other host uses the state. Follow the barrier preservation
and explicit migration steps above to create a new sentinel and epoch. Do not run `recover` directly
against a stopped or invalid sentinel: it requires a valid marker and a running sentinel.

If old admission records remain, including after migration from an older version, keep every old
process stopped and run the following command while the sentinel is running and its marker is valid.
It explicitly records recovery for the current epoch:

```sh
node scripts/grok-companion.mjs state-lock recover --offline-confirmed --local-only --all-old-processes-stopped --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

To stop the Linux sentinel intentionally, first stop all runtimes and processes that could start later,
prevent their restart, confirm single-host use, and use the same host environment and workspace:

```sh
node scripts/grok-companion.mjs state-lock stop-sentinel --offline-confirmed --local-only --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

`recover` does not repair pending, corrupt or full admission records in the current epoch. For those
records, first meet the stop and single-host prerequisites above, run `stop-sentinel`, preserve the
barrier, migrate to a new epoch, and then run `recover` for the retained old records.
Before using the state again, follow the offline barrier preservation and migration steps above, then
recover any remaining old admission records. Preserve recovery records, old jobs, and existing POSIX
broker sockets, PID files and logs. Recovery does not establish whether an old turn succeeded or failed.
Linux recovery refuses an inventory exceeding 64 old epoch directories combined across broker and direct records
(normally two directories per old epoch),
or 64 MiB of old files; explicit `recover` cannot resume it as-is. A safe preservation archive is not
implemented. Keep the old records and do not delete or modify them without an independent preservation method.

While any runtime is active, other processes, including ones running under the same user, must not
modify, replace or remove the state directory, its ancestors, native lock/marker/prepared files, or
change their mounts, links or junctions. This is not protection against a same-user process rewriting state.
On Windows, the v2 native mutex uses the state directory's OS identity (`dev` + `ino`) on its volume,
not its canonical path string. It supports only NTFS local fixed volumes; FAT, ReFS, other filesystems,
and volumes whose filesystem cannot be determined are refused. Aliases and renames of the same directory therefore share one mutex.
The v2 migration marker also records the NTFS fixed volume's canonical GUID, obtained from the actual
directory handle. A missing, invalid, or different volume GUID is refused even when `dev` and `ino` match.
Unknown/zero identities, a different directory identity, and old v1 markers are refused without
automatic replacement. While any runtime is active, do not rename or replace the state directory or
its ancestors, or change their junctions. Handle-relative I/O that prevents replacement between an
identity check and each path operation is not implemented: preserving mutex identity across a rename
does not guarantee that all subsequent I/O remains pinned to that directory.
However, opening a workspace
through a differently named junction can still select a separate state directory: the existing layout
includes the original workspace basename as well as its real-path hash. Migration does not merge these directories.

## Typical Flows

### Review before shipping

```bash
/grok:review
```

Read the findings, fix what matters, then run it again.

### Hand a problem to Grok

```bash
/grok:rescue the websocket reconnect drops messages under load
```

### Run something long-running

```bash
/grok:rescue port the settings screen to the new form API
```

## Choosing a model

The plugin asks for `grok-4.7` by default. Override it for a single run with `--model`, or for
every run by setting `GROK_PLUGIN_MODEL`.

This matters more than it looks: when you authenticate with `XAI_API_KEY`, Grok's own default for a
new session is a non-reasoning model, which reviews noticeably worse.

## FAQ

### Do I need a separate account for this plugin?

No. It uses whatever Grok Build on your machine is already signed in with.

### Does it use my existing Grok configuration?

It uses your existing Grok Build authentication. Reviews and delegated `/grok:rescue` tasks
both request sessions with an empty MCP server list, including when resuming a task. The plugin
does not attach your global MCP servers to these sessions.

### Is `/grok:review` really read-only?

The plugin denies file-write requests, shell commands outside its allowlist, and output redirection.
Potentially filter-capable worktree queries are blocked and report incomplete collection.
These permissions still do not provide an OS sandbox.

### Why is there no `/grok:transfer`?

The upstream Codex plugin could import a Claude Code session into a Codex thread. Grok Build has no
equivalent, so the command was removed rather than faked.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

<a id="japanese"></a>

# Claude Code / Codex 向け Grok プラグイン

Claude Code や Codex の中から Grok Build を使い、コードレビュー、リポジトリ監査、X の検索、
タスクの委任を行えます。

このプラグインは、Grok Build をすでにインストールしており、普段使っている Claude Code や
Codex のワークフローからそのまま呼び出したい方を対象としています。

状態の書込みと lock 付き状態 snapshot は、新しい状態ディレクトリでも旧 runtime 停止後の明示移行が必要です。
対応するローカル FS は Windows の NTFS 固定 volume、macOS の APFS、Linux の ext4/tmpfs です。
後述の `/grok:setup` 節にある OS utility と host 識別情報が必要で、未対応・判定不能や前提不足は拒否します。
保存済み状態の直接読取は可能ですが、transaction としての一貫性は保証しません。
Git 作業ツリー snapshot と DPAPI 終了時ゲートは、独立した Windows 限定の制限を維持します。

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) をフォークし、OpenAI Codex
CLI 向けの実装を xAI の Grok Build CLI 向けに変更したものです。帰属表示と主な変更点については
[NOTICE](./NOTICE) を参照してください。

## 主な機能

以下の例では、Claude Code の `/grok:<name>` スラッシュコマンドを使用します。Codex では
`/skills` を開き、対応する `grok:source-command-<name>` スキルを選択するか、スキル名を指定して
Codex に実行を依頼してください。明示的な `source-command-` プレフィックスにより、Claude の
スラッシュコマンドと Codex のスキルが衝突するのを防いでいます。どちらのホストも同じ
コンパニオンランタイムを使用し、ジョブ状態は各ホストのデータディレクトリへ個別に保存します。
Codex のスキル一覧には公開ワークフローだけが表示され、Claude の内部 helper は表示されません。

- `/grok:review`: ローカルの Git 状態を Grok が読み取り専用でレビュー
- `/grok:adversarial-review`: 出荷可否を意図的かつ懐疑的にレビュー
- `/grok:audit`: 現在の差分を無視し、既存コードベース全体を読み取り専用で監査
- `/grok:rescue`: 問題を Grok に任せ、具体的な回答を取得
- `/grok:x`: 通常の Web 検索では読み取れない X（Twitter）の投稿を検索
- `/grok:status`、`/grok:result`、`/grok:cancel`: 追跡ジョブの確認、結果復旧、停止
- `/grok:setup`: 必要な設定が正しく機能しているか確認

## 必要要件

- **Grok Build**: SuperGrok または X Premium+ アカウントでサインインするか、
  `XAI_API_KEY` を設定してください。使用量は、利用した認証方式のアカウントに計上されます。
- **Node.js 22 以降**
- リポジトリ操作には **Git 2.45 以降**、または `--no-lazy-fetch` がバックポートされた Git

[x.ai/cli](https://x.ai/cli) から Grok Build をインストールします。

```bash
irm https://x.ai/cli/install.ps1 | iex
```

macOS または Linux の場合:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

このプラグインは `grok agent stdio` を介して Grok と通信するため、このサブコマンドを提供する
新しいバージョンの Grok Build が必要です。`/grok:setup` で古い版のため利用できないと報告された場合は、
ターミナルで `grok update` を実行し、setup を再実行してください。

## インストール

### Claude Code

Claude Code にマーケットプレイスを追加します。

```bash
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
```

プラグインをインストールします。

```bash
/plugin install grok@kagayoi-grok
```

### Codex

ターミナルから同じマーケットプレイスを追加し、プラグインをインストールします。

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

インストール後は、新しい Codex タスクを開始して、プラグインのスキルをスキルカタログへ反映させます。
`/skills` を開いて `grok:source-command-setup` を選択し、Grok Build と認証を確認してください。
ライフサイクルフックを初めて読み込むときは、Codex からプラグインを信頼するか確認される場合があります。
Windows を含め、Grok プラグインの4個のフックをすべて ON にして使います。
プラグイン自身が Node.js でパスを解決するため、ユーザー設定への別のフック登録は不要です。

Claude Code と Codex を併用するときは、それぞれにプラグインをインストールします。
各アプリが割り当てるプラグインのデータ保存先は別々に維持してください。
同じリポジトリを使う場合も、ジョブ状態とレビューゲートの設定は個別に保存されます。

プラグインを再読み込みするには、次を実行します。

```bash
/reload-plugins
```

### このプラグインがローカル環境で実行する処理

このプラグインはプロンプトを追加するだけではありません。インストール前に次の点を確認してください。

- `grok agent stdio` を子プロセスとして起動し、Agent Client Protocol を介して通信します。
  Grok Build 自体はこのリポジトリではなく、x.ai から提供されます。
- 各アプリ内で同じリポジトリの実行は、小さなブローカーを介して 1 つの Grok プロセスを共有します。
  このプロセスはコマンド間も常駐します。ブローカーへ接続できず、起動受付の条件が許す場合は独自のプロセスを起動します。
  実行中の処理は `/grok:status` で確認でき、`/grok:cancel` でキャンセルを要求できます。
  保存済み broker が自身の世代を確認できない場合は、その記録を保持して起動を拒否します。認証方式の不一致や、確定済み
  journal がある孤立した起動 lock により、以降が直接起動になる場合があり、自動復旧はありません。不正な保存済み broker
  記録も保持して拒否します。起動 lock が残っているのに journal がない場合は起動を拒否し、調査用に lock を保持します。
  一方、リポジトリ別のプラグイン状態内にある broker admission journal が未完了・破損・容量不足なら、
  起動を明示拒否し、直接起動へ黙って切り替えません。起動予約と取消の所有権の内部仕様は
  [DESIGN.md](DESIGN.md#データフローと設計判断) を参照してください。
  この追記専用 journal は後続3記録分の予約領域を含む 4 MiB 上限があり、
  通常の長期利用でも 4 MiB に達する前に新しい broker 世代を起動できなくなり得ます。自動ローテーション・圧縮は未実装です。
  調査のため journal とログを保持し、削除しないでください。
  Windows と macOS では、容量不足や未確定の broker・direct admission 記録を保全して再開する組み込みの復旧機能は
  まだありません。Linux の epoch 復旧コマンドは Windows・macOS の記録を復旧しません。
  親の死亡・記録の破損・I/O の成否不明により、子・agent・supervisor が残存したり、遅れて起動したりする場合があります。
  明示的な offline 復旧の前に、全 runtime と遅延起動し得るプロセスの停止・再起動防止、および他 host が同じ state を
  使っていないことを確認してください。起動記録は保全します。state-lock の移行だけでは起動の未確認状態は解消しません。
- ジョブ記録と Grok の出力は、リポジトリごとに分けられたプラグイン専用のデータディレクトリへ
  書き込まれます。
- Grok は回答のためにリポジトリを読み取ります。そのため、Grok が開いたコードは Grok Build の
  サインイン先アカウントを通じて xAI へ送信されます。それ以外の場所へは送信されず、この
  プラグイン独自のバックエンドもありません。
- 終了時のレビューゲートは**既定で無効**です。`/grok:setup --enable-review-gate` で有効にすると、
  リポジトリを変更した各アシスタントターンの終了前に新しいレビューが実行され、問題が解消するまで
  終了をブロックします。対象はそのターンの変更で、後述する対応範囲内の Windows スナップショットが必要です。
  `/grok:setup --disable-review-gate` で再び無効にできます。

続いて、Claude Code では `/grok:setup` を実行します。Codex では `/skills` から
`grok:source-command-setup` を選択します。

```bash
/grok:setup
```

`/grok:setup` は、Grok Build がインストール済みか、`grok agent stdio` が利用可能か、
サインイン済みかを報告します。Grok Build はパッケージレジストリではなく x.ai から提供されるため、
このコマンド自体は何もインストールしません。

### サインイン

対話形式でサインインする場合:

```bash
grok login
```

ブラウザでのログインが阻まれる場合は、`grok login --device-auth` で再試行してください。

代わりにヘッドレス環境または従量課金で利用する場合は、[console.x.ai](https://console.x.ai) で取得した
API キーを設定します。

```bash
$env:XAI_API_KEY = "xai-..."
```

API キーはブラウザの認証情報より優先されます。

## 使い方

### `/grok:review`

ローカルの Git 状態を読み取り専用でレビューし、Grok の判定、指摘、次の対応を表示します。

```bash
/grok:review
/grok:review --base main
/grok:review --scope working-tree
/grok:review focus on the retry logic
```

既定の `auto` と `--scope working-tree` は、Git の clean/process フィルターを実行せずに
スナップショットを取得します。対応範囲は Windows のローカル固定ドライブ上で、検証済みの
ファイルハンドルから読み取れる場合に限ります。他 OS、ネットワーク/UNC、リンク/reparse point、
安全に読み取れない・読取中に変化するファイル、未対応の EOL・文字コード・filter 属性や設定、
sparse/unmerged index、サブモジュール、容量上限を超える内容は `Review incomplete` の明示エラーになります。
`core.filemode` は明示的な `false` が必要です。`core.autocrlf=true` または `input` の追跡ファイルでも、
生の blob OID が index と一致すれば、変更のないバイナリや index CRLF を含め変更なしと判定します。
一致しない場合は、通常の有効な UTF-8 テキストで改行が LF のみか CRLF のみ、index blob に CR がない場合に限り、
index との比較で CRLF を LF に正規化します。この変換の対象で混在改行・単独 CR・バイナリ/未対応の制御文字・
index 内の CR/CRLF があれば明示エラーにします。明示的な `-text`/`-crlf` のパスは生のバイトを維持します。
通常の Git clean 変換すべてとの互換ではありません。fingerprint とターン差分は作業ツリーの生のバイトを保持し、
改行だけの変更も終了時ゲートから見えるままにします。
コミット済み比較には `--base main` または `--scope branch`、リポジトリの棚卸しには `/grok:audit`
を使ってください。ブランチ比較でもサブモジュールに変更があれば未完了とし、内容の欠落を黙認しません。
大きなブランチ比較は、レビューコンテキストに示す固定 OID 範囲を使って自己収集できます。
シェルの diff は二つの実行抑止フラグの直後にその範囲を置き、パスは `--` の後だけで指定します。
ブランチ名・`HEAD`・追加 revision・`--no-index` は拒否します。
ゲート有効時に fingerprint の取得が失敗すると、Grok を起動せずに明示的に終了をブロックします。
レビュー済みとは扱わず、取得失敗中に Stop が繰り返されても追加レビューは起動しません。

フラグより後に残ったテキストは、レビューの注目点として Grok に渡されます。

指摘は利用者の言語で返されます。スラッシュコマンドとして実行した場合、Claude は会話の言語を
`--language <bcp47>` で自動的に渡します。コンパニオンスクリプトを直接呼び出す場合は、
`--language` を自分で指定してください。指定しなければ、注目点として渡したテキストの言語、
それも判定できなければ英語が使われます。これは `/grok:adversarial-review` と `/grok:audit` にも
適用されます。

レビューの権限処理は、ファイルへの書き込み要求と許可リスト外のシェルコマンドを拒否します。
ただし OS のサンドボックスではありません。フィルターを実行し得る作業ツリーの Git 照会と
子 Git を使うサブモジュール差分は実行前に拒否し、安全に収集できなければ前述の明示エラーにします。
直近のコミット履歴は、レビュー用の Git 保護設定の下で `git log` に
`--since=YYYY-MM-DD` と `--oneline` を指定して参照できます。
Grok は変更案を報告し、ファイルを直接編集しません。
読み取り専用の実行では、リポジトリ内の単一パスに対する `Test-Path -LiteralPath` も、
絶対パスを含めて許可します。リポジトリ外のパスと、リンクを経由して外へ出るパスは拒否します。
組み込みの `WebFetch` は、認証情報を含まない HTTP(S) URL の取得要求ごとに一回限りの権限を許可し、
読み取り専用のレスキューやレビューでも公開資料を参照できます。追加の入力項目は拒否します。

レビューと監査は、一つの Grok セッションで各観点を調査します。読み取り専用の実行環境では
サブエージェントへ委任できません。権限要求が拒否された場合、または Grok が必要な調査の未完了を
報告した場合は、承認ではなく `incomplete` としてジョブを失敗にします。終了時レビューゲートも、
権限要求が拒否された場合や Grok のターンが正常終了しなかった場合は失敗します。
最終応答より前にレビューが停止した場合は、途中の本文を未完了として表示し、
完了済みレビューの JSON 修復には送りません。
`/grok:result <job-id>` で保存済みの結果と記録された権限拒否の理由を確認できます。
未完了のレビューは、再表示でも未完了として表示されます。

Claude Code と Codex のどちらでも、すべての Grok コマンドをフォアグラウンドで実行します。
コマンド出力、正確な Grok ジョブ ID、キャンセル、保存済み結果を一つの一貫したライフサイクルで
扱えるためです。レビュー・監査・タスク実行の旧 `--wait` は互換性のため何もしないフラグとして
受け付けますが、`--background` はエラーとして拒否します。`status <job-id> --wait` は引き続き
対象ジョブの完了を待ちます。

Codex向けスキルはコンパニオンのバッファ済みJSONモードを使用するため、長時間のレビュー、監査、
委任タスク、X検索ではGrokの完了までチャットへ途中経過を流しません。詳細な進捗は保存済みジョブログと
statusコマンドから確認できます。Claude Codeでは従来どおり、ネイティブの前景Bash表示を維持します。

レビューのJSON再出力にも失敗した場合、最新の応答とエラーを結果へ保存します。
有効な構造化結果を取得できないレビューは、失敗として扱います。保存済みの出力は
`/grok:result <job-id>` で確認できます。

### `/grok:adversarial-review`

対象の指定方法は `/grok:review` と同じですが、Grok は出荷に反対する立場から、変更をまだ
取り込むべきでない最も強い理由を報告します。

```bash
/grok:adversarial-review
/grok:adversarial-review --base main
/grok:adversarial-review focus on the migration path
```

バランスの取れた要約ではなく、強い反論が欲しい場合に使用します。

### `/grok:audit`

差分ではなく、既存コードベース全体を監査します。現在の変更内容とは無関係に、現状のソースに
対する Grok の見解が欲しい場合に使用します。

```bash
/grok:audit
/grok:audit focus on the auth module
```

監査コンテキストには意図的に差分もファイル内容も含めず、ファイル一覧だけを渡します。Grok は
読み取り専用コマンドを使い、調査対象のファイルを自分で選んで読み取ります。注目点を指定しない場合は、
アーキテクチャを把握し、最もリスクの高い実行経路を選び、呼び出し元、状態遷移、境界、失敗経路、
並行処理、テストまで追跡する、リスク指向の詳細監査を実行します。大規模なリポジトリでは、特定の
サブシステムや観点に詳細監査を絞りたいときに注目点を指定すると効果的です。

`/grok:review` と同じ権限規則と制約が適用されます。

### `/grok:rescue`

問題を Grok に渡し、その回答を返します。「行き詰まったので、別の視点で見てほしい」という場合に
使うコマンドです。

```bash
/grok:rescue why does the upload retry loop never terminate?
/grok:rescue --resume
/grok:rescue --model latest --effort high
```

プラグイン経由の再開は、対象セッションのターン終了が、再開を担うブローカーと同じ世代で確認済みの場合だけ許可します。
ブローカーの再起動後や、終了確認のない直接起動・旧版の履歴では `--resume` を拒否します。
保存済みセッション ID やジョブの完了記録だけでは証明になりません。安全に再開できなければ、新規タスクを開始してください。

レビューコマンドとは異なり、`/grok:rescue` は既定で書き込み可能な状態で実行されるため、Grok は
作業中にファイルを編集できます。診断だけが必要な場合は、依頼文に `read-only`、`just investigate`、
`don't change anything` などと明記すると、読み取り専用で実行されます。

Companion を直接呼ぶ場合、複数行の UTF-8 依頼文には
`task --json --fresh --prompt-file <絶対パス>` を使えます。読み取り専用では `--write` を省略します。
`--read-only` という CLI フラグはありません。PowerShell では長い依頼文を here-string に埋め込むより、
プロンプトファイルを使ってください。

モデルの別名は `fast`、`reasoning`、`multi`、`build`、`latest` です。それ以外の値はモデル ID として
そのまま渡されるため、`--model grok-4.7` のような指定もできます。`--effort` には `low`、`medium`、
`high` を指定できます。

### `/grok:x`

Grok Build を介して X（Twitter）の投稿を検索し、投稿者のハンドル、日付、投稿 URL を含む結果を
返します。Grok Build 独自の `x_keyword_search` と `x_semantic_search` ツールを使って X へ
アクセスするため、他のコマンドと同じ `grok login` の認証情報で利用でき、xAI API キーは不要です。
通常の Web 検索では X のタイムラインを読み取れないため、独立したコマンドとして用意されています。
明示的に期間を指定しない限り、検索対象の期間は絞りません。

```bash
/grok:x what are people saying about the latest Avalonia release
/grok:x --model latest reaction to the new pricing announcement
```

実行は常に読み取り専用です。1 回の検索で Grok Build の完全なセッションを実行するため、通常は
数分かかり、完了まで接続を維持します。

### `/grok:status`

リポジトリの実行中および最近の Grok ジョブと、レビューゲートの状態を表示します。

```bash
/grok:status
/grok:status --all
/grok:status <job-id> --wait
```

### `/grok:result`

完了したジョブの保存済み最終出力を表示します。

```bash
/grok:result
/grok:result <job-id>
```

各結果には Grok セッション ID と `grok --resume <id>` コマンドが含まれるため、Grok 独自の TUI で
会話を再開できます。この外部コマンドの表示は、プラグイン経由の安全な再開の証明にはなりません。
`/grok:rescue --resume` は、同じブローカー世代でのターン終了確認を別途必要とします。

### `/grok:cancel`

実行中の追跡ジョブと、そのジョブで動いている Grok のターンのキャンセルを要求します。

```bash
/grok:cancel
/grok:cancel <job-id>
```

ジョブ ID を省略すると、現在のセッションで唯一実行中のジョブが選択されます。複数のジョブが
実行中の場合は推測で選ばずに停止し、ジョブ ID の指定を求めます。`/grok:status` で対象を
選んでください。
プロセスの停止を確認できない場合、ジョブは `/grok:status` に保留中として残ります。
`/grok:cancel <job-id>` を再実行してください。キャンセルが完了するまで、結果の取得とタスクの再開はできません。
終了済みの履歴が増えても、実行中・保留中のジョブは追跡を維持します。キャンセル時のログ書き込みに
失敗した場合は警告を表示し、プロセスの停止処理を続けます。
現行 runtime は明示移行まで状態の書込みを拒否し、旧 file lock の取得・回収は行いません。
旧 runtime には所有者確認と削除の間の競合や死者 lock の自動回復未対応が残るため、移行前にすべて停止してください。
既存の旧 lock ファイルは削除せず保持します。
キャンセル確定には、ワーカーの停止確認が必要です。接続準備前に未送信と確認できるジョブを除き、
ブローカージョブでは実行 ID に対応する取消予約とターン終了の確認も必要です。
直接起動ジョブは後述の協調停止で確認します。停止の証拠がない旧ジョブは、ワーカーが止まっても保留に残り得ます。
再試行だけで不足する証拠を補えるとは限らず、取消済みとは表示せず、結果の取得も許可しません。
起動準備中やプロンプト送信の成否が不明な場合は、ワーカー終了後もキャンセル保留を維持します。
完了履歴があっても、対象セッションのターン終了を同じブローカー世代で確認できなければ、プラグインからは再開できません。
ブローカー再起動後、直接起動の履歴、未確認の旧版履歴は、保存済みジョブの状態とは別に再開を拒否します。
Windows のキャンセルは共有ブローカーを保護するため、追跡ワーカーだけを停止し、プロセスツリー全体を終了しません。
Windows では同じプロセスハンドルで高精度の開始時刻を照合して停止します。旧 CIM 識別子は
この方法で確認できないため、キャンセルを保留します。POSIX では追跡 worker に数値 PID で signal を送らず、自然終了を確認します。

Windows 10 / Windows Server 2016 以降で Grok agent を直接起動する場合、supervisor が agent と子孫を
専用 Job Object に所属させます。worker と共有 broker は所属させません。Job の `ActiveProcesses = 0` を
確認した supervisor の ACK だけで停止を確定し、起動・停止処理の失敗や ACK 欠落は停止未確認として扱います。
`/grok:cancel` は所有 worker に direct agent の協調停止を要求し、同じ世代と worker 識別情報に結び付いた
停止証拠の保存を確認してからキャンセルを確定します。旧ジョブ、証拠保存前の worker 死亡、確認期限超過は保留に残ります。
期限超過でも所有 worker は確認を続けられるため、`/grok:cancel <job-id>` を再実行してください。
POSIX の直接起動では、その起動で所有する detached process group だけへ SIGTERM を送り、
直子の出力を読み終えた後の close と group の不在を確認します。別 session/group へ逃れた子孫は対象外です。
直子終了後も子孫が残る場合はキャンセルを保留し、直子終了後に group へ再度 signal を送りません。
signal は標準の Node.js/libuv を前提とし、独自にプロセスを reap・再編成する native 拡張は保証対象外です。
全 OS のセッション終了処理では、agent の停止証拠、worker の終了の順に確認し、未確認のジョブを保持します。
POSIX の broker 起動失敗時は、その起動で作った detached process group だけを停止して不在を確認します。
別 group へ移った子孫の終了までは保証しません。
通常の idle broker 清掃も、Windows では同じ世代の agent Job が空である証拠、POSIX では broker の所有 group の
不在を要求します。停止要求の受付や broker PID の消滅だけでは清掃を確定しません。

Windows でプロセス照会に失敗すると、stderr と、利用可能な場合は `/grok:status` に表示される既存の
ジョブログへ `Process lookup diagnostic` という文字列付きの JSON を出力します。この文字列で検索できます。
キャンセル保留の調査に使うため、診断記録を保持してください。`not-observed` は開始記録を観測できなかった
意味で、プロセスが起動しなかったことを意味しません。照会成功時は診断記録を出力しません。
記録項目・機密情報の境界・解釈は [プロセス照会診断](DESIGN.md#プロセス照会診断)、
開発時の検証手順は [AGENTS.md](AGENTS.md) を参照してください。

### `/grok:setup`

ローカル環境のインストール状態を確認し、必要に応じて終了時のレビューゲートを切り替えます。

```bash
/grok:setup
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

ゲートは有効にするまで無効です。対応範囲内の Windows スナップショットでユーザー入力時の基準を保存し、
そのターンの変更だけをレビューします。変更のないターンは除外します。基準は圧縮後に Windows DPAPI の
現在のユーザーで保護し、ワークスペース・セッション・ターンと結び付けます。欠落・不正・容量超過なら
終了をブロックするため、新しいユーザーターンを送って基準を取り直してください。未対応のスナップショットも
Grok 起動前にブロックします。`/grok:setup --disable-review-gate` で再び無効にできます。
基準の取得と保護には、ワークスペース照会前から数えた45秒の残り時間を使います。最初の同期照会自体は
この期限では中断されません。照会後、有効なゲートの基準状態を初期化できなかった場合は入力をブロックするため、
エラーを解消してから再送してください。

状態の更新と lock 付き状態 snapshot の前には、新しい状態ディレクトリでも明示移行が必須で、自動では実行しません。
未移行では旧 file lock を使わず拒否します。保存済み状態の直接読取は可能ですが、lock 付き snapshot ではありません。

| OS | 対応するローカル保存先と必須ツール |
| --- | --- |
| Windows | NTFS 固定 volume。Windows PowerShell と検証可能な directory/volume identity が必要です。FAT・ReFS・network・判定不能は拒否します。 |
| macOS | local APFS。`/usr/bin/lockf`、`/sbin/mount`、有効な `IOPlatformUUID` を返す `/usr/sbin/ioreg` が必要です。 |
| Linux | local ext4 または tmpfs。`/usr/bin/flock`、読取可能な `/etc/machine-id` と `/proc`、一致する FS/device 検査が必要です。同じ state の利用者は sentinel と同じ PID・time・network namespace と互換のある `/proc` view を使う必要があります。 |

utility 不在、host 識別不能、FS や marker の identity を検証できない場合は明示エラーにします。
全ホストの旧 runtime・broker・agent・worker・supervisor と、それらを遅延起動し得るプロセスを停止して再起動を防ぎ、
同期コピーを含む他ホストからの同時利用を排除したうえで、
プラグインのディレクトリから実行します。
旧 writer の barrier だけでは、旧 agent の遅延起動を防げません。

移行するホストの実行時と、workspace・環境変数を正確に一致させてください。手動で開いたシェルにはホストの
`CLAUDE_PLUGIN_DATA` / `PLUGIN_DATA` が継承されない場合があるため、実際の値と設定・未設定の状態を再現します。
優先順位は `CLAUDE_PLUGIN_DATA`、次に `PLUGIN_DATA` で、両方未設定なら OS の一時ディレクトリを使います。
値・一時ディレクトリ・workspace の別名が異なると、別の空の状態を移行する可能性があります。
Claude Code と Codex は各ホストの実際の保存先ごとに個別に移行し、別の場所での成功を既存データの移行と扱わないでください。
必須の `--expected-state-dir` には、そのホストの未移行エラーの `State directory (data):` 行が示す実際の絶対パスを
入力します。手動シェルで別の保存先を選ばないでください。未指定・相対パス・実効保存先との不一致は作成前に拒否します。
成功出力の `stateDir` が対象と一致することを確認してください。`--json` の結果にも `stateDir` を返します。

```powershell
node scripts/grok-companion.mjs state-lock migrate --offline-confirmed --local-only --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

placeholder を実際のパスへ置き換え、`$` や backtick が展開されないよう PowerShell の単一引用符を維持してください。
単一引用符で囲んだパス内の `'` は、PowerShell では `''` と記述します。

macOS/Linux では POSIX shell を使います。macOS では次のコマンドは新規状態の初期化に使います。
既存の旧 file lock や旧 marker は、後述のとおり拒否されます。

```sh
node scripts/grok-companion.mjs state-lock migrate --offline-confirmed --local-only --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

shell 展開を防ぐ単一引用符を維持します。パス内の `'` は引用部分を閉じ、`"'"` を挟んで再開します。
たとえば `'before'"'"'after'` と記述します。

Windows / Linux で既存の旧 lock ファイルを理由に移行を拒否された場合:

1. 最初に、全ホストの旧 runtime が停止済みで再起動しないこと、他ホストが状態へ同時アクセスしないことを確認します。
   上述のホスト環境と workspace も一致させます。
2. 拒否に表示された正確な絶対パスの `state.lock` を確認します。通常ファイルで、リンクのない実パスを確認できた場合だけ
   （下記の POSIX パス確認を参照）、同じディレクトリの未使用名へ手動で改名して保管します。削除や他の項目の上書きはしません。
   symbolic link・junction・ディレクトリ障壁・不明な状態にはこの手順を適用しないでください。
3. 全旧 runtime を停止したまま、同じ明示移行を再実行します。保管した旧ファイルを残したまま、元の `state.lock` パスへ
   新しい障壁を作ります。両方とも保持してください。

macOS/Linux では、macOS の `/var` → `/private/var` のような既知の OS 標準 alias が、表示パスの祖先に含まれる場合があります。
保管前にホストが報告した state directory と正確な `state.lock` の両方を解決します。次の読取り専用確認は、
`state.lock` 自体のリンクを拒否し、その実パスの親が state directory の実パスと一致することを要求します。

```sh
node -e 'const fs=require("node:fs"),p=require("node:path");const [reported,lock]=process.argv.slice(1);if(!p.isAbsolute(reported)||!p.isAbsolute(lock))throw Error("Absolute paths required");const s=fs.lstatSync(lock);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error("Unsupported state.lock");const realStateDir=fs.realpathSync(reported),realLock=fs.realpathSync(lock);if(p.dirname(realLock)!==realStateDir||p.basename(realLock)!=="state.lock")throw Error("State directory mismatch");console.log(JSON.stringify({realStateDir,realLock,kind:s.isFile()?"file":"directory"},null,2));' '<host-reported-state-dir>' '<exact-reported-state.lock>'
```

Linux の復旧では、出力された実パスが対象の host/workspace の状態であることを確認し、検証した実体の `state.lock` だけを同じディレクトリの
未使用名へ保管します。不明なリンクを解決して保管したり、`state.lock` 自体の symbolic link・junction を保管しないでください。
CLI の `--expected-state-dir` には引き続き**ホストが報告した元の state directory**を使い、workspace と環境変数も一致させます。
手動確認に使ったという理由で、解決後のパスへ置き換えないでください。

フラグは利用者が実行前提を確認したことを表し、旧ランタイムや他ホストの不在を自動で保証するものではありません。
同じ MachineGuid を持つ clone を含め、前提を満たす責任は利用者にあり、ホスト識別子の照合はマシンの一意性や
単一ホスト専用であることを保証しません。状態とジョブは保持し、既存の旧ロックファイルは削除せず拒否します。
旧版との同時書込みを防ぐ永続的な障壁と準備メタデータを保持します。Windows では中断後に同じ明示移行を再実行します。
旧ロックファイルの削除や移行 marker の巻戻しは行いません。不完全・不正な marker は明示エラーにします。
旧 runtime 自体には従来の排他リスクが残るため停止したままにしてください。現行 runtime は未移行の書込みを拒否します。
macOS/Linux では `state.lock/native.lock` を恒久ファイルとして使い、`protocol.json` と `prepared-*.json` も保持します。
通常の解放や runtime の異常終了時は OS が保持中の lock を解放するため、ファイルの削除は不要です。
marker は host・FS と、state directory・barrier・管理ファイルの device/inode identity を照合します。
POSIX の状態ディレクトリと管理対象は、実行ユーザーの所有で private な permission が必要です。
`st_dev` が変化した場合や marker が不正・不完全な場合、自動で上書きしません。FS 同期の成功は電源断時の物理的な耐久性の保証ではなく、
不完全な移行は保全します。Linux の offline 復旧では、
最初に**全 runtime** と遅延起動し得るプロセスを停止し、再起動防止と単一 host 利用を確認します。正確な `state.lock` が対象の directory barrier で、
既知の OS alias を含む場合は上述の POSIX パス確認も行い、リンクのない実パスを確認してから、
state directory 内の未使用の別名へ barrier 全体を改名して保管します。
その後、同じ host 環境・workspace と正しい `--expected-state-dir` で明示移行を再実行します。
symbolic link や不明なパスへこの復旧を適用せず、保管した barrier と既存 state を保持してください。

macOS の現行 marker は `posix-local-v4` です。旧 marker は保全して拒否し、自動更新しません。
旧 file-lock の移行には `--all-old-processes-stopped` と正確な保存先が必要ですが、現行実装では
移行完了の証拠が未統合のため、これらを指定しても拒否されます。旧プロセスを停止したまま記録を保全してください。
フラグや marker の変更で移行できるようにはなりません。
移行時には既存の state と job 記録も検査し、未知・欠落・不整合・サイズ超過の記録を拒否します。
特に `state.lock` の隣に保管した旧 lock や barrier は未知の state directory entry となり、移行を妨げます。
既存 lock・marker・記録の検査で拒否された場合は、旧プロセスを停止したまま state・jobs・barrier を保全して調査してください。
移行を強行するために記録を削除・手動変更しないでください。これら macOS のケースを自動保管・復旧する汎用コマンドはありません。

macOS は worker を 256 個の lease slot で追跡します。空きがない場合、最大 16 slot を上限 5 秒で走査します。
走査に成功すれば予約を 1 回再試行し、走査の時間切れや再試行後も空きがない場合は新しい job が失敗します。
identity・記録・参照や turn / worker の停止が確認できない slot は保全します。
逆参照の検査は state の job 4,096 件と jobs directory の 4,096 entry が上限で、超過した場合は回収可能の証拠になりません。
容量不足時は実行中の job の終了を待って再試行し、エラーが続く場合は lease file を削除したり未確認の job や turn の停止を
推測したりせず、記録を保全して調査してください。

Linux では移行時に長寿命 sentinel を起動し、新しい epoch を作ります。同じ state を使う全プロセスは、sentinel と同じ
PID・time・network namespace と互換のある `/proc` view を維持する必要があります。sentinel が停止・障害になった場合は、
全 runtime と遅延起動し得るプロセスを停止し、再起動を防止して、他 host が state を使っていないことを確認します。
上記の barrier 保管と明示移行を行い、新しい sentinel と epoch を作ってください。停止中・無効な sentinel に対して
`recover` を直接実行することはできません。有効な marker と稼働中の sentinel が必要です。

旧版からの移行後を含め旧 admission 記録が残っている場合、全旧プロセスを停止したまま、sentinel が稼働し marker が有効な状態で
次を実行して、現在の epoch の復旧を明示的に記録します。

```sh
node scripts/grok-companion.mjs state-lock recover --offline-confirmed --local-only --all-old-processes-stopped --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

Linux sentinel を計画的に停止する場合は、先に全 runtime と遅延起動し得るプロセスを停止して再起動を防止し、単一 host 利用を確認したうえで、
同じ host 環境と workspace を使って次を実行します。

```sh
node scripts/grok-companion.mjs state-lock stop-sentinel --offline-confirmed --local-only --expected-state-dir '<absolute-state-dir>' --cwd '<workspace>'
```

`recover` は現在の epoch にある未確定・破損・容量不足の admission 記録を修復しません。この場合は上記の全停止と単一 host の
条件を満たし、`stop-sentinel`、barrier の保管、新しい epoch への移行を順に行ってから、保持した旧記録に対して `recover` を実行します。
再利用前に上記の offline barrier 保管と明示移行を行い、旧 admission 記録が残る場合は復旧してください。
復旧記録・旧ジョブ・既存の POSIX broker socket、PID ファイル、ログは保全します。復旧は旧ターンの成功・失敗を証明しません。
Linux の復旧は、broker と direct の旧 epoch ディレクトリ合計が 64 件（通常は旧 epoch あたり 2 件）、または旧ファイル合計が 64 MiB を超える inventory を拒否し、
明示 `recover` でもそのまま再開できません。安全な保全アーカイブ方式は未実装です。旧記録は保持し、独立した保全方法なしに削除・変更しないでください。

いずれかの runtime が稼働中は、同じユーザーの別プロセスも含め、state directory・祖先・native lock・marker・prepared を
外部から変更・置換・削除したり、mount・link・junction を変更しないでください。同一ユーザーの改変を防ぐ保護ではありません。

Windows の v2 native mutex は canonical なパス文字列ではなく、
volume 上の状態ディレクトリの OS identity（`dev` + `ino`）を使い、同じ実体の別名・改名後も同じ排他を共有します。
対応は NTFS のローカル固定 volume に限り、FAT・ReFS・その他のファイルシステム・判定不能の場合は拒否します。
実ディレクトリ handle から取得した NTFS 固定 volume の canonical GUID も v2 移行 marker へ保存します。
volume GUID が欠落・不正・不一致なら、`dev` と `ino` が一致していても拒否します。
identity が不明・0・別実体の場合や旧 v1 marker は拒否し、自動置換しません。いずれかの runtime が稼働中は、
状態ディレクトリや祖先の改名・置換・junction 変更をしないでください。identity 検査と個々のパス操作の間の差替えを
阻止する handle 相対 I/O は未実装です。改名時の mutex の同一性を維持しても、その後の全 I/O の対象固定は保証しません。
ただし、ワークスペースを別名の junction 経由で開くと、元の workspace basename と実パスのハッシュを組み合わせる
既存の保存先規則により、別の状態ディレクトリへ分岐する場合があります。移行はそれらを統合しません。

## よくある使い方

### 出荷前にレビューする

```bash
/grok:review
```

指摘を読み、必要な箇所を修正してから、もう一度実行します。

### 問題を Grok に任せる

```bash
/grok:rescue the websocket reconnect drops messages under load
```

### 時間のかかる処理を実行する

```bash
/grok:rescue port the settings screen to the new form API
```

## モデルの選択

このプラグインは既定で `grok-4.7` を指定します。1 回の実行だけ変更するには `--model` を、
すべての実行で変更するには `GROK_PLUGIN_MODEL` を設定してください。

これは見た目以上に重要です。`XAI_API_KEY` で認証した場合、Grok の新しいセッションでは既定で
推論を行わないモデルが使われ、レビューの品質が明確に低下するためです。

## よくある質問

### このプラグイン専用のアカウントは必要ですか？

いいえ。ローカル環境の Grok Build が現在サインインしているアカウントをそのまま使用します。

### 既存の Grok 設定は使用されますか？

既存の Grok Build の認証を使用します。レビューと委任された `/grok:rescue` タスクは、
タスクを再開する場合も含め、空の MCP サーバー一覧でセッションを要求します。
プラグインはこれらのセッションにグローバルの MCP サーバーを接続しません。

### `/grok:review` は本当に読み取り専用ですか？

プラグインはファイルへの書き込み要求、許可リスト外のシェルコマンド、出力リダイレクトを拒否します。
フィルターを実行し得る作業ツリー照会は拒否し、収集を未完了として報告します。
この権限処理は OS のサンドボックスではありません。

### `/grok:transfer` がないのはなぜですか？

上流の Codex プラグインは Claude Code のセッションを Codex のタスクへ取り込めましたが、
Grok Build には同等の機能がありません。そのため、不完全な代替機能を装うのではなく、コマンドを
削除しています。

## ライセンス

Apache-2.0 です。[LICENSE](./LICENSE) と [NOTICE](./NOTICE) を参照してください。
