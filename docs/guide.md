# pi-plan-exec Guide

<!-- markdownlint-disable MD013 -->

This guide covers installation, plan format, commands, run behavior, recovery,
and local development. See [Architecture](architecture.md) for internal design.

## Install

Install Pi and the runtime extensions:

```bash
pi install npm:pi-subagents
pi install npm:@tintinweb/pi-tasks
pi install npm:@alexeiled/pi-subagents-bridge
pi install npm:@alexeiled/pi-fusion
pi install npm:@alexeiled/pi-plan-exec
```

Reload Pi after installation:

```text
/reload
```

Compatible minimum versions:

- `pi-subagents` `0.34.0`
- `@tintinweb/pi-tasks` `0.7.1`
- `@alexeiled/pi-subagents-bridge` `0.1.6`
- `@alexeiled/pi-fusion` `0.5.1`

`pi-plan-exec` uses the built-in `worker` and `reviewer` agents. It does not
require cc-thingz agents.

## Write a plan

Plans are Markdown files with ordered task or iteration headings and checkbox
items:

```markdown
# Add greeting

### Task 1: Add the greeting

- [ ] Create `greeting.txt` containing `hello`.
- [ ] Verify the file contents.

### Task 2: Document the behavior

- [ ] Add the user-facing documentation.
- [ ] Run the documentation checks.
```

Accepted headings:

```text
### Task 1: Title
### Iteration 1: Title
```

Requirements:

- numbering starts at 1 and is consecutive;
- every section has at least one checkbox;
- task structure stays stable while a run is active;
- workers mark completed items with `[x]`;
- the plan lives inside the Git repository.

By default, `/exec` can select Markdown plans under `docs/plans/`, excluding
`completed/`.

## Start a run

From an interactive Pi session in a Git repository:

```text
/exec docs/plans/20260713-add-greeting.md
```

When the path is omitted, choose a plan from the interactive list:

```text
/exec
```

The extension always asks whether to execute in place or in an isolated Git
worktree. Prefer the isolated worktree. Execution worktrees live under:

```text
~/.pi/plan-exec/worktrees/
```

No stage pushes or merges the branch.

## Commands

```text
/exec <plan>            Start a run
/exec                   Select and start a plan
/exec runs              List recent runs
/exec status <run-id>   Show status, stage, branch, and worktree
/exec pause <run-id>    Let the active child finish, then stop advancing
/exec resume <run-id>   Continue a paused run
/exec adopt <run-id>    Claim a stale or released cross-session run
/exec cancel <run-id>   Stop when safe and preserve the worktree
```

## What a run does

1. Validate the Git repository and plan structure.
2. Ask for worktree isolation.
3. Create a durable global run record and pi-tasks projection.
4. Run implementation tasks sequentially with fresh `worker` subagents.
5. Re-read plan checkboxes after every worker; worker prose does not complete a task.
6. Run comprehensive, smells, Fusion, and critical review/fix stages.
7. Finalize, collect statistics, and archive the completed plan best effort.

Only one writer is active in the execution worktree. Review and fix operations
also use fresh subagent contexts.

## Review output

Review stages must return either:

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
remain after configured review caps, the run finishes as
`completed_with_findings` rather than claiming that reviews passed.

## State and recovery

The authoritative run records live under:

```text
~/.pi/plan-exec/runs/<run-id>/run.json
```

The record stores the current stage, attempts, active child/Fusion operation,
worktree, branch, findings, and lease. Durable operation IDs let the controller
replay a start request after a crash without intentionally launching a second
writer.

Pi-tasks rows are a session-scoped UI projection. On adoption, the extension
rebuilds that projection from the global run record and plan.

Pause, cancellation, failure, and completion preserve the worktree for review.
Use `/exec status <run-id>` before manually changing it.

## Safety limits

- Git only; Mercurial is rejected.
- Detached HEAD is rejected.
- Dirty state is not silently copied into a worktree.
- The execution directory and branch are checked before writer stages.
- Task structure changes outside checkbox completion fail the run.
- Implementation tasks never run in parallel.
- Finalization, statistics, and archival are best effort.

The package is experimental. Start with disposable repositories or reviewable
worktrees until it has seen more production plan runs.

## Local source setup

Load all source extensions together:

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  -e /path/to/pi-subagents/src/extension/index.ts \
  -e /path/to/pi-tasks/src/index.ts \
  -e /path/to/pi-subagents-bridge/src/index.ts \
  -e /path/to/pi-fusion/src/index.ts \
  -e /path/to/pi-plan-exec/src/index.ts
```

Project validation:

```bash
npm run test:all
npm run publish:dry
```

See [DEVELOPMENT.md](../DEVELOPMENT.md) for release and trusted-publishing
instructions.
