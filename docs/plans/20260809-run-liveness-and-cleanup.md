# Run liveness, resume, and cleanup

## Overview

Make a persisted `running` claim falsifiable, bound in-flight operations, and retire
terminal runs.

Diagnosed 2026-08-09 against run `31f750ca` in `agentbundler`. Resume worked correctly —
a real worker ran for ~6 minutes mid-model-call and completed Task 5 on its own — but
`/exec status` printed `healthy active operation / wait` the entire time, text that is
byte-identical for a healthy worker and a dead one. Separately, cleanup does not exist:
`RunRegistry` has no `remove`, `/exec` has no `cleanup`, and eight runs have accumulated
in `~/.pi/plan-exec/runs/` since Jul 14, five carrying leases whose pids died weeks ago.

Full diagnosis, evidence, and design rationale:
`docs/plans/2026-08-09-run-liveness-and-cleanup.md`. Read it before starting — it records
which signals were verified present and which were verified absent, and several obvious
implementations are ruled out there by evidence.

## Context (from discovery)

Files involved:

- `src/registry.ts` — run store. `claim` at :156, `isProcessRunning` at :319 (used for
  lock files, never for leases), `LEASE_STALE_MS` at :27. No `remove`.
- `src/index.ts` — `/exec` command surface. Subcommand dispatch at :603,
  `recoveryGuidance` at :396, `isStaleOwner` at :492, `formatRunList`, setup text at :1243.
- `src/controller.ts` — orchestration. `launchBridge` :609, `recoverActiveOperation` :670,
  `observeBridge`/`recordObservation` :970, `recordObservationFailure` :983,
  `archive` :1361, `statusText` use at :1842.
- `src/types.ts` — `EXEC_ACTION` :3, `RUN_STATUS` :44, `ActiveOperation` :190,
  `lease` :236.
- `test/registry.test.ts`, `test/index.test.ts`, `test/controller.test.ts` — existing
  suites to extend.

Verified facts that constrain the implementation:

- `bridge.status()` already returns a `text` field (`normalizeObservation`,
  `@alexeiled/pi-subagents-bridge/src/plan-exec-rpc.ts:319`). plan-exec parses only
  `state` and discards `text`.
- That text format
  (`pi-subagents/src/runs/background/run-status.ts:383-440`) includes `Activity:`,
  `Progress:`, `Updated:`, `Turn budget:`, and per-step lines. Parse defensively; treat
  every field as optional.
- **`Activity:` is actively wrong for `mode: "workflow"` runs, which is what the bridge
  spawns — it is not merely absent.** The workflow branch never writes `lastActivityAt`,
  `activityState`, or `outputFile`
  (`pi-subagents/src/runs/foreground/subagent-executor.ts:4219`), so the read-side
  fallback chain in `async-status.ts:204` runs off the end into `status.startedAt`. The
  rendered line therefore reads `active 9m ago`, then `active 30m ago`, anchored to launch
  and growing without bound while the worker is healthy. Per-step activity fields are
  undefined, and `activityState` never reaches `needs_attention`.
  **Do not surface `Activity:` for a workflow-mode run — it would reintroduce the exact
  false signal this plan exists to remove.** Detect workflow mode from the `Mode:` line
  and suppress it. Full analysis and upstream report:
  `pi-subagents-workflow-activity-bug.md` (see Post-Completion).
- `status.json`'s `pid` is the Pi session pid, identical to `lease.pid` — **not** the
  worker's. Do not use it as a worker-liveness signal.
- `parseRun` throws on `schemaVersion !== 1` and eight run directories exist on disk.
  Every new field must be optional. Do not bump `schemaVersion`.

Patterns to follow:

- Constants live at module top in SCREAMING_SNAKE (`LEASE_STALE_MS`, `LOCK_STALE_MS`).
- Registry writes go through `updateIfCurrent` compare-and-swap plus `acquireLock`.
- `/exec` subcommands are values in `EXEC_ACTION` and are dispatched in the `execCommand`
  chain; each also needs an `EXEC_COMMANDS` autocomplete entry and a help line.
- Tests are `node:test` + `node:assert/strict`, table-driven where a matrix applies.

## Development Approach

- **testing approach**: Regular — implement, then cover with tests in the same task.
- complete each task fully before moving to the next
- make small, focused changes; follow existing style rather than personal preference
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task** — no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- maintain backward compatibility with existing on-disk run records — eight real runs
  exist and must keep loading after every task

## Testing Strategy

- **unit tests**: required for every task. `node --import jiti/register --test test/*.test.ts`
- **full gate**: `npm run test:all` (lint + tsc --noEmit + tests + pack dry-run)
- no e2e suite in this project
- every task that adds a predicate gets a table-driven test over its input matrix
- fixtures must include a run record with no `hostname` on the lease and no new optional
  fields, proving old records still parse

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

Four design rules drive the work:

1. **A persisted `running` claim must be independently falsifiable.** Never trust stored
   status alone. Where no live evidence exists, say so — absence of signal must not
   render as health.
2. **Every in-flight operation carries a deadline.** Absence of a bound is a leak. On
   breach, classify; never silently kill.
3. **Terminal state is retired, not accumulated.**
4. **Guidance must discriminate.** `"wait"` is only useful if some other input yields
   something else.

A fifth rule was added after Tasks 1-9 shipped, because those tasks made the problem they
solved worse in another dimension:

1. **The user states intent; the tool derives state.** Every place a reader must branch on
   something the tool has already read is a place to fold. Fold without removing
   capability: keep the behavior, move the choice to where the tool can make it or
   explain it.

The work is therefore two arcs.

**Tasks 1-9 — make the state honest.** Cheap independent wins first (version string,
lease liveness, cleanup, retirement, listing), then the observability that fixes the
reported symptom, then reconciliation and the skill.

**Tasks 10-14 — make the surface small.** Those nine tasks left 12 subcommands and 8 flags
behind, three of them newly added here. Collapse to 5 verbs and 2 flags. Findings and the
full inventory: `docs/plans/2026-08-09-exec-surface-simplification.md`.

## Technical Details

**Lease liveness.** A lease is live when it belongs to the calling session, or its
heartbeat is fresh AND (same host ⇒ its pid is running). Absent `hostname` means unknown
host: skip the pid check, fall back to the heartbeat threshold alone. All eight existing
leases lack `hostname`, so this branch is the one that runs first after upgrade.

**Cleanup policy.** Removable = terminal status, past retention, no live lease. Default
statuses: `completed`, `completed_with_findings`, `cancelled`. `failed` is **excluded by
default** — `recoveryGuidance` documents `/exec resume <failed-id>` as the recovery path
and the registry entry is what makes it possible; five of the eight runs on disk are
`failed`. Removing a registry entry never touches the worktree, branch, or progress file.

**Operation deadline.** No per-turn signal is available today, so key it on elapsed time
since `launchStartedAt`. Do not hardcode one wall-clock number for all stages — derive it
from the stage's own budget (`config.workerMaxTurns` is 75, `config.reviewerMaxTurns` is 30) times a per-turn allowance. Any initial value is a placeholder pending measurement;
say so in a code comment. Classify only; never auto-fail, never auto-kill.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all changes inside this repo.
- **Post-Completion** (no checkboxes): the upstream pi-subagents change, which lives in
  a different repository.

## Implementation Steps

### Task 1: Unpin the printed setup versions

**Files:**

- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [x] change the printed setup command at `src/index.ts:1243` from
      `pi install npm:@alexeiled/pi-subagents-bridge@^0.2.2` to `>=0.2.2` so it matches
      the `peerDependencies` range and does not refuse `0.3.x`
- [x] confirm the `pi install npm:pi-subagents` line stays unpinned
- [x] check the surrounding help/setup text at `src/index.ts:1240` for any other pinned
      version string and unpin it the same way — none found; `execHelp` and the remaining
      `execSetup` lines carry no version pin
- [x] write a test asserting the setup output contains `>=0.2.2` and contains no `@^`
      version pin
- [x] run `npm run test:all` — must pass before task 2

### Task 2: Lease liveness by pid and hostname

**Files:**

- Modify: `src/registry.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `test/registry.test.ts`
- Modify: `test/index.test.ts`

- [x] add optional `hostname?: string` to the `lease` shape in `src/types.ts:236`; do not
      bump `schemaVersion`
- [x] stamp `hostname: os.hostname()` when writing a lease in `RunRegistry.claim`
      (`src/registry.ts:156`) and in `heartbeat` — ➕ deviation: `claim` is the sole
      writer of `lease.pid`/`lease.hostname` and `heartbeat` only advances
      `heartbeatAt`. Stamping this host in `heartbeat` could pair a local hostname with
      another session's pid, which would make an unrelated local process read as the
      live owner. Every controller entry claims first, so the lease is always stamped
- [x] add an exported `isLeaseLive(lease, sessionId)` predicate in `src/registry.ts`:
      own session ⇒ live; heartbeat older than `LEASE_STALE_MS` ⇒ dead; hostname absent
      or different ⇒ fall back to heartbeat freshness alone; same host ⇒ require
      `isProcessRunning(lease.pid)` (already defined at `src/registry.ts:319`)
- [x] use the predicate in `claim` so a foreign lease with a dead local pid no longer
      blocks
- [x] use the same predicate for `isStaleOwner` in `src/index.ts:492` so status guidance
      and claiming cannot disagree — called without a session ID, since status describes
      the lease from the outside and must not assume ownership
- [x] write a table-driven test over
      `(same session, heartbeat age, hostname present/matching, pid alive)` asserting the
      full matrix, including that a live foreign pid still blocks
- [x] write a test that a lease with no `hostname` (the on-disk shape of all existing
      runs) is judged by heartbeat alone and never by pid — loaded from a hand-written
      `run.json` fixture, which also proves old records still parse
- [x] run `npm run test:all` — must pass before task 3

### Task 3: Registry removal and the `/exec cleanup` subcommand

**Files:**

- Modify: `src/registry.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `test/registry.test.ts`
- Modify: `test/index.test.ts`

- [x] add `RunRegistry.remove(runId)` deleting the run directory; it must refuse when the
      run is non-terminal or its lease is live per `isLeaseLive` — the refusal itself is
      an exported `removalRefusal(run)` so the `/exec cleanup` preview cannot promise a
      removal the registry would reject
- [x] add `CLEANUP: "cleanup"` to `EXEC_ACTION` in `src/types.ts:3` and an entry in
      `EXEC_COMMANDS` for autocomplete
- [x] implement `/exec cleanup` in the `src/index.ts:603` dispatch supporting
      `/exec cleanup` (preview), `--apply`, `<run-id>`, and `--include-failed`
- [x] default removable set: `completed`, `completed_with_findings`, `cancelled`, older
      than a 7-day retention window by `updatedAt`; exclude `failed` unless
      `--include-failed` is passed
- [x] make preview the default — without `--apply` nothing is deleted — and state in the
      preview output that removal touches only the registry entry, never the worktree,
      branch, or progress file
- [x] add a `/exec cleanup` line to the help text alongside the other subcommands
- [x] write tests: preview mutates nothing; `--apply` removes only entries past
      retention; non-terminal and live-lease runs are refused; `failed` excluded by
      default and included with the flag; a single explicit run-id removes just that run
- [x] run `npm run test:all` — must pass before task 4
- ➕ decision: an explicit `<run-id>` bypasses the retention window and the `failed`
  exclusion — the user named that run — but still needs `--apply`, and `remove`
  still enforces terminal status and a dead lease
- ➕ decision: `execCleanup(registry, args)` takes its registry as a required argument,
  so no test can reach the real `~/.pi/plan-exec/runs/`

### Task 4: Retire runs on archive

**Files:**

- Modify: `src/types.ts`
- Modify: `src/controller.ts`
- Modify: `test/controller.test.ts`

- [x] add optional `retiredAt?: number` to `PlanExecRun` in `src/types.ts`; keep it
      optional and do not bump `schemaVersion`
- [x] stamp `retiredAt` on successful completion of the `archive` stage
      (`src/controller.ts:1361`)
- [x] confirm `assertRun` still accepts records both with and without the field —
      confirmed, no change needed: `assertRun` validates no optional field, and
      `migrateLegacyRun`'s spread passes the key through when present
- [x] write a test asserting a successful archive stamps `retiredAt` and that a run
      record lacking it still parses and validates
- [x] run `npm run test:all` — must pass before task 5
- ➕ decision: the archive test asserts on the record reloaded through `registry.get`,
  not on the returned object — `archive` calls `registry.release` after `update`, so a
  returned-value assertion would pass even if the stamp never reached disk
- ➕ decision: the "record lacking `retiredAt` still parses" assertion extends the
  hand-written `run.json` fixture Task 2 added in `test/registry.test.ts` rather than
  duplicating the fixture in `test/controller.test.ts`; a `registry.create` round-trip
  would not exercise `parseRun` on a pre-upgrade file
- ➕ decision: `complete()` (`src/controller.ts:1422`) is left unstamped — the plan
  scopes `retiredAt` to the archive stage, and Task 5's default listing filter keys on
  terminal status plus `updatedAt`, not on `retiredAt`

### Task 5: Listing hygiene for `/exec runs`

**Files:**

- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [x] change `formatRunList` to show, by default, all non-terminal runs plus terminal
      runs from the last 24 hours
- [x] support `/exec runs --all` to show everything, and add it to the help text
- [x] when rows are hidden, print a footer naming the count and both escapes, e.g.
      `3 older terminal runs hidden. /exec runs --all to show, /exec cleanup to remove.`
- [x] keep the existing sort by `updatedAt` descending and the existing row format —
      `formatRunList` filters only; the descending sort stays in `RunRegistry.list`
- [x] write tests: a retired run is absent by default and present under `--all`; the
      footer count matches the number hidden; no footer when nothing is hidden
- [x] run `npm run test:all` — must pass before task 6
- ➕ decision: the filter keys on terminal status plus `updatedAt`, never on `retiredAt`
  — that stamp is Task 4's audit marker. A just-archived run is both retired and inside
  the window, so it stays visible for a day and then drops out; a test pins that
- ➕ decision: `isTerminalStatus` includes `failed`, so a failed run older than a day is
  hidden too. It stays resumable and both escapes still land: `--all` surfaces it, and
  `/exec cleanup` reports it as not removable plus the `--include-failed` hint
- ➕ decision: `--all` is a flag, not an `EXEC_ACTION` member, so Task 9's
  skill-vs-`EXEC_ACTION` assertion stays clean. `parseRunsArguments` stays unexported and
  rejects any other argument, where `/exec runs garbage` was previously ignored
- ➕ decision: when every run is hidden the listing prints a "no recent runs" line plus
  the footer, rather than a header with no rows under it

### Task 6: Surface the bridge observation text

**Files:**

- Modify: `src/types.ts`
- Modify: `src/controller.ts`
- Modify: `src/index.ts`
- Modify: `test/controller.test.ts`
- Modify: `test/index.test.ts`

- [x] add an optional `workerSignal` field to `ActiveOperation` in `src/types.ts:190`
      holding a compact digest of the parsed observation
- [x] parse the `text` returned by `bridge.status()` in the observe path
      (`src/controller.ts:970`), extracting `Mode`, `Activity`, `Progress`, `Turn budget`,
      `Updated`, and `Step N:` lines; every field is optional, so no parse failure may
      throw or fail the run
- [x] **suppress `Activity` when the `Mode:` line says `workflow`** — upstream anchors it
      to launch time, so it grows without bound on a healthy worker and would reintroduce
      the false signal this plan removes (see Context). Trust it only for non-workflow modes
- [x] persist the digest on `activeOperation` alongside `lastObservedAt`
- [x] `stat` `operation.asyncDir` during observation; a missing directory is decisive
      evidence the operation is gone and must be reported as such rather than as running
- [x] render the signal in `formatRunStatus`; when no trustworthy activity line is
      available, print the absence explicitly, e.g.
      `worker: bridge reports running, 9m since launch / no per-turn activity signal (workflow-mode run)`
- [x] write a table-driven test over status-text fixtures covering: no `Activity:` line;
      an `Activity:` line with `Mode: workflow` (must be suppressed, never rendered); an
      `Activity:` line with a non-workflow mode (must be rendered). Assert the render never
      implies health when no trustworthy signal exists
- [x] write a test that a missing `asyncDir` is reported as gone, not running
- [x] run `npm run test:all` — must pass before task 7

- ➕ decision: the pre-existing assertion on `recovery: healthy active operation`
  in `test/index.test.ts` encoded the bug — that string rendered for an operation with
  no signal at all. It now asserts the honest classification plus `doesNotMatch(/healthy/)`,
  and a second case with a trustworthy non-workflow activity value keeps the `healthy`
  branch covered, so the text is proven to discriminate rather than merely to be cautious

### Task 7: Long-running operation classification

**Files:**

- Modify: `src/controller.ts`
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [x] derive an operation deadline from the stage's own turn budget
      (`config.workerMaxTurns`, `config.reviewerMaxTurns`) times a per-turn allowance;
      add a code comment stating the allowance is a placeholder pending measurement
- [x] add a `long-running active operation` branch to `recoveryGuidance`
      (`src/index.ts:396`) that fires when elapsed since `launchStartedAt` exceeds the
      deadline while the bridge still reports running
- [x] word the guidance to name the uncertainty rather than assert death, and to offer
      re-check and cancel while warning against starting a second run
- [x] classify only — no auto-fail, no auto-kill, no change to the polling loop
- [x] write a table-driven test over `(elapsed, activity signal present, bridge state)`
      asserting a worker mid-model-call at nine minutes is never reported as dead; this
      is the regression test for the originally reported bug
- [x] run `npm run test:all` — must pass before task 8
- ➕ decision: the branch is gated on the absence of a trustworthy `activity` value and
  sits after Task 6's `asyncDirMissing` check. Elapsed time is weaker evidence than
  either, so it must not shadow a decisive one: a live worker with `active 12s ago` at
  three hours still classifies `healthy`, and a gone async directory still classifies
  gone. A test pins both
- ➕ decision: the per-turn allowance is 2 minutes, giving 150m for a 75-turn worker and
  60m for a 30-turn reviewer. `stats` uses `statsMaxTurns` and `fusion` falls through to
  `workerMaxTurns`, mirroring what each launch path passes
- ➕ decision: an operation with no `launchStartedAt` (a pre-upgrade record) cannot be
  bounded and is never reported as long-running. Task 8 handles those runs by evidence
  instead of by clock
- ➕ deviation: deleted the dead private `reconstructBridgeParams` in `src/controller.ts`
  — unreferenced, predates this branch, and `tsconfig` has no `noUnusedLocals` so `tsc`
  never flagged it. Every helper it called retains other callers

### Task 8: ➕ Reconcile abandoned runs after a Pi restart

Tasks 6 and 7 make a stalled run _visible_. Nothing acts on it. After a Pi restart the
registry can hold several runs that each claim `running` while no worker exists, in
different stages, some weeks old. Today the operator must diagnose each one by hand, and
`recoveryGuidance` answers `wait` for all of them.

This task adds the acting half. It does **not** auto-launch anything: a silent relaunch
can double-write a worktree, which is worse than the stall. It converts decisive evidence
into the state that the existing `/exec resume` path already knows how to recover, and it
does so for every affected run in one command.

**Abandoned** means all of these hold at once:

- `status` is `running`, `starting`, `skip_pending`, or `cancel_pending`
- the lease is not live per `isLeaseLive` from Task 2
- the operation is provably gone: `activeOperation.asyncDir` is absent from disk, or the
  bridge lookup answers `absent` for its `operationId`

Anything short of all three is **ambiguous** and must be reported, never reset.

**Files:**

- Modify: `src/registry.ts`
- Modify: `src/controller.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Modify: `test/registry.test.ts`, `test/index.test.ts`, `test/controller.test.ts`

- [x] add an exported `classifyAbandonment(run, evidence)` returning
      `live | abandoned | ambiguous`, with the three-part rule above; no I/O inside the
      predicate so it stays table-testable
- [x] add `/exec doctor` to `EXEC_ACTION`, `EXEC_COMMANDS`, and the help text: one
      read-only sweep over every run that prints, per run, what it claims, what the
      evidence shows, and the single next command
- [x] group the `doctor` output by classification so several stalled runs in different
      stages read as one list, not as one paragraph per run
- [x] add `/exec doctor --reconcile` which, for `abandoned` runs only, clears
      `activeOperation`, sets `status` to `failed` with an explicit reason naming the
      evidence, and stamps the run so the reset is auditable
- [x] make `--reconcile` reuse `updateIfCurrent` compare-and-swap, so a run that a live
      session reclaims between the scan and the write is skipped rather than overwritten
- [x] leave the recovery itself to the existing `/exec resume <id>`: after reconcile a run
      is an ordinary recoverable failure, so no second retry path is introduced
- [x] append a line to each reconciled run's progress file recording the reset and its
      evidence, so the plan's own history shows why the attempt counter did not advance
- [x] do not consume a task attempt on reconcile — the worker never ran, so
      `taskAttempts` must not change
- [x] on extension load, run the read-only sweep and, when any run is `abandoned`, print
      one line naming the count and pointing at `/exec doctor`; never write during startup
- [x] make `RunRegistry.remove` handle a corrupt `run.json` that `get` cannot parse, and
      make `doctor` list corrupt directories as removable; today `list` drops them and
      `remove` throws, so nothing can clean them up
- [x] write a table-driven test over
      `(status, lease live, asyncDir present, bridge answer)` asserting `abandoned` needs
      the full conjunction and that every partial case is `ambiguous`
- [x] write a test that `--reconcile` skips a run whose `updatedAt` changed during the
      sweep, and one that it never touches an `ambiguous` or `live` run
- [x] write a test that a reconciled run is then recoverable through the normal resume
      path, and that `taskAttempts` is unchanged
- [x] write a test that startup reconciliation performs no writes
- [x] run `npm run test:all` — must pass before task 9
- ➕ decision: `classifyAbandonment` takes lease liveness, async-directory presence, and
  the bridge answer as caller-gathered evidence, so the rule is pure and the plan's four
  table axes map one-to-one onto its inputs. `asyncDirPresent === false` is the test, never
  `!asyncDirPresent`: undefined means "not observed", which is not evidence
- ➕ decision: a run with no `activeOperation` is `ambiguous`, never `abandoned`. Nothing
  can be proven gone when nothing was tracked, and `/exec adopt` plus resume already
  recovers that shape
- ➕ decision: reconcile clears `activeOperation` and does **not** move it to
  `failedOperation`. `recoveryEvidence` feeds `isExternalManualBlocker`, whose word list
  includes `provider`, `network`, and `external`, so a preserved operation error could
  reclassify an implementation-stage run into the retry-confirmation path. The reason text
  is worded to avoid those words too, and a test pins the resulting classification
- ➕ decision: the dead lease is left in place as evidence; `isStaleOwner` is already
  skipped once the status is `failed`
- ⚠️ known limit: a run that failed once, was resumed, then got abandoned still carries
  its old `failedOperation`, whose `terminalError` feeds `recoveryEvidence`. Reconcile
  leaves it alone, so such a run can still classify into the `--retry-task` confirmation
  path despite the reason wording. Recovery is not lost, only gated behind a confirmation
  the operator should not need; clearing it would trade away the audit trail
- ➕ decision: `/exec doctor`'s bridge lookup uses its own `BridgeClient` at
  `PROVIDER_PROBE_TIMEOUT_MS`, not the controller's 30s client. Doctor is the documented
  first step after a restart, which is exactly when the bridge may not be up, and a
  diagnosis that hangs for 30 seconds is the non-discriminating experience this plan
  removes. It is also skipped entirely when the async-directory check was already decisive
  or the operation is not a bridge operation
- ➕ decision: no CAS retry loop on reconcile, unlike `claim` and `requestStatus`.
  Skipped-not-overwritten is the requirement, so one attempt against the scanned
  `updatedAt` is the whole point
- ➕ deviation: `isInFlightStatus` went into `src/lifecycle.ts` next to `isTerminalStatus`
  rather than into a file the task lists — it is a status classification, and lifecycle is
  where those live
- ➕ deviation: the bridge answer reaches `doctor` through a new read-only
  `PlanExecController.operationState`, and the startup sweep uses the filesystem-only probe
  — no RPC during `session_start`, and a provider outage can never read as evidence that a
  worker is gone
- ➕ decision: `/exec cleanup <id> --apply` also removes an unreadable record, so the
  escape `doctor` prints actually lands. It is an early-exit branch keyed on
  `listWithErrors`, leaving Task 3's sweep, preview, and rows untouched
- ➕ decision: `remove` classifies only a `SyntaxError` or an
  `Invalid plan-exec run registry entry` failure as corrupt; an I/O or permission error is
  rethrown, because a blanket catch would turn EACCES into a recursive delete

### Task 9: ➕ Bring the exec-plan skill up to the new behavior

The skill is the agent-facing contract. It is how an agent decides what to do with a
stuck run, so a skill that describes the old surface is itself a recovery failure.
Tasks 1-8 add `/exec cleanup`, `/exec runs --all`, `/exec doctor`, a
`long-running active operation` classification, startup reconciliation, and immediate
stale-lease detection. None of these appear in the skill today.

**Files:**

- Modify: `skills/exec-plan/SKILL.md`
- Modify: `skills/exec-plan/references/recovery.md`

- [x] add `/exec cleanup`, `/exec runs --all`, and `/exec doctor` to the "Choose the job"
      list in `SKILL.md`, with the retention window and the `failed` exclusion stated
- [x] make `/exec doctor` the documented first step after a Pi restart or a session
      handoff, ahead of `/exec runs`, and state that `--reconcile` resets only provably
      abandoned runs and never launches a worker
- [x] state that a lease whose pid is dead on this host is stale at once, so `/exec adopt`
      no longer needs a 30-second wait; absent `hostname` still waits out the heartbeat
- [x] add the `long-running active operation` classification to `references/recovery.md`
      with its decision branch: re-check, or cancel, and never start a second run
- [x] record that a workflow-mode run reports no trustworthy per-turn activity, so
      elapsed time is the only bound; cite `nicobailon/pi-subagents#920` so a reader knows
      the limit is upstream and temporary
- [x] remove guidance that the new surface makes obsolete, and make sure every recovery
      branch names one command; prefer deleting a branch over adding a caveat
- [x] fix the stale `@^0.2.2` pin at `skills/exec-plan/SKILL.md:172` to `>=0.2.2`
- [x] verify every `/exec` subcommand named in the skill exists in `EXEC_ACTION`, and that
      every member of `EXEC_ACTION` is either documented or deliberately internal — all
      twelve members are documented; none is internal
- [x] add a test that asserts the skill's documented subcommand list matches `EXEC_ACTION`,
      so the two cannot drift again
- [x] run `npm run test:all` — must pass before task 10
- ➕ deviation: no literal `@^0.2.2` existed in `SKILL.md`; line 172 read
  "`@alexeiled/pi-subagents-bridge` `0.2.2` or later". It now reads `>=0.2.2`, byte-identical
  to the range `execSetup` prints and to `peerDependencies`, so the checkbox's intent holds
- ➕ decision: the drift test lives in `test/index.test.ts`, not `test/pack.test.ts` — the
  claim is about `EXEC_ACTION`, which `index.test.ts` already exercises, while `pack.test.ts`
  exists to read `package.json`
- ➕ decision: the drift assertion scrapes `/exec <token>` where the token starts with a
  letter, so `--all`, `--apply`, `--reconcile`, and `--include-failed` can never match, and
  it asserts in both directions with a named failure per token. Verified against the
  pre-edit skill: it fails on `cleanup` and `doctor`
- ➕ decision: `active operation directory is gone` is documented as two branches keyed on
  the `/exec doctor` verdict — `abandoned` takes `--reconcile`, `live` takes `/exec cancel`.
  `classifyAbandonment` needs the full conjunction, so `--reconcile` will not touch a run
  whose lease is still live, and one branch naming both commands would have implied it would
- ➕ decision: the model/provider-failure and terminal-state sections keep their existing
  shape. Tasks 1-8 changed neither, and forcing a command onto `completed` would dress
  verification advice as an action. The retention and `--all` facts are stated once under
  Terminal states instead

### Task 10: ➕ Collapse the read surface into `/exec status`

Findings and rationale: `docs/plans/2026-08-09-exec-surface-simplification.md`. Read it
first. Tasks 10-14 reduce 12 subcommands and 8 flags to 5 verbs and 2 flags.

Three rules bind every task in this group:

1. **Never remove capability to reach a smaller number.** Each fold keeps the behavior
   and moves the choice to where the tool can make it or explain it.
2. **Keep every flag as a non-interactive equivalent.** Worker subagents run with no
   human and the code already throws `"Force-skip requires interactive confirmation."`
   Flags leave `/exec help` and live on in the skill; they do not leave the code.
3. **Retire names as hidden aliases, not errors.** A run in flight during an upgrade must
   not break. An alias keeps working and prints the new spelling once.

**Files:** `src/index.ts`, `src/types.ts`, `test/index.test.ts`

- [x] delete the `start` subcommand; `src/index.ts:1315` shows it is the identical code
      path to bare `/exec`, picker included
- [x] make `/exec status` with no run ID the full sweep: every run, grouped by what it
      needs, each row ending in one next command
- [x] fold `doctor` into that sweep, and `--all` into it as the zoom control it already is
- [x] surface missing packages inside `status` rather than behind a separate verb
- [x] keep `runs`, `doctor`, and `setup` as hidden aliases that still work, are absent
      from `/exec help`, and name their replacement once in the output
- [x] keep `--reconcile` reachable on the alias so a scripted caller does not break; the
      interactive path moves to `resume` in Task 11
- [x] do not fold `cleanup` into `status` — reading and deleting stay separate verbs;
      `cleanup` keeps its own dispatch branch and both flags
- [x] update Task 9's skill-vs-`EXEC_ACTION` drift test: hidden aliases exist in
      `EXEC_ACTION` but must not be required in the skill, so the assertion needs an
      explicit alias set rather than a two-way equality
- [x] write tests: `start` is gone, `status` with no ID lists and diagnoses in one pass,
      each alias still works and names its replacement, `/exec help` no longer lists them
- [x] run `npm run test:all` — must pass before task 11
- ➕ decision: the read surface moved into an exported `execRead(registry, subcommand,
rest, sources)` whose registry is a required argument, mirroring Task 3's rule that no
  test can reach the real `~/.pi/plan-exec/runs/`. `handleCommand` keeps only
  `status <run-id>`, which needs the session context to resolve a run
- ➕ decision: `formatRunList` is gone, replaced by `settledRunLines`. Folding `runs` into
  `status` left it with no production caller, and a second unused renderer would drift;
  its hidden-footer behavior and both of its tests moved across intact
- ➕ decision: the no-ID sweep groups settled runs as `waiting for you` (paused or
  recoverable failure → `/exec resume <id>`) and `finished` (→ `/exec status <id>`), so
  every row still ends at exactly one command. The `--all` footer now names
  `/exec status --all`
- ➕ decision: `EXEC_ALIAS_ACTIONS` lives in `src/types.ts` beside `EXEC_ACTION` and keys
  the `ALIAS_NOTES` record, so retiring another name forces a note with it and the drift
  test asserts against production truth instead of a hand-kept literal
- ➕ decision: `checkRuntime` split into a reporting `runtimeProblems()` plus the throwing
  wrapper. The probe is lazy and only the read commands pay for it, so `/exec resume`
  gains no extra RPC, and the two old throw messages merged into one that names
  `/exec status` rather than the retired `/exec setup`
- ➕ decision: `--all` and a run ID are rejected together — `--all` is a listing zoom, and
  silently ignoring it would hide the contradiction. `/exec status --reconcile` gets its
  own refusal naming `/exec doctor --reconcile`: the retired name points at `status`, so
  the retired flag has to point back until Task 11 moves it to `resume`
- ➕ deviation: the no-ID sweep covers every run with no `matchesContext` filter, as
  `doctor` already did, so bare `/exec status` no longer prints one run's detail. Every
  message that already holds a run ID now prints `/exec status <id>` instead of bare
  `/exec status`, so the detail view stays one keystroke away
- ➕ deviation: deleted `prioritizeRunCandidates`'s `preferLive` parameter and the test
  that pinned it. Only status-without-an-ID passed `true`, and that path no longer
  resolves a run from context, so the branch was dead
- ➕ deviation: edited `skills/exec-plan/SKILL.md`, which is not in this task's Files list.
  With `start` gone from `EXEC_ACTION`, its two `/exec start` mentions failed the drift
  test's documented-subcommand direction. The start line now reads
  `/exec <path/to/plan.md>`, angle-bracketed so the scraper cannot read `path` as a
  subcommand

### Task 11: ➕ Collapse the recovery surface into `/exec resume`

Every stuck state must answer one verb. Today the user picks between `resume`, `adopt`,
and `doctor --reconcile` by inspecting a lease and an operation the tool has already read.

**Files:** `src/index.ts`, `src/types.ts`, `test/index.test.ts`

- [x] make `resume` claim a run whose lease is foreign and not live, using Task 2's
      `isLeaseLive`; `adopt` becomes a hidden alias
- [x] make `resume` reconcile a provably abandoned run first, then continue, reusing Task
      8's `classifyAbandonment`; never touch an `ambiguous` run and never launch on
      partial evidence
- [x] ask for task retry and branch adoption at the moment they matter, through the
      confirms that `--retry-task` and `--adopt-current-branch` already require
- [x] keep both flags working for non-interactive callers and remove them from
      `/exec help`; keep `--model` documented as the one advanced flag
- [x] preserve every existing safety gate: no second worker, no consumed task attempt on
      reconcile, compare-and-swap on every write
- [x] write tests: resume claims a dead foreign lease, resume reconciles then continues,
      resume refuses an ambiguous run, the flags still drive the non-interactive path
- [x] run `npm run test:all` — must pass before task 12
- ➕ decision: the gate is an exported `reconcileForResume(registry, run, sessionId,
probe)`, registry injected like Task 3's rule, and it runs only for a status that is
  in flight and not already recoverable — `starting`, `running`, `skip_pending`.
  `failed` and `cancel_pending` pass through untouched: resetting a cancel-pending run
  would drop the cancellation it is carrying, and resume already recovers both
- ➕ decision: `ambiguous` refuses only when an operation is tracked. Task 8 recorded
  that a run with no `activeOperation` is `ambiguous` and that adopt-plus-resume is how
  that shape recovers; nothing can double-write when nothing was tracked, so refusing it
  would have removed the very capability this fold absorbs. What is refused is the one
  shape that could add a second writer
- ➕ decision: `recoveryGuidance`'s `stale owner` branch is now gated on
  `!run.activeOperation`. It fired before the operation branches, so a dead owner holding
  an unresolved operation was told to take the run over — a resume the gate then refuses.
  A test walks every guidance shape and asserts the gate accepts each run whose action
  names `/exec resume <id>`, so the two can never disagree again
- ➕ decision: `/exec status` stops naming `/exec doctor --reconcile`. An abandoned row's
  next command is `recoveryCommand`, the same function the reconcile report uses, so an
  abandoned `cancel_pending` run still reads `/exec cancel <id>`. The retired flag keeps
  working on the retired verb
- ➕ decision: branch adoption is derived, not asked twice — an interactive resume of a
  run whose error is an execution-branch mismatch, with no tracked operation, enters the
  existing confirm on its own. `--adopt-current-branch` still forces it for a caller with
  no human, and the guidance text now names the prompt instead of the flag
- ➕ decision: `reconcileReason` takes the actor with `/exec doctor` as its default, so
  Task 8's progress-file wording and its tests are untouched while a resume-driven reset
  records `Reset by /exec resume`
- ➕ deviation: the run-action dispatch moved out of `handleCommand` into `runAction`,
  with an exported `runActionFor(subcommand)` naming the action and the alias note. The
  alias note then wraps one return instead of six, and the mapping is testable without a
  Pi command context
- ➕ deviation: `EXEC_COMMANDS` keeps its `adopt` entry, as Task 10 kept `runs`, `doctor`,
  and `setup`. Task 14 owns the autocomplete list. `skills/exec-plan` still names
  `/exec adopt`, which the alias keeps working and the drift test permits; Tasks 13 and 14
  own the skill's wording

### Task 12: ➕ Add `/exec stop` over `pause` and `cancel`

Both mean "stop this". They differ in reversibility, which is exactly the thing to explain
at the moment of choice rather than encode in two verb names.

**Files:** `src/index.ts`, `src/types.ts`, `test/index.test.ts`

- [x] add `stop`, which asks: pause (resumable) or cancel (final, worktree preserved)
- [x] keep `pause` and `cancel` as hidden aliases and as the non-interactive path
- [x] do not fold `skip`; its full run ID, mandatory reason, and confirm are a waiver
      guard, not friction to remove
- [x] instead, when a stage is blocked, make `status` print the exact `skip` command with
      the run ID already filled in, so it stays hard to run by accident
- [x] write tests: `stop` reaches both outcomes, the aliases still work, a blocked stage
      makes `status` emit a ready-to-run `skip` line
- [x] run `npm run test:all` — must pass before task 13
- ➕ decision: the choice is an exported `chooseStopOutcome(run, ctx, sessionId)` taking a
  structural `ctx`, the seam `reviewedPlanHashForResume` already uses. `runAction` is not
  exported, so without it "stop reaches both outcomes" could only have been asserted on
  the name it dispatches, not on the two states it produces
- ➕ decision: `stop` refuses without a TTY twice — once in `runAction` before a run is
  resolved, once inside `chooseStopOutcome` — from one `STOP_REQUIRES_UI` constant naming
  both `/exec pause` and `/exec cancel`. The early guard exists because bare `/exec stop`
  with several candidates would otherwise fail in `resolveRunForAction` with a message
  naming neither
- ➕ decision: only the outcomes a run can still take are offered, and a single remaining
  outcome is still asked rather than assumed. A paused run can only be cancelled, and
  cancelling it silently because the reader typed the softer word is the damage the
  question exists to prevent
- ➕ decision: `pause` and `cancel` enter `RUN_ACTION_ALIASES` as identity mappings. Task
  11 built the record to point a retired verb at its replacement's code path; here only
  the name was retired, so the alias note is the whole change
- ➕ decision: `recoveryGuidance` keeps naming `/exec cancel <id>`, and `recoveryCommand`
  keeps returning it for a `cancel_pending` run. Both are non-interactive answers Task 11
  deliberately set, and Task 13 owns the classification wording
- ➕ deviation: `isActionAllowed`'s skip branch moved into an exported
  `isStageWaiverAvailable(run)`, so the status row offers the waiver on exactly the terms
  `skip` accepts it rather than on a copy of them
- ➕ deviation: the waiver is a second, indented line under the blocked run's row, not its
  `Next:`. Task 10's rule that every row ends at one command still holds; the waiver is
  the alternative that only applies if that command cannot succeed
- ➕ deviation: `/exec pause` and `/exec cancel` left `/exec help` and `/exec stop` took
  their place, as Task 10 did for `runs`, `doctor`, and `setup`. Task 14 owns the final
  help shape
- ➕ deviation: edited `skills/exec-plan/SKILL.md`, which is not in this task's Files list.
  `stop` is not an alias, so the Task 9 drift test requires the skill to document it. The
  new bullet also tells an agent to keep using `/exec pause` and `/exec cancel`, since it
  has no human to answer the question

### Task 13: ➕ Rewrite the classification vocabulary around next actions

The largest real win for a reader who struggles, and the most work. The 20 classifications
in `recoveryGuidance` name controller internals — `preserved unknown operation`,
`force-skip reconciliation pending`, `execution-branch mismatch`. A reader has to model
the controller before acting.

**Files:** `src/index.ts`, `test/index.test.ts`

- [x] rewrite each classification as the user's situation, not the controller's state
- [x] collapse classifications that share a next command; the count matters less than the
      number of distinct actions a reader must choose between
- [x] keep the distinctions Task 6 and Task 7 earned: gone, liveness unverified,
      long-running, and healthy are four different situations and must stay four
- [x] make sure every classification still ends at exactly one command
- [x] update `skills/exec-plan/references/recovery.md` so its branches match the new
      wording exactly; Task 9 aligned them to the old wording
- [x] write a test asserting no classification string contains the internal vocabulary
      (`preserved`, `reconciliation`, `operation identity`), so the wording cannot regress
- [x] run `npm run test:all` — must pass before task 14
- ➕ decision: 20 classifications became 16, but the number that matters is the distinct
  next actions a reader chooses between, which is three: `/exec resume <id>` to continue,
  `/exec status <id>` to wait and look again, `/exec cleanup` to retire a finished record.
  `/exec stop <id>` appears only as the escape on the two branches that offer one
- ➕ decision: only two pairs collapsed, both by sharing one string across two `if`s rather
  than by merging the branches — the unnamed operation and the unreachable provider both
  read `cannot check on the worker right now`, and a failed run with or without a tracked
  worker both reads `stopped, and you can continue it`. `skip_pending` and `cancel_pending`
  were left apart despite sharing `/exec status`: they give opposite advice about resume,
  since resume retries a stuck cancellation and must not touch a pending waiver
- ➕ deviation: deleted the `retry-exhausted or no-progress task` branch as dead code.
  `isTaskRetryConfirmationRequired` conjoins `isExternalManualBlocker`, which is the branch
  immediately above it, so it could never fire. The predicate itself stays — `src/index.ts`
  and `src/controller.ts` still gate the resume confirmation on it
- ➕ decision: `terminal` had no command and the external-blocker branch named
  `--retry-task`. Both are now one primary verb: a finished run points at `/exec cleanup`,
  and the blocker points at interactive `/exec resume <id>`, which asks — the same move
  Task 11 made for `--adopt-current-branch`. The flag still reaches the same path for a
  caller with no human, and `taskRetryRequiredMessage` still names it when there is no UI
- ➕ decision: guidance now names `/exec stop <id>` where it named `/exec cancel <id>`, and
  so do `recoveryCommand` and the ambiguous-resume refusal, which Task 12 deferred here. A
  row that ends in a verb `/exec help` will not list is a dead end for the reader the
  rewrite is for
- ➕ deviation: edited `skills/exec-plan/SKILL.md`, which is not in this task's Files list.
  It quoted `healthy active operation`, `active operation, worker liveness unverified`, and
  `long-running active operation` verbatim, so leaving it would send an agent looking for
  text that no longer exists. Both skill files also state that `/exec status` writes
  `/exec stop` for a human and that an agent uses `/exec pause` or `/exec cancel` instead
- ➕ decision: a second test walks every guidance shape and asserts each action names a
  primary verb and no retired alias. The vocabulary test scrapes the `classification:`
  literals out of `src/index.ts` rather than reading a shape table, so a branch added later
  cannot reintroduce the words, and it floors the scrape count so a refactor that empties
  the match set fails instead of passing on nothing
- ➕ deviation: `formatRunStatus`'s force-skip detail line printed
  `force-skip reconciliation: failed (n/3)` two lines above the classification it sits
  next to — the last place in the reader's view carrying the vocabulary this task removes.
  It now reads `waived stage: could not stop the worker (n/3)`
- ⚠️ for Task 16: `README.md:71,76,77` and `docs/guide.md:187,190,228` still quote the old
  classification wording. They are in that task's Files list, not this one

### Task 14: ➕ Rewrite `/exec help` around 5 verbs

**Files:** `src/index.ts`, `skills/exec-plan/SKILL.md`, `test/index.test.ts`

- [x] reduce `/exec help` to `/exec [plan]`, `status`, `resume`, `stop`, `cleanup`, `help`
- [x] leave `--apply` and `--model` as the only flags in help; move the rest to the skill
- [x] document every hidden alias and every non-interactive flag once in
      `skills/exec-plan/SKILL.md`, marked as the scripted path for agents
- [x] update `EXEC_COMMANDS` autocomplete to the primary verbs only
- [x] write a test that `/exec help` names exactly the primary verbs and no alias
- [x] run `npm run test:all` — must pass before task 15
- ➕ decision: `skip` stays in help. The checkbox lists five verbs, but `skip` is not an
  alias, so Task 9's drift test requires the skill to document it and a reader who is
  offered `/exec skip <id>` by a blocked status row must find it in help. The primary set
  is derived — `EXEC_ACTION` minus `EXEC_ALIAS_ACTIONS` — so it is six lines plus
  `/exec [plan-path]`, and its help line calls it a waiver of last resort
- ➕ decision: `--reason` stays in help as part of the `skip` line. It is a required
  argument of that verb, not an optional flag; dropping it would print a command that
  cannot run. The test therefore asserts positively on `--apply`, `--model`, and
  `--reason`, and negatively on exactly the five retired flags
- ➕ decision: the verb test scrapes `^/exec <token>` line-anchored over the command list
  and asserts set equality with the derived primary set, so a verb added later must appear
  in help and an alias never can. The whole-text `doesNotMatch` loop stays for the alias
  direction; a whole-text scrape would read `(bare /exec opens the plan picker)` as a
  subcommand
- ➕ decision: a second test asserts that every retired flag and every `EXEC_ALIAS_ACTIONS`
  member absent from help is present in `SKILL.md`. Help was the only place naming them, so
  without it "moved to the skill" and "deleted" look identical to the suite
- ➕ deviation: `EXEC_COMMANDS` is autocomplete-only — dispatch keys on `EXEC_ACTION`,
  `RUN_ACTIONS`, and `execRead` — so pruning it cannot break a retired name. Verified
  before pruning, since a completion list that gated dispatch would have turned
  `/exec runs` into a plan path named `runs`
- ➕ deviation: rewrote `SKILL.md`'s "Choose the job" around the primary verbs and added a
  "Scripted path for agents" section, beyond the checkbox's "document every alias once".
  The list still named `/exec doctor` as the first step after a Pi restart, which Task 10
  folded into `/exec status` — leaving it would have sent an agent at the retired name as
  the documented path. Prose elsewhere that named a retired verb or a flag now names the
  primary verb or points at the new section, so each appears exactly once
- ➕ decision: `references/recovery.md` is untouched. Task 13 aligned its branches, the
  drift test permits an alias there, and its `/exec doctor --reconcile` branches are
  scripted answers the new section documents rather than contradicts

### Task 15: Verify acceptance criteria

- [ ] verify every requirement in Overview is implemented
- [ ] load each of the eight real run records under `~/.pi/plan-exec/runs/` through
      `RunRegistry.get` and confirm all parse without error after the schema additions
- [ ] verify `/exec cleanup` preview against the real registry reports the two
      `completed_with_findings` runs and excludes the five `failed` ones
- [ ] verify no `schemaVersion` bump was introduced anywhere
- [ ] verify every recovery branch in `skills/exec-plan/references/recovery.md` names a
      command that exists, and that no branch ends without an action
- [ ] verify the 5-verb surface: every retired name still works as a hidden alias, and
      no capability was removed to reach the smaller count
- [ ] run the full gate: `npm run test:all`

### Task 16: [Final] Update documentation

**Files:**

- Modify: `docs/guide.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] document `/exec cleanup` and `/exec runs --all` in `docs/guide.md` alongside the
      other subcommands, including the default retention window and the `failed`
      exclusion
- [ ] document the lease liveness rule and the retirement/cleanup lifecycle in
      `docs/architecture.md`
- [ ] update `README.md` if it lists subcommands or setup install commands
- [ ] update `CLAUDE.md` if new patterns were discovered
- [ ] run `npm run test:all`

## Post-Completion

Items requiring manual intervention or external systems — no checkboxes, informational
only.

**Upstream change (different repository):**

- pi-subagents 0.44.0 reports a false `Activity:` age for `mode: "workflow"` runs and
  never escalates them to `needs_attention`. The workflow branch
  (`subagent-executor.ts:4219`) writes no `outputFile`, `lastActivityAt`, or
  `activityState` and has no watchdog, so the read-side fallback in
  `async-status.ts:204` lands on `status.startedAt` and the age grows without bound on a
  healthy worker. `subagent-wait.ts:238`, `wait-subscriptions.ts:65`, and
  `extension/index.ts:629` all key off `activityState` and are therefore inert in this
  mode.
- Full write-up with reproduction, mechanism, and suggested fix:
  `pi-subagents-workflow-activity-bug.md` (session scratchpad). File against pi-subagents.
- Once upstream lands, drop Task 6's workflow suppression so real activity flows through,
  then tighten Task 7's deadline and reword its guidance from "long-running" to a genuine
  stall claim.

**Manual verification:**

- run a real plan through `/exec` end to end and confirm `/exec status` distinguishes a
  worker mid-model-call from a stalled one
- confirm `/exec cleanup --apply` on the real registry leaves the five `failed` runs
  resumable
