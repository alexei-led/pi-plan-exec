---
name: exec-plan
description: Plan, run, inspect, pause, resume, adopt, or recover a checked Markdown implementation plan through pi-plan-exec. Use when the user asks to create an executable plan for `/exec`, start or control a plan-exec run, check its progress, or recover it after a reload or worker failure; use `/exec help` for the live command list.
---

<!-- markdownlint-disable MD013 -->

# Plan Execution

Use `/exec` for an active plan-exec workflow. Do not manually launch
implementation, review, or fix subagents for that run. The controller owns its
one-writer rule, task order, retries, recovery, and review stages.

## Choose the job

| User need                                              | Action                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Write a plan to run later                              | Create a strict executable plan under `docs/plans/`; do not start it unless asked. |
| Start a named plan                                     | `/exec path/to/plan.md` or `/exec start path/to/plan.md`                           |
| Pick a plan                                            | `/exec`                                                                            |
| See a live run                                         | `/exec status`                                                                     |
| Find or identify runs                                  | `/exec runs`                                                                       |
| Stop after the active child                            | `/exec pause`                                                                      |
| Continue a paused or recoverable run                   | `/exec resume`                                                                     |
| Take over an unfinished stale run from another session | `/exec adopt`                                                                      |
| Stop safely and keep the worktree                      | `/exec cancel`                                                                     |
| Missing packages or unclear command behavior           | `/exec setup` or `/exec help`                                                      |

Run IDs are optional when exactly one allowed run matches the current repository
or worktree. If Pi cannot choose, use `/exec runs`, then pass the full ID.

## Write an executable plan

A plan is a Markdown file with contiguous numbered `### Task N:` or
`### Iteration N:` headings. Every task needs at least one checkbox.

```markdown
# Add greeting

### Task 1: Implement the greeting

- [ ] Add the greeting behavior.
- [ ] Run the focused behavior check.

### Task 2: Document it

- [ ] Update the user-facing docs.
- [ ] Run the relevant docs check.
```

Before starting, check these rules:

- Number tasks from `1` with no duplicates or gaps.
- Use heading level `###` exactly.
- Give each task a non-empty title and one or more checkbox items.
- Keep the plan inside the Git repository.
- Make checkboxes concrete and verifiable. One task should be one coherent unit
  of work, not an entire feature plus every possible cleanup.

Once a run is active, change only checkbox state. Do not change task headings,
numbers, checkbox text, or item count. A structural change pauses the run for
review.

## Start safely

```text
/exec help
/exec                              Pick a plan under docs/plans/
/exec path/to/plan.md              Start a named plan
/exec start path/to/plan.md        Explicit start form
/exec setup                        Show provider install commands
```

Prefer **Worktree (isolated)** unless the user explicitly asks for in-place
execution. Pi forks the session into the execution worktree; its shell, tools,
footer, and task projection then use the execution branch. Do not switch back to
the source checkout and manually run agents against the same plan.

## Watch a long run

A run can last for hours. Leave the controller alone while it polls; do not run
`/exec <plan>` again just because it has been running for a while.

```text
/exec status                      Show stage, operation, progress, error, and worktree
/exec runs                        List recent runs and full IDs
```

`/exec status` is safe to run repeatedly. It observes the run; it does not pause,
restart, or duplicate work. Pi shows the current worktree, branch, stage, and
active worker while polling, and announces stage changes, failures, cancellation,
and completion.

## Pause, resume, and recover

```text
/exec pause                       Let the active child finish, then hold progress
/exec resume                      Continue a paused run, review changed plan structure, or retry an exhausted worker
/exec adopt                       Take over an unfinished stale run from another session
/exec cancel                      Stop safely and preserve the worktree
```

Use the smallest action that matches the situation:

1. **Need a break:** use `/exec pause`; do not cancel a healthy run.
2. **Ready to continue:** use `/exec resume` from the execution worktree. If
   entered from the source checkout, Pi hands the session into the run’s
   worktree first.
3. **Pi reloaded:** inspect with `/exec status`. A matching run owned by the
   returning session reattaches automatically. Do not start a duplicate plan.
4. **Run belongs to a stale or other session:** use `/exec adopt`, then inspect
   its status.
5. **Worker exhausted its budget with unchecked implementation items:** use
   interactive `/exec resume`. The run keeps its worktree and retries with a
   75-turn worker budget.
6. **Plan structure changed:** restore its original structure, or review the
   current plan and explicitly confirm adoption through interactive `/exec
resume`.
7. **Need to stop:** use `/exec cancel`. It waits for the external operation to
   stop safely and preserves the worktree.

A failed run is not an invitation to edit its worktree blindly. Start with
`/exec status`. Fix the named cause before retrying failures that are not a
paused plan, reviewed structure change, or exhausted implementation worker.

## Completion truth

Plan checkboxes are the implementation record. A worker report alone does not
complete a task. Review output is either `NO_FINDINGS` or structured
`FINDING: CRITICAL|MAJOR|MINOR | ...` records. `completed_with_findings` means
the workflow finished with known findings left after the review cap; say that
plainly.

## Prerequisites

`pi-plan-exec` uses compatible independently installed Pi packages:

- `pi-subagents`
- `@tintinweb/pi-tasks`
- `@alexeiled/pi-subagents-bridge`
- `@alexeiled/pi-fusion`

Run `/exec setup` for install commands, then `/reload`. `/exec` probes the
bridge and Fusion before it creates a run and fails clearly when they are
unavailable. The package installs only `/exec` and this `exec-plan` skill.
