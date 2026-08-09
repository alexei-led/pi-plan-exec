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

Ordering: the cheap independent wins first (version string, lease liveness, cleanup,
retirement, listing), then the observability work that fixes the reported symptom.

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

- [ ] change `formatRunList` to show, by default, all non-terminal runs plus terminal
      runs from the last 24 hours
- [ ] support `/exec runs --all` to show everything, and add it to the help text
- [ ] when rows are hidden, print a footer naming the count and both escapes, e.g.
      `3 older terminal runs hidden. /exec runs --all to show, /exec cleanup to remove.`
- [ ] keep the existing sort by `updatedAt` descending and the existing row format
- [ ] write tests: a retired run is absent by default and present under `--all`; the
      footer count matches the number hidden; no footer when nothing is hidden
- [ ] run `npm run test:all` — must pass before task 6

### Task 6: Surface the bridge observation text

**Files:**

- Modify: `src/types.ts`
- Modify: `src/controller.ts`
- Modify: `src/index.ts`
- Modify: `test/controller.test.ts`
- Modify: `test/index.test.ts`

- [ ] add an optional `workerSignal` field to `ActiveOperation` in `src/types.ts:190`
      holding a compact digest of the parsed observation
- [ ] parse the `text` returned by `bridge.status()` in the observe path
      (`src/controller.ts:970`), extracting `Mode`, `Activity`, `Progress`, `Turn budget`,
      `Updated`, and `Step N:` lines; every field is optional, so no parse failure may
      throw or fail the run
- [ ] **suppress `Activity` when the `Mode:` line says `workflow`** — upstream anchors it
      to launch time, so it grows without bound on a healthy worker and would reintroduce
      the false signal this plan removes (see Context). Trust it only for non-workflow modes
- [ ] persist the digest on `activeOperation` alongside `lastObservedAt`
- [ ] `stat` `operation.asyncDir` during observation; a missing directory is decisive
      evidence the operation is gone and must be reported as such rather than as running
- [ ] render the signal in `formatRunStatus`; when no trustworthy activity line is
      available, print the absence explicitly, e.g.
      `worker: bridge reports running, 9m since launch / no per-turn activity signal (workflow-mode run)`
- [ ] write a table-driven test over status-text fixtures covering: no `Activity:` line;
      an `Activity:` line with `Mode: workflow` (must be suppressed, never rendered); an
      `Activity:` line with a non-workflow mode (must be rendered). Assert the render never
      implies health when no trustworthy signal exists
- [ ] write a test that a missing `asyncDir` is reported as gone, not running
- [ ] run `npm run test:all` — must pass before task 7

### Task 7: Long-running operation classification

**Files:**

- Modify: `src/controller.ts`
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] derive an operation deadline from the stage's own turn budget
      (`config.workerMaxTurns`, `config.reviewerMaxTurns`) times a per-turn allowance;
      add a code comment stating the allowance is a placeholder pending measurement
- [ ] add a `long-running active operation` branch to `recoveryGuidance`
      (`src/index.ts:396`) that fires when elapsed since `launchStartedAt` exceeds the
      deadline while the bridge still reports running
- [ ] word the guidance to name the uncertainty rather than assert death, and to offer
      re-check and cancel while warning against starting a second run
- [ ] classify only — no auto-fail, no auto-kill, no change to the polling loop
- [ ] write a table-driven test over `(elapsed, activity signal present, bridge state)`
      asserting a worker mid-model-call at nine minutes is never reported as dead; this
      is the regression test for the originally reported bug
- [ ] run `npm run test:all` — must pass before task 8

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

- [ ] add an exported `classifyAbandonment(run, evidence)` returning
      `live | abandoned | ambiguous`, with the three-part rule above; no I/O inside the
      predicate so it stays table-testable
- [ ] add `/exec doctor` to `EXEC_ACTION`, `EXEC_COMMANDS`, and the help text: one
      read-only sweep over every run that prints, per run, what it claims, what the
      evidence shows, and the single next command
- [ ] group the `doctor` output by classification so several stalled runs in different
      stages read as one list, not as one paragraph per run
- [ ] add `/exec doctor --reconcile` which, for `abandoned` runs only, clears
      `activeOperation`, sets `status` to `failed` with an explicit reason naming the
      evidence, and stamps the run so the reset is auditable
- [ ] make `--reconcile` reuse `updateIfCurrent` compare-and-swap, so a run that a live
      session reclaims between the scan and the write is skipped rather than overwritten
- [ ] leave the recovery itself to the existing `/exec resume <id>`: after reconcile a run
      is an ordinary recoverable failure, so no second retry path is introduced
- [ ] append a line to each reconciled run's progress file recording the reset and its
      evidence, so the plan's own history shows why the attempt counter did not advance
- [ ] do not consume a task attempt on reconcile — the worker never ran, so
      `taskAttempts` must not change
- [ ] on extension load, run the read-only sweep and, when any run is `abandoned`, print
      one line naming the count and pointing at `/exec doctor`; never write during startup
- [ ] make `RunRegistry.remove` handle a corrupt `run.json` that `get` cannot parse, and
      make `doctor` list corrupt directories as removable; today `list` drops them and
      `remove` throws, so nothing can clean them up
- [ ] write a table-driven test over
      `(status, lease live, asyncDir present, bridge answer)` asserting `abandoned` needs
      the full conjunction and that every partial case is `ambiguous`
- [ ] write a test that `--reconcile` skips a run whose `updatedAt` changed during the
      sweep, and one that it never touches an `ambiguous` or `live` run
- [ ] write a test that a reconciled run is then recoverable through the normal resume
      path, and that `taskAttempts` is unchanged
- [ ] write a test that startup reconciliation performs no writes
- [ ] run `npm run test:all` — must pass before task 9

### Task 9: ➕ Bring the exec-plan skill up to the new behavior

The skill is the agent-facing contract. It is how an agent decides what to do with a
stuck run, so a skill that describes the old surface is itself a recovery failure.
Tasks 1-8 add `/exec cleanup`, `/exec runs --all`, `/exec doctor`, a
`long-running active operation` classification, startup reconciliation, and immediate
stale-lease detection. None of these appear in the skill today.

**Files:**

- Modify: `skills/exec-plan/SKILL.md`
- Modify: `skills/exec-plan/references/recovery.md`

- [ ] add `/exec cleanup`, `/exec runs --all`, and `/exec doctor` to the "Choose the job"
      list in `SKILL.md`, with the retention window and the `failed` exclusion stated
- [ ] make `/exec doctor` the documented first step after a Pi restart or a session
      handoff, ahead of `/exec runs`, and state that `--reconcile` resets only provably
      abandoned runs and never launches a worker
- [ ] state that a lease whose pid is dead on this host is stale at once, so `/exec adopt`
      no longer needs a 30-second wait; absent `hostname` still waits out the heartbeat
- [ ] add the `long-running active operation` classification to `references/recovery.md`
      with its decision branch: re-check, or cancel, and never start a second run
- [ ] record that a workflow-mode run reports no trustworthy per-turn activity, so
      elapsed time is the only bound; cite `nicobailon/pi-subagents#920` so a reader knows
      the limit is upstream and temporary
- [ ] remove guidance that the new surface makes obsolete, and make sure every recovery
      branch names one command; prefer deleting a branch over adding a caveat
- [ ] fix the stale `@^0.2.2` pin at `skills/exec-plan/SKILL.md:172` to `>=0.2.2`
- [ ] verify every `/exec` subcommand named in the skill exists in `EXEC_ACTION`, and that
      every member of `EXEC_ACTION` is either documented or deliberately internal
- [ ] add a test that asserts the skill's documented subcommand list matches `EXEC_ACTION`,
      so the two cannot drift again
- [ ] run `npm run test:all` — must pass before task 10

### Task 10: Verify acceptance criteria

- [ ] verify every requirement in Overview is implemented
- [ ] load each of the eight real run records under `~/.pi/plan-exec/runs/` through
      `RunRegistry.get` and confirm all parse without error after the schema additions
- [ ] verify `/exec cleanup` preview against the real registry reports the two
      `completed_with_findings` runs and excludes the five `failed` ones
- [ ] verify no `schemaVersion` bump was introduced anywhere
- [ ] verify every recovery branch in `skills/exec-plan/references/recovery.md` names a
      command that exists, and that no branch ends without an action
- [ ] run the full gate: `npm run test:all`

### Task 11: [Final] Update documentation

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
