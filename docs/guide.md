# pi-plan-exec Guide

<!-- markdownlint-disable MD013 -->

Use this guide to install `pi-plan-exec`, write an executable plan, run it, and
recover a run safely. See [Architecture](architecture.md) for implementation
contracts and component ownership.

## Requirements

- Pi in an **interactive** session. `/exec` asks whether to use a worktree.
- A Git repository with a non-detached `HEAD`.
- A plan file inside that repository.
- These independently installed Pi packages, at compatible versions:
  - `pi-subagents`;
  - `@tintinweb/pi-tasks`;
  - `@alexeiled/pi-subagents-bridge`;
  - `@alexeiled/pi-fusion`;
  - `@alexeiled/pi-plan-exec`.

`pi-plan-exec` uses pi-subagents’ built-in `worker` and `reviewer` agents. It
does not require cc-thingz agents.

## Install

```bash
pi install npm:pi-subagents
pi install npm:@tintinweb/pi-tasks
pi install npm:@alexeiled/pi-subagents-bridge
pi install npm:@alexeiled/pi-fusion
pi install npm:@alexeiled/pi-plan-exec
```

Reload Pi after installing:

```text
/reload
```

## Executable plan format

An executable plan is a Markdown file with a sequence of numbered task or
iteration sections. Each section contains one or more checkbox items.

```markdown
# Add greeting

Optional context is allowed before, between, and inside task sections.

### Task 1: Add the greeting

- [ ] Create `greeting.txt` containing exactly `hello`.
- [ ] Verify it with `test "$(cat greeting.txt)" = "hello"`.

### Task 2: Document the behavior

- [ ] Add the user-facing documentation.
- [ ] Run the relevant documentation checks.
```

The parser accepts these heading forms:

```text
### Task 1: Short task title
### Iteration 1: Short task title
```

The plan contract is strict:

| Rule          | Required behavior                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Heading level | Use exactly `###`.                                                                                       |
| Heading kind  | Use `Task` or `Iteration`, followed by a positive integer and `:`.                                       |
| Numbering     | Start at `1`; use each number exactly once; do not skip numbers.                                         |
| Title         | Put non-empty text after `:`.                                                                            |
| Checkbox      | Each task needs at least one `- [ ] item` or `- [x] item`. `[X]` also means checked.                     |
| Location      | Keep the plan inside the Git repository.                                                                 |
| Active run    | Do not change task numbers, titles, checkbox text, or add/remove task items. Only change checkbox state. |

Text that is not a matching checkbox is context only. It does not create work or
complete a task. All matching checkboxes between one task heading and the next
belong to that task.

### Completion semantics

A task is incomplete while it has any unchecked item. The controller starts the
first incomplete task, then re-reads the plan after the worker finishes:

- `[ ]` means pending work.
- `[x]` or `[X]` means completed work.
- A worker’s chat summary does **not** complete a task.
- Checking every item in a task advances to the next numbered task.
- Changing task structure during a run fails the run; restore the original
  structure, then inspect the run before resuming it.

Write concrete, verifiable items. Each item should name an outcome and, where
possible, its verification. Avoid broad items such as “finish feature” that
combine unrelated behavior and checks.

### Invalid examples

These plans are rejected before the controller starts work:

```markdown
## Task 1: Wrong heading level

- [ ] This is ignored because the heading is not `###`.

### Task 2: Wrong first task number

- [ ] Numbering must start at 1.

### Task 1: Missing checkboxes

Write the feature.
```

## Start a run

From an interactive Pi session at the repository root:

```text
/exec docs/plans/20260713-add-greeting.md
```

To choose a Markdown plan beneath `docs/plans/`, excluding directories named
`completed`:

```text
/exec
```

The extension always asks whether to use the current checkout or an isolated
Git worktree. Prefer the worktree. Worktrees live outside the source repository:

```text
~/.pi/plan-exec/worktrees/
```

No stage pushes or merges a branch.

## Commands

Use `/exec help` for the same hint inside Pi. Run IDs are optional for normal
use: when one run matches the current repository or worktree, `/exec status`,
`pause`, `resume`, `adopt`, and `cancel` select it automatically. If several
runs match, Pi opens a picker; headless mode asks for the full ID shown by
`/exec runs`.

```text
/exec [plan]            Start a run; bare /exec opens the plan picker
/exec start [plan]      Start a run explicitly
/exec setup             Show required packages and install commands
/exec help              Show commands, progress, and recovery hints
/exec runs              List recent runs and full IDs
/exec status [run-id]   Show status, active worker, progress path, and error
/exec pause [run-id]    Let the active child finish, then stop advancing
/exec resume [run-id]   Continue a paused run
/exec adopt [run-id]    Claim a stale or released cross-session run
/exec cancel [run-id]   Stop when safe and preserve the worktree
```

The footer shows the current stage and active worker while a run is polling.
Stage transitions, observation degradation, and terminal states generate
notifications. `/exec status` shows the last successful observation and retry
count; three failed observations stop the run plainly instead of implying it is
still progressing. A failed run preserves its worktree and remains visible in
`/exec status` and the projected task description.

## Run lifecycle

A run:

1. Validates the Git repository and executable-plan contract.
2. Asks for in-place execution or worktree isolation.
3. Creates a durable global run record and a pi-tasks projection.
4. Runs implementation tasks in order with fresh `worker` subagents.
5. Re-reads plan checkboxes after every worker; worker prose is not completion
   evidence.
6. Runs comprehensive, smells, Fusion, and critical review/fix stages.
7. Finalizes, collects statistics, and archives the completed plan best effort.

Only one writer is active in the execution worktree. Every implementation,
review, and fix operation has fresh subagent context.

## Review results

Review stages return either:

```text
NO_FINDINGS
```

or structured findings:

```text
FINDING: MAJOR | Input validation is missing
Evidence: src/input.ts:17 accepts an empty value and later throws.
Fix: Reject empty input at the boundary.
```

Supported severities are `CRITICAL`, `MAJOR`, and `MINOR`. If known findings
survive configured review caps, the result is `completed_with_findings`. The
controller does not claim that reviews passed.

## Recovery and safety

Authoritative records live at:

```text
~/.pi/plan-exec/runs/<run-id>/run.json
```

They store stage, attempts, active Bridge/Fusion operation, worktree, branch,
findings, and lease. Durable operation IDs let the controller replay a start
after a crash without intentionally launching a second writer.

Pi-tasks is a session-scoped UI projection. On adoption, the projection is
rebuilt from the global record and plan.

Pause, cancellation, failure, and completion preserve the worktree for review.
Use `/exec status <run-id>` before manually changing it.

Safety limits:

- Git only; Mercurial and detached `HEAD` are rejected.
- Dirty state is not silently copied into a worktree.
- The execution directory and branch are checked before writer stages.
- Implementation tasks never run in parallel.
- Finalization, statistics, and plan archival are best effort.

The package is experimental. Use disposable repositories or reviewable
worktrees until it has seen more production plan runs.

For local setup, validation, and tag-driven releases, see
[DEVELOPMENT.md](../DEVELOPMENT.md).
