---
name: exec-plan
description: Plan, run, inspect, pause, resume, adopt, diagnose, reconcile, retire, or recover a checked Markdown implementation plan through pi-plan-exec. Use when a plan-exec run is active, stuck, failed, detached after reload, cancel-pending, abandoned after a Pi restart, or `/exec resume` does not work. Do not bypass the controller by launching or resuming implementation/review subagents manually.
---

<!-- markdownlint-disable MD013 -->

# Plan Execution

Use `/exec` for a plan-exec workflow. The controller owns the worktree writer,
task order, retries, recovery, and review stages. Never replace controller
recovery with a manually launched subagent.

## Choose the job

- Create a plan: write a strict Markdown plan under `docs/plans/`. Do not start
  it unless asked.
- Start a named plan: `/exec <path/to/plan.md>`.
- Pick a plan interactively: `/exec`.
- See what is going on: `/exec status`. It is read-only, and it is the first
  step after a Pi restart or a session handoff. With no run ID it lists every
  unfinished run plus terminal runs from the last day, groups every run that
  claims work in flight by the evidence for it, reports any missing package with
  its install command, and prints one next command per run. Pi also points at it
  at session start when its startup sweep finds an abandoned run.
- Inspect one run: `/exec status <full-run-id>`.
- Continue or recover anything stuck: `/exec resume [full-run-id]`. It takes the
  lease over from a session proven dead, resets a run whose worker is provably
  gone and then continues it, reconciles a running child, continues a paused
  run, or safely retries a recoverable failed run. It never launches on partial
  evidence: a run whose worker cannot be proven gone is reported, not reset.
- A lease whose pid is dead on this host is stale at once, so `/exec resume`
  takes that run over with no wait. A lease recorded without a hostname is
  judged by its heartbeat alone; wait out the 30-second heartbeat window before
  treating it as stale.
- Recover a run `stopped because the model or provider could not be used`: `/exec resume [full-run-id]` uses the active authenticated Pi model.
- A normal resume retries a no-progress implementation task. A run `a task is blocked by something outside this run` prompts for confirmation; implementation cannot be skipped.
- Stop a run and choose the outcome: `/exec stop <full-run-id>`. It asks whether
  to pause (resumable) or cancel (final, worktree preserved). It needs a human
  to answer, so an agent uses the scripted path below.
- Retire terminal run records: `/exec cleanup` previews and deletes nothing;
  `/exec cleanup --apply` deletes. A terminal run becomes removable 7 days
  after its last update. `failed` runs are excluded, because their registry
  entry is what `/exec resume` needs. Removal deletes the registry entry only;
  the worktree, branch, and progress file stay in place.
- Waive a blocked review/finalize/stats stage: `/exec skip <full-run-id> --reason <text>`. It is a waiver of last resort and needs a human; see below.
- Inspect live command support: `/exec help`.

Use the full run ID whenever more than one run exists, after a reload, or when
working outside the execution worktree. Do not rely on implicit run selection in
those cases.

## Scripted path for agents

`/exec stop`, `/exec skip`, and some `/exec resume` branches ask a question. A
worker subagent has no human to answer one, so every prompt has a
non-interactive equivalent. These names and flags are absent from `/exec help`
on purpose; they still work, and this is where they are collected.

Retired names, each still dispatching to its replacement and saying so once:

- `/exec runs` and `/exec runs --all` → `/exec status`. `--all` also lists
  terminal runs older than a day, under either name.
- `/exec doctor` → `/exec status`. `/exec doctor --reconcile` resets provably
  abandoned runs to a recoverable `failed`; `/exec resume` performs the same
  reset for the one run it is recovering.
- `/exec setup` → `/exec status`, which reports a missing package with its
  install command.
- `/exec adopt <full-run-id>` → `/exec resume <full-run-id>`.
- `/exec pause <full-run-id>` → `/exec stop` without the question. It stops
  after the active operation and leaves the run resumable.
- `/exec cancel <full-run-id>` → `/exec stop` without the question. It is final
  and preserves the worktree.

Flags that answer a prompt in advance:

- `/exec resume <full-run-id> --retry-task` confirms retrying a task blocked by
  something outside the run.
- `/exec resume <full-run-id> --adopt-current-branch` confirms rebinding the run
  to the verified current execution branch.
- `/exec resume <full-run-id> --same-machine` states that the host frozen on the
  lease was this machine under an older name. Only use it when that is a fact;
  it unblocks the local checks and nothing else, so a worker still running keeps
  the run refused. It is also refused while the lease heartbeat is under 30
  seconds old, whatever host it names.
- `/exec resume <full-run-id> --model current|provider/model` overrides the
  model for one replacement child after a model or provider failure.
- `/exec cleanup <full-run-id> --apply` removes one named record;
  `/exec cleanup --apply --include-failed` also removes `failed` runs, whose
  registry entry is what `/exec resume` needs.
- `/exec skip` has no scripted equivalent. The confirmation is the waiver guard
  itself, and the command fails without an interactive session. Report the
  blocked stage and the exact command instead of trying to run it.

## Command ownership

`/exec` is a Pi UI command, not a shell command or agent tool. If this agent
cannot invoke Pi slash commands, give the user the exact command and do not claim
that it ran. Never replace it with a manual subagent launch.

## Write an executable plan

Use contiguous `### Task N:` or `### Iteration N:` headings. Start at `1`; do
not skip or duplicate numbers. Every task needs a non-empty title and at least
one concrete, verifiable checkbox.

```markdown
# Add greeting

### Task 1: Implement the greeting

- [ ] Add the greeting behavior.
- [ ] Run the focused behavior check.

### Task 2: Document it

- [ ] Update the user-facing docs.
- [ ] Run the relevant docs check.
```

Keep the plan inside the Git repository. Once a run exists, change only
checkbox markers from `[ ]` to `[x]` or `[X]`. Do not change headings, numbers,
checkbox text, or checkbox count. A structural change requires interactive
review before resume.

## Start safely

Prefer **Worktree (isolated)** unless the user explicitly requests in-place
execution. Pi forks the session into the execution worktree. Continue there; do
not switch to the source checkout and run another worker against the same plan.

Before starting, use `/exec status` to ensure the same plan is not already
active.
A slow or silent run is not a reason to start the plan again.

## Observe before controlling

For every control or recovery request:

1. Run `/exec status` and select the durable run ID. After a Pi restart, a
   session change, or an unknown owner, that same sweep is the diagnosis.
2. Run `/exec status <full-run-id>`.
3. Record the status, stage, worktree, branch, active or failed operation,
   progress path, last observation, worker signal, terminal child error, and
   run error.
4. Choose exactly one action from that evidence.
5. Run `/exec status <full-run-id>` again and verify the same run moved to the
   expected state.

`/exec status` is observational. It reports one recovery classification and one
safe next action. Take that action and nothing else. A run classified
`running, and the worker reported activity` is left alone while the controller
polls it.

A run without a per-turn activity signal is neither alive nor dead as far as
plan-exec can tell, and `/exec status` says so in those words. Absence of a
signal is not evidence that the worker died. Do not treat
`running, but nothing proves the worker is alive` or
`running longer than its budget allows` as permission to start a second run.

`/exec status` names `/exec stop <id>` because it writes for a human at a
keyboard, and `/exec stop` asks whether to pause or to cancel. An agent has
nobody to answer that: take the scripted path above.

## Recover a stuck run

Read [references/recovery.md](references/recovery.md) whenever any of these is
true:

- `/exec resume` fails, refuses the state, or returns without progress;
- Pi reloaded, changed session, or handed off to another worktree;
- `/exec status` reports an abandoned or ambiguous run;
- the run is failed, paused, stopping, or owned by another session;
- Bridge, Fusion, pi-subagents, or pi-tasks is missing or unavailable;
- the plan structure changed or archive failed;
- `/exec status` cannot find a known run or reports a corrupt record;
- child output suggests `subagent resume` instead of plan-run recovery.

The recovery reference is the decision tree. Do not improvise around a preserved
active operation. If its identity cannot be reconciled, stop rather than risk a
second writer.

## Safety invariants

- Resume the **plan run ID**, never the reviewer/worker child run ID.
- Rebinding a run to the current execution branch requires confirmation and no
  active child. It verifies the same repository and records the branch change
  before resuming.
- A normal resume resets a no-progress implementation retry and preserves the
  sequential checkbox contract. A task blocked by something outside the run
  needs interactive confirmation before retrying; implementation cannot be
  skipped.
- A model or provider failure is different: the child is terminal, its
  error and operation are preserved, and the implementation retry budget is not
  consumed. Normal resume uses the current authenticated Pi model. Do not retry
  the same unusable model repeatedly.
- A model override applies only to the replacement child; it never pins later
  launches in this run.
- `/exec skip` is a last-resort waiver, not a review pass. It requires an
  interactive confirmation and reason, stops any tracked child before advancing,
  and ends as `completed_with_findings`. Never use it for implementation or
  archive stages.
- Reconciling never launches a worker. It only converts a provably abandoned
  run into a recoverable `failed` run, leaves `taskAttempts` unchanged, and
  skips any run a live session reclaimed while it was being diagnosed. Recovery
  is still `/exec resume <full-run-id>`.
- `/exec cleanup` deletes registry entries only. It never touches the worktree,
  branch, or progress file, and it refuses a non-terminal run or one held by a
  live lease.
- Do not use `subagent resume` for a child owned by plan-exec.
- Do not start a new run as a substitute for `/exec resume`.
- Do not hand-edit `~/.pi/plan-exec/runs/<id>/run.json`.
- Do not edit the worktree until status evidence rules out a live writer.
- `/exec resume` on a run another session owns is an active takeover that may
  advance work. Inspect first.
- Cancelling records `cancel_pending`; cancellation is complete only when
  status says `cancelled`.
- Preserve the worktree and run artifacts on every failed recovery attempt.
- Changing globally installed Pi packages requires explicit user approval.

## Completion truth

Plan checkboxes are implementation truth. Worker prose alone does not complete
a task. Review output is either `NO_FINDINGS` or structured
`FINDING: CRITICAL|MAJOR|MINOR | ...` records.

Do not report success until `/exec status <id>` is terminal and the worktree is
verified. `completed_with_findings` is terminal, not clean, and cannot be
resumed. Report unresolved findings and create a new scoped plan only when the
user asks.

## Recovery report

After recovery, report:

```text
PLAN RECOVERY
Run: <full ID>
Action: <wait|resume|stop|skip|cleanup|reconcile|repair extension|blocked>
Before: <status/stage/operation/error>
After: <status/stage/operation>
Worktree: <path and git state>
Verification: <status/checks actually run>
Remaining risk: <none or exact blocker>
```

If recovery is unsafe or unsupported, use `Action: blocked`. State the exact
record, worktree, active-operation evidence, and approval or runtime fix needed.

## Prerequisites

`pi-plan-exec` requires compatible installations of `pi-subagents`,
`@tintinweb/pi-tasks`, `@alexeiled/pi-subagents-bridge` `>=0.2.2`, and
`@alexeiled/pi-fusion`. Run `/exec status`, install what it reports, run
`/reload`, then return to the same run ID. Installing dependencies does not
replace or complete the preserved run.
