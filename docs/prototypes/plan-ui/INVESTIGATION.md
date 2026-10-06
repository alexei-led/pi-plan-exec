# Execution and visibility investigation

Scope: read-only inspection of the reported run, plan-exec, Bridge, pi-tasks,
and released Pi/subagent contracts. Only the adjacent HTML prototypes and these
notes were added. No execution state, installed package, or worktree was changed.

## The reported run

Run `0de27a3f-b5e8-4e9c-9fa6-6f91b58c141c` is
`cancel_pending/implementation`, with `userStopped=true`. Task 1 still has its
old `running` state. No accepted implementation progress is recorded.

The preserved Bridge operation is
`74c47108-bccb-431c-9367-4246f5edb8f3`. Its matching journal row is
`dispatching`, with cancellation requested but no native run ID, async directory,
RPC request ID, or correlated launch-rejection receipt. The record cannot prove
whether a worker ever started or remains alive. The original launch failure is
not recoverable from the inspected evidence. An `invalid_params` launch failure
is **not established** for this run.

Removing the worktree did not resolve that uncertainty. Git still lists a
prunable registration, while the path contains a recreated progress directory
rather than a usable Git checkout. Do not mark the run cancelled or discard its
operation identity based on missing files.

## Confirmed defects

### 1. Display has no independent lifecycle

[Status rendering](../../../src/index.ts) at lines 557–568 always sets both the
widget and footer status. Stopping its timer (571–576) clears neither. Terminal
runs render before polling stops (654–670). Projection completion and startup
also call this renderer (673, 914). There is no matching UI clear call.

Thus stopping execution, retiring a record, and hiding UI are incorrectly
coupled from the user's perspective. Even successful record cleanup cannot
explicitly remove an already-painted widget.

**Recommended:** independent visibility/dismissal state, checked by every
render entry point, including late projection completions. Clear only
plan-exec's own keys. Never clear pi-tasks' `tasks` key.

### 2. The widget contradicts cancellation intent

The native formatter chooses the task's stale `running` state without first
honoring the run's `cancel_pending` state
([formatter](../../../src/index.ts), 3914–3948).
It also prioritizes a downstream dependency over the actual recovery problem.

A read-only invocation of the exported formatter reproduced:

```text
Durable status: cancel_pending userStopped: true
Task 1: running · attempts 1 · elapsed 17h · deadline none (unbounded)
Next automatic action: after task 1 is accepted
Last verified progress: unavailable
```

**Recommended:** cancellation/pause intent and verified blockers take precedence.
Show “Cancelling — worker exit not confirmed”, not “running” or a fictional
next-task action. Put owner IDs, heartbeats, paths, and raw projection errors in
the inspector.

### 3. A cancellation acknowledgement can suppress future stop delivery

[Controller](../../../src/controller.ts), 3244–3320, sets
`stopAcknowledged=true` for any successful Bridge cancellation response and
skips subsequent requests once that flag exists.

Bridge 0.5.4 `src/plan-exec-rpc.ts:1674–1695,1721–1743` can return success with
`state:unknown` after recording intent, even without a bound child or after a
stop-delivery failure. Its later binding paths do not necessarily deliver that
pending stop.

This is a source-traced liveness defect, not proof that a worker is running in
the reported case. Ownership guards still prevent a replacement writer.

**Recommended:** distinguish intent recorded, stop delivered, and exit verified.
Retry idempotent delivery against the same operation when identity becomes
available. Include old persisted acknowledgement rows in recovery tests.
Never treat a successful RPC response as proof of process retirement.

### 4. Recovery logging recreates a deleted execution path

[Progress logging](../../../src/progress.ts), 33–42, recursively creates the
progress file's parent. Recovery failure logging
([controller](../../../src/controller.ts), 5485–5496) invokes it. This explains
the reappearing progress-only directory.

**Recommended:** keep recovery diagnostics in the durable run directory.
Do not recreate a missing execution checkout to log a recovery failure.
Cancellation observation must not depend on the plan or projection files.

### 5. Cleanup is not a display command

[Cleanup](../../../src/index.ts), 1853–1907, removes eligible terminal registry
records. It correctly refuses this unresolved nonterminal run.
Its `--apply` requirement protects deletion, but is irrelevant to hiding UI.

**Recommended:** make hide/clear act immediately with no `--apply`.
Keep deletion explicitly separate. A named “forget record” action must still
refuse unresolved ownership. Bulk deletion can offer a preview without making
routine display controls a two-step operation.

## Latest Pi and pi-subagents

Registry and GitHub release checks on 2026-10-06:

| Package | Latest release | Installed in Pi's package locations | Repository baseline |
| --- | --- | --- | --- |
| Pi coding agent | **1.0.4** | 1.0.4 | 1.0.2 |
| pi-subagents | **0.76.1** | 0.76.1 | 0.76.0 |
| Bridge | **0.5.4** | 0.5.4 | 0.5.4 |
| pi-tasks | **0.9.0** | 0.9.0 | 0.9.0 |

[Pi 1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4) and
[pi-subagents 0.76.1](https://github.com/nicobailon/pi-subagents/releases/tag/v0.76.1)
fit the current dependency ranges. The lockfile and local test dependencies lag
the installed host. Installed files do not prove what a long-lived process loaded.

Relevant changes and remaining gaps:

- **0.76.1 fixes idle-parent wakes:** completion/supervisor wakes now pass through
  `before_agent_start`. It also repairs retained completion ownership across
  reload and some paused-run stop/result handling.
- **The paused-stop fix is incomplete for Bridge's route:** model-facing stop
  handles paused whole runs, but native event-bus RPC `stopAsyncRun` still rejects
  non-running states (`pi-subagents/src/extension/rpc.js:546–547`). A Bridge
  co-release alone cannot guarantee cancellation through that upstream gap.
- **Upgrade guidance needs correction:** subagents detects mixed loaded/installed
  package versions and requires a Pi process restart after an in-place upgrade.
  Plan-exec's blanket “then /reload” guidance is insufficient.
- **No breaking session-event migration was found:** plan-exec already uses
  `session_start`, `session_shutdown`, and fresh `withSession` context.
  `agent_end` is not final settlement. `agent_settled` is notification-only
  after automatic continuation, and still not proof that a child process exited.
- **Native recovery limits remain:** 0.76.1 has no durable caller-operation lookup
  or cancel-before-dispatch fence. Workflow reuse is not an exactly-once launch
  guarantee. Keep Bridge's journal and the controller's single-writer checks.
- **Unbounded remains coordinator-only:** ordinary child runs default to
  30 minutes. Removing a workflow deadline does not remove its child's deadline.
  Do not show “unbounded end-to-end verified” from a Bridge policy echo alone.
- **Advisory publication can affect background tracking:** native external-run
  cache admission caps at 100 rows. In
  [runtime integration](../../../src/runtime-integration.ts), 85–176,
  display registration precedes active-work bookkeeping. A cache error can
  therefore prevent a run entering the background provider snapshot.
  Decouple those operations and bound terminal display retention.

Pi 1.0.3 also renamed the Azure provider, and 1.0.4 changed MCP tool-allowlist
behavior. These are conditional compatibility risks, not reproduced causes of
this incident. Check frozen model identities and actual child tool permissions
when testing the updated stack.

## Bridge and pi-tasks

Registry checks found Bridge **0.5.4** and pi-tasks **0.9.0** are both the latest
published versions and match the inspected installations.

- **Bridge loses useful advisory observations.** Its status normalizer forwards
  lifecycle/proof data but drops native `asyncSnapshot`. Plan-exec expects
  activity/usage fields that are not actually supplied by that normalizer.
  Forward a small validated, versioned observation DTO if richer UI is wanted.
  Missing data remains unknown. Display telemetry cannot become exit proof,
  exact cost accounting, or verified lifetime-expiry evidence.
- **Bridge has a disposal leak.** Its terminal-proof subscription
  (`src/plan-exec-rpc.ts:938–963`) is not released by registration disposal
  (2049–2060). Its reconciliation timer also starts during factory registration.
  Align session resource ownership with Pi startup/shutdown.
- **pi-tasks is a cache, not execution authority.** Plan-exec writes its session
  file through an internal TaskStore import. pi-tasks has no supported
  projection-refresh event. A successful background file write does not
  guarantee widget registration or repaint.
- **Projection metadata is not access control.** TaskUpdate can change projected
  rows, and auto-clear can remove completed rows. Controller state must remain
  independent and authoritative.
- **No-session projection is mismatched.** pi-tasks uses memory in no-session
  mode, while plan-exec can still write a session projection file and call it
  ready. Pass persistence eligibility rather than promise a visible cache.

Sources: [projection adapter](../../../src/task-projection.ts),
[Bridge consumer](../../../src/bridge.ts), Bridge 0.5.4
`src/plan-exec-rpc.ts`, and pi-tasks 0.9.0
`src/index.ts`, `src/task-store.ts`, `src/ui/task-widget.ts`.

## Release boundary recommendation

The visibility fix, truthful status, cancellation retry policy, and missing-path
logging fix can ship in **plan-exec alone** against Bridge 0.5.4.

A **Bridge co-release** is useful for explicit cancellation-delivery receipts,
pending-stop reconciliation, and versioned advisory activity. Publish Bridge
first and raise plan-exec's minimum only for guarantees it actually consumes.
No new scheduler, journal, or v3 protocol is justified by these findings.

No pi-tasks release is needed for plan-exec-owned UI. Reliable refresh inside
pi-tasks itself needs a supported upstream API, not a fabricated event or direct
control of another extension's widget.

## Verification and limits

- Reproduced the stale “running” widget from the real saved `cancel_pending`
  record using a pure formatter call. The first ESM named import failed under
  the local Jiti loader. Explicit `createJiti().import()` succeeded.
- Inspected the exact Bridge journal row with a read-only SQLite connection.
- Inspected retained run/progress records and Git worktree registration.
- No live cancellation/recovery control was attempted.
- No production code was changed, and no production test suite was run.
- HTML verification is documented in [README.md](README.md).
- The original launch error and loaded package versions of the incident session
  remain unknown. An upgrade cannot reconstruct missing legacy correlation.
