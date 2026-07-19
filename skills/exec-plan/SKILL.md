---
name: exec-plan
description: Plan, run, inspect, pause, resume, adopt, or recover a checked Markdown implementation plan through pi-plan-exec. Use when a plan-exec run is active, stuck, failed, detached after reload, cancel-pending, or `/exec resume` does not work. Do not bypass the controller by launching or resuming implementation/review subagents manually.
---

<!-- markdownlint-disable MD013 -->

# Plan Execution

Use `/exec` for a plan-exec workflow. The controller owns the worktree writer,
task order, retries, recovery, and review stages. Never replace controller
recovery with a manually launched subagent.

## Choose the job

- Create a plan: write a strict Markdown plan under `docs/plans/`. Do not start
  it unless asked.
- Start a named plan: `/exec start path/to/plan.md`.
- Pick a plan interactively: `/exec`.
- List durable runs: `/exec runs`.
- Inspect one run: `/exec status <full-run-id>`.
- Request a pause for a starting or running run: `/exec pause <full-run-id>`.
- Continue or recover: `/exec resume <full-run-id>`.
- Retry an exhausted or externally blocked implementation task only after fixing or verifying the blocker: `/exec resume <full-run-id> --retry-task`.
- Adopt a verified current execution branch: `/exec resume <full-run-id> --adopt-current-branch`.
- Claim an unfinished stale run: `/exec adopt <full-run-id>`.
- Force-skip a blocked review/finalize/stats stage: `/exec skip <full-run-id> --reason <text>`.
- Request safe cancellation: `/exec cancel <full-run-id>`.
- Inspect live command support: `/exec help`.
- Repair missing packages: `/exec setup`, install the reported packages, then
  `/reload`.

Use the full run ID whenever more than one run exists, after a reload, or when
working outside the execution worktree. Do not rely on implicit run selection in
those cases.

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

Before starting, use `/exec runs` to ensure the same plan is not already active.
A slow or silent run is not a reason to start the plan again.

## Observe before controlling

For every control or recovery request:

1. Run `/exec runs` and select the durable run ID.
2. Run `/exec status <full-run-id>`.
3. Record the status, stage, worktree, branch, active operation, progress path,
   last observation, and error.
4. Choose exactly one action from that evidence.
5. Run `/exec status <full-run-id>` again and verify the same run moved to the
   expected state.

`/exec status` is observational. It reports a recovery classification and one
safe next action. A healthy active operation should normally be left alone while
the controller polls it.

## Recover a stuck run

Read [references/recovery.md](references/recovery.md) whenever any of these is
true:

- `/exec resume` fails, refuses the state, or returns without progress;
- Pi reloaded, changed session, or handed off to another worktree;
- the run is failed, paused, cancel-pending, or owned by another session;
- Bridge, Fusion, pi-subagents, or pi-tasks is missing or unavailable;
- the plan structure changed or archive failed;
- `/exec runs` cannot find a known run or reports a corrupt record;
- child output suggests `subagent resume` instead of plan-run recovery.

The recovery reference is the decision tree. Do not improvise around a preserved
active operation. If its identity cannot be reconciled, stop rather than risk a
second writer.

## Safety invariants

- Resume the **plan run ID**, never the reviewer/worker child run ID.
- `--adopt-current-branch` requires interactive confirmation and no active
  child. It verifies the same repository and records the branch change before
  resuming.
- A retry-exhausted or external/manual-blocked implementation task requires
  `--retry-task`; normal resume refuses to reset its attempts. Implementation
  checkboxes are sequential and cannot be skipped.
- `/exec skip` is a last-resort waiver, not a review pass. It requires an
  interactive confirmation and reason, stops any tracked child before advancing,
  and ends as `completed_with_findings`. Never use it for implementation or
  archive stages.
- Do not use `subagent resume` for a child owned by plan-exec.
- Do not run `/exec start` as a substitute for `/exec resume`.
- Do not hand-edit `~/.pi/plan-exec/runs/<id>/run.json`.
- Do not edit the worktree until status evidence rules out a live writer.
- `/exec adopt` is an active takeover that may advance work. Inspect first.
- `/exec cancel` records `cancel_pending`; cancellation is complete only when
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
Action: <wait|resume|adopt|cancel|repair extension|blocked>
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
`@tintinweb/pi-tasks`, `@alexeiled/pi-subagents-bridge` `0.2.0` or later, and
`@alexeiled/pi-fusion`. Use `/exec setup`, install what it reports, run
`/reload`, then return to the same run ID. Installing dependencies does not
replace or complete the preserved run.
