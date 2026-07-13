---
name: exec-plan
description: Run or control a ralphex-style implementation plan through the pi-plan-exec extension. Use when the user says exec, execute plan, run plan, resume plan execution, or asks for an execution-run status.
---

<!-- markdownlint-disable MD013 -->

# Plan Execution

Use `/exec <plan>` to start a run. The extension owns stage order, retries,
worktrees, checkpoints, background child observation, and final status.

## Rules

- Do not manually launch implementation/review subagents for an active plan-exec run.
- Do not edit the execution plan while a run is active except to complete checkbox items through the assigned worker.
- Use `/exec status <run-id>` or `/exec runs` for status.
- Use `/exec pause`, `/exec resume`, `/exec adopt`, and `/exec cancel` rather than changing run registry files.
- A `completed_with_findings` run completed its workflow with known findings left after review caps. State that plainly.
- A failed or cancelled run preserves its worktree. Do not remove it without explicit user approval.

## Completion Truth

The plan's checkbox state is the implementation truth. A worker report alone does
not complete a task. Review stages use either `NO_FINDINGS` or structured
`FINDING: CRITICAL|MAJOR|MINOR | ...` records.
