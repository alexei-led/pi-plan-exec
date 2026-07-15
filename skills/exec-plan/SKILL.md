---
name: exec-plan
description: Execute and recover a checked Markdown implementation plan through pi-plan-exec. Use when the user asks to run or resume a plan, inspect execution progress, or control a plan-exec run; use /exec help for the interactive command list.
---

<!-- markdownlint-disable MD013 -->

# Plan Execution

Use the installed `/exec` command. Do not manually launch implementation or
review subagents for an active plan-exec run.

## Start

```text
/exec help                         Show commands and recovery hints
/exec                              Pick a plan under docs/plans/
/exec path/to/plan.md              Start a named plan
/exec start path/to/plan.md        Explicit start form
/exec setup                         Show provider install commands
```

The command asks whether to use an isolated worktree. Prefer `Worktree
(isolated)` unless the user explicitly requests in-place execution. When chosen,
Pi forks the current session into the execution worktree so its tools and footer
use that directory and branch.

## Inspect and control

Run IDs are optional when one run matches the current repository or worktree.
If multiple runs match, Pi opens a picker in interactive mode. `/exec runs`
shows full IDs for explicit selection and headless recovery.

```text
/exec status                      Show live stage, worker, error, and worktree
/exec runs                        List recent runs and full IDs
/exec pause                       Pause after the active child finishes
/exec resume                      Continue a paused run, review plan structure, or retry an exhausted worker
/exec adopt                       Claim a stale cross-session run
/exec cancel                      Stop safely and preserve the worktree
```

Pi shows the execution worktree and branch alongside the current stage and active
worker while polling. Stage transitions, failures, cancellation, and completion
are notified in Pi.

## Rules

- Do not edit an active execution plan except to change completed checkbox
  markers from `[ ]` to `[x]` (or `[X]`). Keep headings, task numbers, checkbox
  text, and item count unchanged.
- Do not write verification results into checkbox item text. Report them in the
  worker response and progress artifacts.
- Do not manually launch implementation/review subagents for an active run.
- A worker report does not complete a task. The controller re-reads the plan and
  advances only when all task checkboxes are checked.
- Plan structure changes pause the run for review. Do not silently accept them in
  headless mode; interactive `/exec resume` asks for explicit confirmation.
- Failed or cancelled runs preserve their worktrees. Inspect with `/exec status`
  before changing anything manually. A legacy run failed by a plan-structure
  mismatch can be resumed interactively after confirming the current structure.
  A worker that exhausts its turn budget with an unchecked task can be retried
  with interactive `/exec resume`; it preserves existing work and raises the
  worker budget to 75 turns.

## Completion truth

The plan checkbox state is the implementation truth. Review stages use either
`NO_FINDINGS` or structured `FINDING: CRITICAL|MAJOR|MINOR | ...` records. A
`completed_with_findings` run completed its workflow with known findings left
after review caps; state that plainly.

## Prerequisites

`pi-plan-exec` integrates with independently installed Pi packages at compatible
versions:

- `pi-subagents`
- `@tintinweb/pi-tasks`
- `@alexeiled/pi-subagents-bridge`
- `@alexeiled/pi-fusion`

Use `/exec setup` for install commands, then run `/reload`. `/exec` probes the
bridge and Fusion capabilities before creating a run and fails clearly if they
are unavailable. The `pi-plan-exec` package installs only its own `exec-plan`
skill and `/exec` command.
