---
name: exec-plan
description: Plan, run, inspect, pause, resume, adopt, diagnose, reconcile, retire, or recover a checked Markdown implementation plan through pi-plan-exec. Use when a plan-exec run is active, stuck, failed, detached after reload, cancel-pending, abandoned after a Pi restart, or `/exec resume` does not work. Do not bypass the controller by launching or resuming implementation/review subagents manually.
---

<!-- markdownlint-disable MD013 -->

# Plan Execution

Use `/exec` for a plan-exec workflow. The controller owns the worktree writer,
dependency scheduling, retries, recovery, accepted commits, and review stages.
Never replace controller recovery with a manually launched subagent.

## Choose the job

- Create a plan: write a Markdown plan under `docs/plans/` using the supported
  heading-and-checkbox format. Do not start it unless asked.
- Start a named plan: `/exec <path/to/plan.md>`.
- Start a plan in an existing worktree: `/exec --worktree <worktree-path> <path/to/plan.md>`.
  The target must be registered in the same Git repository; its current branch
  is preserved. The plan path is relative to that worktree. Put the flag first
  and quote paths with spaces. The main checkout is also accepted; no worktrees
  are auto-detected.
- Pick a plan interactively: `/exec`.
- See what is going on: `/exec status`. It is read-only, and it is the first
  step after a Pi restart or a session handoff. With no run ID it lists every
  unfinished run plus terminal runs from the last day, groups every run that
  claims work in flight by the evidence for it, reports any missing package with
  its install command, and prints one next command per run. Pi also points at it
  at session start when its startup sweep finds an abandoned run.
- Inspect one run: `/exec status <full-run-id>`.
- Continue or recover anything stuck: `/exec resume [full-run-id]`. It takes the
  lease over from a session proven dead, reconciles a run whose worker is
  provably gone and then continues it, reconciles a running child, continues a paused
  run, or safely retries a recoverable failed run. A workflow paused for a
  supervisor reply stays attached and a live controller continues automatically
  after the reply. After a restart, resume consumes its durable child result or
  reattaches the same operation without launching a duplicate. It never launches
  on partial evidence: a run whose worker cannot be proven gone is reported, not
  reconciled.
- A lease naming this host whose recorded pid is dead is stale at once, so
  `/exec resume` takes that run over with no wait. A lease recorded without a
  hostname is judged by its heartbeat alone; wait out the 30-second heartbeat
  window before treating it as stale. A lease naming another host remains live
  until `--same-machine` supplies an explicit local view.
- Recover a run `stopped because the model or provider could not be used`: `/exec resume [full-run-id]` uses the active authenticated Pi model.
- A normal resume retries a no-progress implementation task. A worker that
reports `TASK_FAILED` with unchecked items keeps the run in automatic recovery;
it preserves the blocker, schedules another attempt with backoff, and does
not create a terminal retry cap. A task blocked by something outside this run
may still require explicit retry confirmation; implementation cannot be
skipped.

Only an observed `Prerequisite: credentials|permission|missing_executable|runtime`
with an `Evidence:` line creates `waiting_external`; the controller records it
and schedules an automatic wake. Generic blocker wording never proves an
external prerequisite.

- Stop a run and choose the outcome: `/exec stop <full-run-id>`. It asks whether
  to pause (resumable) or cancel (final, worktree preserved). It needs a human
  to answer, so an agent uses the scripted path below.
- Retire terminal run records: `/exec cleanup` previews and deletes nothing;
  `/exec cleanup --apply` deletes. A terminal run becomes removable 7 days
  after its last update. `failed` runs are excluded, because their registry
  entry is what `/exec resume` needs. Removal deletes the registry entry only;
  the worktree, branch, and progress file stay in place.
- Waive an optional review/finalize/stats stage: `/exec skip <full-run-id> --reason <text>`. Required review and final verification cannot be skipped. It is a waiver of last resort and needs a human; see below.
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
- `/exec doctor` → `/exec status`. `/exec doctor --reconcile` reconciles
  provably abandoned runs while preserving their operation, candidate, and
  saved result identities; `/exec resume` performs the same reconciliation for
  the one run it is recovering.
- `/exec setup` → `/exec status`, which reports a missing package with its
  install command.
- `/exec adopt <full-run-id>` → `/exec resume <full-run-id>`.
- `/exec pause <full-run-id>` → `/exec stop` without the question. It cancels
  the current attempt, preserves the checkpoint, and leaves the run resumable
  after cleanup.
- `/exec cancel <full-run-id>` → `/exec stop` without the question. It is final
  and preserves the worktree.

Flags that answer a prompt in advance:

- `/exec resume <full-run-id> --retry-task` requests a retry of a preserved task;
  ordinary automatic retries do not require this command.
- `/exec resume <full-run-id> --adopt-current-branch` confirms rebinding the run
  to the verified current execution branch.
- `/exec resume <full-run-id> --same-machine` states that the host frozen on the
  lease was this machine under an older name. Only use it when that is a fact;
  it permits local evidence gathering. A live local controller still fences the
  claim. After the required evidence is verified, recovery rebinds the stored
  hostname while preserving the operation identity and stop state.
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

Use heading-based task sections. The canonical forms are `Task N:` and
`Iteration N:`. Lightweight `P0 —`, `P1:`, `Phase N:`, `Step N:`, and `T001:`
forms are also accepted. Every section needs a non-empty title and at least one
concrete, verifiable checkbox. Canonical Task/Iteration numbers start at `1`
and are consecutive; lightweight labels are normalized to document order.

```markdown
# Add greeting

### Task 1: Implement the greeting

- [ ] Add the greeting behavior.
- [ ] Run the focused behavior check.

### Task 2: Document it

- [ ] Update the user-facing docs.
- [ ] Run the relevant docs check.
```

Keep the plan inside the Git repository. The parser accepts `-`, `*`, `+`, or
ordered list markers before `[ ]`, `[x]`, or `[X]`; it ignores fenced code blocks.
Omit `dependsOn` to retain legacy sequential ordering. Use `dependsOn: []` for
an independent task, or a JSON array of earlier task IDs for explicit
dependencies. It does not infer dependencies, approvals, or parallelism from
prose or tables. Once a run exists, change only checkbox markers from `[ ]` to
`[x]` or `[X]`. Do not change headings, labels, dependency metadata, checkbox
text, or checkbox count. A structural change requires interactive review before
resume.

## Review provider

- The default is one required `subagent` reviewer with `reviewFallback: []`
  (`none`).
- Fusion and Revmux are explicit backend selections under the same lifecycle
  and reviewed-commit contract. They are not implicit fallbacks.
- If a fallback list is configured, it is an explicit ordered policy. A prior
  backend must be proven not to own a live child before another backend starts.
- An unavailable or ambiguous provider keeps the durable operation ID and review
  stage. Automatic probes continue; do not launch a second provider manually.

## Start safely

Prefer **Worktree (isolated)** unless the user explicitly requests in-place
execution. When a plan already exists in a linked worktree, use the explicit
`--worktree` form instead. Pi forks the session into the execution worktree.
Continue there; do not switch to the source checkout and run another worker
against the same plan or worktree.

Before starting, use `/exec status` to ensure the same plan is not already
active.
A slow or silent run is not a reason to start the plan again.

After Pi starts or reloads, the native controller automatically restores an
unfinished run when its lease is claimable. It preserves explicit user pauses,
does not steal a live foreign lease, and reattaches durable operations by ID.
The native widget and `/exec status` report task counts, dependency/retry waits,
the next automatic action, verified activity, cumulative usage, selected review
backend, and lifetime. Optional projection repair is visibility only and cannot
gate recovery.

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
an observation failure as permission to start a second run. The default
unbounded lifetime has no wall-clock deadline and never emits an over-budget
classification. Bounded compatibility is an explicit frozen choice with its
`timeoutMs`; any timeout classification is diagnostic only and never authorizes
a replacement child.

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
  dependency contract. Omitted dependencies remain sequential and explicit
  `dependsOn: []` remains independent. A task blocked by something outside the
  run needs interactive confirmation before retrying; implementation cannot be
  skipped.
- A model or provider failure is different: the child is terminal, its error
  and operation are preserved, and recovery keeps scheduling without a global
  terminal retry cap. Normal resume uses the current authenticated Pi model.
  Do not retry the same unusable model repeatedly.
- A model override applies only to the replacement child; it never pins later
  launches in this run.
- `/exec skip` is a last-resort waiver, not a review pass. It requires an
  interactive confirmation and reason, stops any tracked child before advancing,
  and ends as `completed_with_findings`. It applies only to optional review,
  finalization, or statistics stages. Required review/final verification,
  implementation, and archive cannot be skipped.
- Reconciling never launches a worker. It only converts a provably abandoned
  run into a recoverable `failed` run, leaves `taskAttempts` unchanged, and
  skips any run a live session reclaimed while it was being diagnosed. Recovery
  is still `/exec resume <full-run-id>`.
- `/exec cleanup` deletes registry entries only. It never touches the worktree,
  branch, or progress file, and it refuses a non-terminal run, one held by a
  live lease, or one a controller is recovering.
- Do not use `subagent resume` for a child owned by plan-exec.
- Do not start a new run as a substitute for `/exec resume`.
- Do not start a second non-terminal or failed run for the same plan or worktree.
  Failed runs still reserve their execution target for recovery.
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
a task. The controller accepts a task only after its committed plan checkboxes,
accepted-baseline ancestry, frozen required checks, and a clean worktree with no
uncommitted or untracked non-ignored files are verified. A worker whose
prerequisite cannot be satisfied leaves its checkboxes
open and starts its final response with `<<<RALPHEX:TASK_FAILED>>>` on its own
line, followed by `Blocker: <reason>` and `Next step: <required action>`. The
controller preserves the partial lane and schedules automatic recovery;
workflow `ok: true` is not task completion. Do not manually launch a replacement
child while the operation identity is unresolved.
Review output is either `NO_FINDINGS` or structured
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

`pi-plan-exec` requires compatible installations of `pi-subagents` and
`@alexeiled/pi-subagents-bridge`, plus the pending
public `pi-subagents/kernel-owned-process` Darwin dependency. Fusion and Revmux
are optional explicit review backends; `@tintinweb/pi-tasks` is an optional
projection cache. The strict controller requires explicit
lifetime support and full owned-process-tree containment. Unknown native APIs,
kernel bindings, or retirement evidence remain fenced. Read [runtime
contracts](../../docs/runtime-contracts.md) for the exact API, Darwin
prerequisites, and dependency PR links; installing the latest npm package does
not provide this contract.

The development checkout and CI use npm 12.0.2 with repository `.npmrc`
`allow-git=root`. A packed consumer needs a project-local `allow-git=all` for
transitive Git refs; never change global npm configuration. Run `/exec status`,
restore the reported project-local dependency, run `/reload`, then return to the
same run ID. Installing dependencies does not replace or complete the preserved
run.
