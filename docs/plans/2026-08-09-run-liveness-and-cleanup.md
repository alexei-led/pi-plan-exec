# Run liveness, resume, and cleanup

Status: design. Written 2026-08-09 after diagnosing run `31f750ca` in `agentbundler`.

## What actually happened

The report was "resume says running but nothing is running; the status file is wrong
and blocking the resume." The evidence says the opposite.

- `/exec resume 31f750ca` spawned a real worker: child `pi` pid `48567`, parent `46563`
  (the Pi session), one established TLS socket, 6.45s CPU over 5:23 elapsed.
- It was mid-model-call the entire time it looked dead. It finished Task 5 on its own,
  and the run advanced to `comprehensive_review`. Nothing was killed or repaired.

Resume worked. Cleanup did not exist. What failed in between is **observability**:
for the whole run there was no signal separating "worker thinking on a long model call"
from "worker dead".

The bridge async dir writes `status.json` only on workflow trace events:

```
startedAt  1786251962677
lastUpdate 1786251962700   <- 23 ms later, then frozen for ~9 minutes
```

`/exec status` polled `bridge.status()` every second, kept getting `running`, kept
refreshing `lastObservedAt`, and kept printing:

```
recovery: healthy active operation
next safe action: wait; the controller is polling this operation.
```

That text is correct and useless. It is byte-identical for a healthy worker and for a
worker whose process died — exactly the ambiguity that was hit.

The "no real task list" symptom was the same misperception. The projection was intact:
`.pi/tasks/tasks-019fe4e9-….json` held all 12 tasks with `updatedAt` tracking the live
session. Nothing to fix there.

## Three distinct defects

### D1 — The one signal that crosses the RPC boundary is discarded

`normalizeObservation` (`plan-exec-rpc.ts:319`) returns
`{runId, state, asyncDir, resultPath, text}`. plan-exec parses `state` and drops `text`.

`text` is the pi-subagents status blob, and its format
(`pi-subagents/src/runs/background/run-status.ts:383-440`) already includes:

```
State: running
Activity: active 12s ago | no activity for 47m | needs attention
Progress: <label>
Updated: <ts>
Turn budget: 14/75+5 (within)
Step 1: main running, active 12s ago
Session: <child session.jsonl>
```

`formatActivityLabel` (`shared/status-format.ts:11`) drives `Activity:` off an
`activityState` machine with `active` / `active_long_running` / `needs_attention` —
precisely the distinction that was missing.

**Caveat, verified against the live run.** For `mode: "workflow"` — which is what the
bridge spawns — pi-subagents does not populate the activity fields. The live
`status.json` keys are
`[cwd, lastUpdate, mode, pid, runId, sessionId, startedAt, state, steps, toolCallId, workflow]`;
`lastActivityAt` and `activityState` are absent at both run and step level, and no
`nested-subagent-runs/<runId>` directory is created. So the plumbing exists end to end
and carries nothing today.

The only artifact that moves per turn is the child transcript at
`<parent session dir>/<8-hex runId>/run-0/session.jsonl` (692 KB and growing during
the run). plan-exec cannot address it: the 8-hex id is
`randomUUID().slice(0, 8)` minted inside `subagent-executor.ts`, unrelated to the
workflow UUID plan-exec holds, and a session can own several concurrent workers — the
pane footer read `2 active agents` — so newest-mtime globbing would misattribute.

Do not reach for `status.json`'s `pid` either. It is `46563`, identical to
`run.json`'s `lease.pid` — the Pi session, not the worker. Checking it asks whether
the poller is alive, which is true whenever the check runs.

### D2 — No staleness bound when the bridge answers `running`

There is one bound today, and it fires only on RPC failure: `MAX_STATUS_FAILURES` in
`recordObservationFailure` (`controller.ts:983`) fails the run after repeated bridge
errors. The gap is the other path — the bridge answering `running`, cheerfully,
forever.

`recoverActiveOperation` (`controller.ts:670`) has one time check, and it is a _delay_,
not a _deadline_:

```ts
if (Date.now() - operation.launchStartedAt < OPERATION_RECOVERY_DELAY_MS)
  return run;
```

A worker that hangs on a socket leaves `status: "running"` indefinitely, and
`recoveryGuidance` returns `"wait"` indefinitely.

Same gap on the lease. `RunRegistry.claim` compares `heartbeatAt` against a 30s
threshold but never asks whether `lease.pid` is alive — even though `registry.ts:319`
already has `isProcessRunning`, used for lock files and not for leases. Current state:

| run        | status | stage          | lease heartbeat age |
| ---------- | ------ | -------------- | ------------------- |
| `33a8a81e` | failed | finalize       | 31234 min           |
| `5d9c619f` | failed | archive        | 28304 min           |
| `86b33239` | failed | implementation | 8330 min            |
| `b3121369` | failed | resolve        | 37117 min           |
| `c07c4a71` | failed | implementation | 1211 min            |

Five dead leases pointing at pids that have not existed for weeks.

### D3 — Terminal runs are never removed

`RunRegistry` has `create get list update claim heartbeat release`. No `delete`.
`/exec` has `help setup runs status pause resume adopt skip cancel start`. No `cleanup`.

`formatRunList` prints every directory under `~/.pi/plan-exec/runs/`, unfiltered.
Eight today; the oldest is from Jul 14; two are `completed_with_findings` — fully done,
still listed. That is the "multiple stalled runs and it's not clear when they will
disappear".

The `archive` stage (`controller.ts:1361`) commits the plan file and marks the run
terminal. It does not retire the registry entry.

## Why ralphex does not have these problems

ralphex is a supervising CLI, not an in-session extension. Three properties follow:

1. **The plan file is the state.** `[x]` checkboxes plus an append-only
   `.ralphex/progress/progress-<plan>.txt` are the whole durable record. Resume =
   re-parse the plan, find the first unchecked task, run it. There is no run object to
   get stuck in `running`, so there is nothing to unblock.
2. **Kernel-owned locks.** `pkg/progress/flock_unix.go` uses `syscall.Flock`. The
   kernel releases it when the process dies. No heartbeat, no pid check, no staleness
   timeout, no stale-lock garbage — the failure mode is structurally impossible.
3. **The supervisor owns the process tree.** `pkg/executor/procgroup_unix.go` starts
   children with `Setsid`, then `SIGTERM` → 100 ms → `SIGKILL` on the whole group, both
   on cancel and after normal exit, explicitly so orphaned node subagents and MCP
   servers do not accumulate. Liveness comes from the child's stdout via
   `linereader.go` — a stream that moves, not a file that may never be rewritten.

pi-plan-exec cannot copy (2) or (3): it lives inside a Pi session, the worker is
spawned by pi-subagents, and the run must survive session restart and adoption by a
different session. That constraint is real, and the cross-session registry is the right
answer to it.

The mistake is that the registry inherited a supervisor's _claims_ (`status: running`,
`activeOperation`) without a supervisor's _guarantees_. A record asserting "running"
must be falsifiable by whoever reads it.

## Design rules

**R1. A persisted `running` claim must be independently falsifiable.**
Never trust a stored status alone. Derive what you can at read time from evidence that
moves. Where no such evidence exists, say so — do not let absence of signal render as
health.

**R2. Every in-flight operation carries a deadline.**
Absence of a bound is not patience, it is a leak. On breach, classify; never silently
kill.

**R3. Terminal state is retired, not accumulated.**
A registry that only grows is a registry nobody trusts. Retire on a policy, and make
the policy visible in the listing.

**R4. Guidance must discriminate.**
`"wait"` is only useful if some other input produces something else. Guidance must be a
function of observed evidence, not of stored status alone.

## Fixes

### F1 — Surface the observation text (`controller.ts`, `index.ts`)

`bridge.status()` already returns `text`. Parse the lines that exist —
`Activity`, `Progress`, `Turn budget`, `Updated`, the `Step N:` lines — and persist a
compact digest on `activeOperation` as an optional `workerSignal` field. Render it in
`formatRunStatus`.

When the text carries no activity line, print that fact rather than nothing:

```
worker: bridge reports running, 9m since launch
        no per-turn activity signal (workflow-mode run)
```

versus, once upstream populates it, or for non-workflow runs:

```
worker: active 12s ago, turn 14/75
```

This is the change that resolves the original complaint, and it is small: no new
module, no new process inspection, no mapping problem. R1, R4.

Add one cheap corroborating check while reading: `stat` `operation.asyncDir`. It gives
coarse start/end liveness only — it was frozen for the whole 9-minute run — but a
_missing_ asyncDir is decisive evidence the operation is gone (temp root wiped on
reboot), which today reads as `running`.

### F1a — Upstream ask (pi-subagents)

The right long-term fix is not in plan-exec. `steps[].lastActivityAt` and
`steps[].activityState` are already in the status schema, already rendered by
`run-status.ts`, and already used by the TUI — they are simply not written for
`mode: "workflow"`. Populating them makes F1 a one-line parse and gives every bridge
consumer a real heartbeat. File this against pi-subagents; F1 is written so it starts
reporting the moment upstream lands, with no plan-exec change.

### F2 — Stalled classification (`controller.ts`, `index.ts`)

Add an operation deadline. Because no per-turn signal is available today, key it on
elapsed-since-`launchStartedAt`, and name the uncertainty honestly:

```
classification: long-running active operation
action: bridge reports running after 52m with no per-turn activity signal.
        /exec status <id> to re-check, /exec cancel <id> to stop and preserve
        the worktree. Do not start a second run.
```

Never auto-fail, never auto-kill. When F1a lands, tighten the deadline and change the
wording to a genuine stall claim; until then this is a prompt to look, not a verdict.
R2, R4.

**Do not ship a flat wall-clock constant.** The only measurement available is one
~6-minute implementation task; a review stage under `think:xhigh` could plausibly run
far longer, and a false banner on a healthy run recreates the exact non-discriminating
guidance this fixes. Derive the deadline from the stage's own budget —
`config.workerMaxTurns` (75) and `config.reviewerMaxTurns` (30) — times a per-turn
allowance, rather than one number for every stage. Treat any initial value as a
placeholder pending measurement across real runs, and say so in the code comment.

### F3 — Lease liveness (`registry.ts`, `index.ts`)

`isProcessRunning` already exists at `registry.ts:319` and is already used for lock
files. Use it for leases:

```ts
function isLeaseLive(lease, sessionId) {
  if (lease.sessionId === sessionId) return true;
  if (Date.now() - lease.heartbeatAt >= LEASE_STALE_MS) return false;
  return isProcessRunning(lease.pid); // new
}
```

A lease whose pid is gone is dead immediately — no 30s wait, no manual `/exec adopt`.
Same predicate backs `isStaleOwner` (`index.ts:492`).

Store `hostname` on the lease and skip the pid check when it differs, falling back to
the heartbeat threshold: pid liveness is only meaningful on the same host.

Migration: all 8 existing runs have a lease with no `hostname`. Absent `hostname` means
**unknown host** — skip the pid check and use the heartbeat threshold alone. Make that
explicit, or the five dead leases behave inconsistently on the first run after upgrade
depending on whether the implementation reads missing-as-match or missing-as-mismatch.
`lease.hostname` is optional, so no `schemaVersion` bump here either.

### F4 — `/exec cleanup` (`registry.ts`, `index.ts`)

`RunRegistry.remove(runId)` — delete the run directory. Refuse when the run is
non-terminal or its lease is live.

```
/exec cleanup                    Preview removable runs.
/exec cleanup --apply            Remove them.
/exec cleanup <run-id>           Remove one terminal run.
/exec cleanup --include-failed   Also consider failed runs.
```

Default set: `completed`, `completed_with_findings`, `cancelled`, older than 7 days by
`updatedAt`. **`failed` is excluded by default** — `recoveryGuidance`
(`index.ts:460-484`) makes `/exec resume <failed-id>` the documented recovery path, and
the registry entry is what makes that possible. Five of the eight runs on disk are
`failed`; deleting them by default would destroy the recovery path the tool advertises.

Preview-by-default; `--apply` mutates. Removing a registry entry never touches the
worktree, the branch, or the progress file — say so in the preview output.

### F5 — Retire on archive (`controller.ts:1361`)

On successful `archive`, stamp an optional `retiredAt`. Retired runs drop out of the
default `/exec runs` listing; `--all` still shows them until `cleanup` removes them.
Terminal runs stop being noise the moment they finish, without deleting anything.

### F6 — Listing hygiene (`index.ts` `formatRunList`)

Default view: non-terminal runs, plus terminal runs from the last 24h. Footer states
what was hidden:

```
3 older terminal runs hidden. /exec runs --all to show, /exec cleanup to remove.
```

### Schema

`parseRun` throws on `value.schemaVersion !== 1`, and there are 8 run directories on
this machine. Add `workerSignal` and `retiredAt` as **optional** fields only.
`assertRun` tolerates unknown keys, so no version bump and no migration.

## Dependency versions

`peerDependencies` are already range-based and correct:

```json
"@alexeiled/pi-subagents-bridge": ">=0.2.2",
"pi-subagents": "*"
```

The pin is in the printed setup instructions, `index.ts:1243`:

```
pi install npm:@alexeiled/pi-subagents-bridge@^0.2.2
```

`^0.2.2` refuses `0.3.x`. Installed today: bridge `0.2.3`, pi-subagents `0.44.0`.
Print `>=0.2.2` so setup matches the peer range and does not block the next minor.
Leave the `pi install npm:pi-subagents` line unpinned.

## Order

| #   | Fix                              | Files                                   | Depends on |
| --- | -------------------------------- | --------------------------------------- | ---------- |
| 1   | Setup version range              | `index.ts`                              | —          |
| 2   | Lease pid + hostname liveness    | `registry.ts`, `index.ts`               | —          |
| 3   | `remove` + `/exec cleanup`       | `registry.ts`, `index.ts`               | —          |
| 4   | `retiredAt` on archive           | `controller.ts`, `types.ts`             | 3          |
| 5   | Listing hygiene                  | `index.ts`                              | 4          |
| 6   | Surface observation text         | `controller.ts`, `index.ts`, `types.ts` | —          |
| 7   | Long-running classification      | `controller.ts`, `index.ts`             | 6          |
| 8   | Upstream: workflow step activity | pi-subagents                            | —          |

1-5 are evidence-backed, small, and independent. 6-7 fix the reported symptom. 8 is
what makes 7 a real stall detector instead of a timer.

## Verification

- **F1** — given a `text` blob with and without an `Activity:` line, assert the status
  render says "no per-turn activity signal" in the second case and never implies health.
  Assert a missing `asyncDir` is reported as gone, not running.
- **F2** — table over `(elapsed, has activity signal, bridge state)`; assert a worker
  mid-model-call at 9 minutes is never called dead. That is the regression test for the
  reported bug.
- **F3** — claim a run whose lease pid is dead; assert it succeeds without waiting out
  `LEASE_STALE_MS`. Assert a live foreign pid still blocks, and a foreign hostname
  falls back to the heartbeat threshold.
- **F4** — `cleanup` without `--apply` mutates nothing; refuses live-lease and
  non-terminal runs; excludes `failed` unless `--include-failed`; removes only entries
  past retention.
- **F5/F6** — archived run absent from the default listing, present under `--all`.
