# Stuck Run Recovery

Read this only for recovery. The goal is to continue the same durable plan run
and worktree without creating another writer.

## Establish evidence

Run:

```text
/exec runs
/exec status <full-run-id>
```

Capture:

- full plan run ID;
- status and stage;
- worktree and branch;
- active operation kind and external run ID, when present;
- progress path and last successful observation;
- exact error.

If `/exec status` cannot read the record, inspect
`~/.pi/plan-exec/runs/<run-id>/run.json` read-only. Inspect the reported
worktree with `git status --short --branch`. Do not edit either location yet.
Stale terminal output does not prove that a child stopped.

## Healthy running or starting

If status shows a healthy active operation, wait. Use `/exec status <id>` again
later. Do not run resume, start, or a manual subagent merely because the child is
slow.

If observations are unavailable but an active operation is preserved, repair
the provider first. Then reload and resume the same plan run. The controller
must reconcile that operation before it can continue.

## Paused

Use:

```text
/exec resume <full-run-id>
```

A paused terminal child remains controller-owned. Resume applies its result; do
not resume the child directly.

## Failed

Inspect the stage, error, and active-operation fields first.

- No active operation: `/exec resume <id>` retries the same stage in the same
  worktree, except a retry-exhausted or externally blocked implementation task.
  Fix or verify that blocker, then explicitly opt in with `/exec resume <id>
  --retry-task`. Implementation is sequential; it cannot be skipped.
- Preserved active operation: `/exec resume <id>` adopts or looks up that exact
  operation before retrying.
- Operation lookup is `pending`: wait, reload if needed, then resume again.
- Operation lookup is `found`: let the controller observe it.
- Operation lookup is `unknown` or the provider is unreachable: repair the
  provider and retry resume. Do not launch another child.
- Provider reports the operation absent after an unknown launch outcome: stop.
  Plan-exec refuses a blind replay because another writer cannot be ruled out.

Budget exhaustion is a plan-run failure. Resume the plan run ID, not the child
ID shown in pi-subagents output. Recovery raises implementation and review
budgets where supported. A task retry limit is different: normal resume refuses
to reset it. Status labels it `retry-exhausted or no-progress task` or
`external/manual blocker` and prints the exact `--retry-task` command.

## Force-skip a blocked stage

Use this only after inspecting the findings and active operation:

```text
/exec skip <full-run-id> --reason "<why the residual risk is accepted>"
```

Pi asks for interactive confirmation. The controller records `skip_pending`,
stops any tracked Bridge/Fusion child, and waits for terminal provider evidence
before it advances. Do not retry, start, or manually stop a child while that
state is pending. A skipped review/finalize/stats stage is visibly audited,
known findings remain unresolved, and the final run becomes
`completed_with_findings`. Implementation and archive cannot be skipped.

## Cancel pending or failed cancellation

`/exec cancel <id>` only requests cancellation. It does not prove that the child
stopped.

Use `/exec status <id>` until status becomes `cancelled` or `failed`. If
cancellation failed because the provider was unavailable, repair the provider,
then use:

```text
/exec resume <full-run-id>
```

That retries cancellation. It does not resume normal plan work. Never start a
replacement worker while cancellation is unresolved.

## Stale owner or different session

Inspect the selected run before takeover:

```text
/exec status <full-run-id>
/exec adopt <full-run-id>
/exec status <full-run-id>
```

Adopt is active: it claims and may immediately advance the run. Use it only for
an unfinished run owned by a stale or different session. If resume hands Pi into
the execution worktree, continue recovery in that forked session.

## Plan structure changed

Do not silently accept changed task structure. Status says `plan-structure review
required` and explains whether the first resume only records `paused`; if so,
review the plan and run the interactive resume a second time. This is deliberate
for legacy records and is safer than silently adopting a new task contract.

Choose one:

1. Restore the original headings, numbering, checkbox text, and checkbox count;
   then resume.
2. Review the current plan and use interactive `/exec resume <id>` to confirm
   adopting its new structure.

Headless recovery cannot approve a changed plan structure.

## Execution branch changed

If status or resume reports `Execution directory is on <current>, expected
<recorded>`, inspect the current branch and worktree first. When the current
named branch is authoritative, has no tracked child, and belongs to the same
repository, use:

```text
/exec resume <full-run-id> --adopt-current-branch
```

Pi requires interactive confirmation, records the old/new branch, and resumes
the same run. Do not hand-edit the durable branch or switch branches while a
child is live.

## Provider or command unavailable

If `/exec` reports missing Bridge, Fusion, pi-subagents, or pi-tasks:

1. Run `/exec setup`.
2. Install the reported compatible packages.
3. Run `/reload`.
4. Run `/exec runs` and `/exec status <id>`.
5. Resume or adopt the same run ID.

`/exec setup` only prints setup commands. Installation and reload do not advance
the run.

If `/exec` itself is missing after reload, inspect `pi list` and the Pi package
configuration. Restore the package before touching the preserved run.

## Archive failed

A failed `archive` stage is resumable.

Before resume, inspect:

- the original plan path;
- `docs/plans/completed/<plan-name>` or the corresponding completed directory;
- `git status --short --branch`;
- the archive error and progress file.

If both source and completed destination exist, stop and ask which copy is
authoritative. Do not overwrite either. If Git staging or commit failed, fix the
reported Git condition, then `/exec resume <id>`. Archive retry is idempotent
when the completed move already committed.

## Run missing or registry corrupt

A corrupt run may be omitted from `/exec runs` with a warning. There is no
supported command that repairs arbitrary `run.json` content.

- Preserve the corrupt record, worktree, progress file, and async artifacts.
- Do not hand-edit the registry to make the run appear resumable.
- Verify whether an external operation may still be alive.
- If the extension source is available, fix the loader or migration with a
  regression test, install the repaired local package with user approval,
  `/reload`, and retry the same run ID.
- If the record cannot be repaired, starting a replacement run is a last resort,
  not resume. Require user approval and first prove there is no live child.
  Reuse the preserved worktree in-place only after reviewing its Git state and
  plan checkboxes. Report that durable run lineage was lost.

## `/exec resume` is itself defective

Treat a repeatable resume rejection or wrong transition as an extension bug,
not permission to bypass the controller.

With explicit user approval to change the installed Pi package:

1. Preserve the run record, status output, worktree, and operation artifacts.
2. Reproduce the state transition in a focused controller or command test.
3. Patch the smallest runtime defect in a source checkout.
4. Run focused tests, then the package's full validation.
5. Install or link that local package according to Pi package docs.
6. Run `/reload`.
7. Retry `/exec status <id>` and `/exec resume <id>` on the same run.
8. Verify the same worktree and operation identity were retained.

Do not manually invoke implementation, review, fix, finalizer, or statistics
subagents while repairing the extension.

## Terminal states

- `completed`: verify checkboxes, archived plan, tests, and clean/reviewed Git
  state. No resume is needed.
- `completed_with_findings`: terminal and not clean. Inspect progress and review
  findings. Report them; use a new scoped plan only with user approval.
- `cancelled`: terminal and not resumable. To continue later, create a new run
  only after confirming no live child and reviewing the preserved worktree.
- `failed`: terminal for automatic polling but eligible for explicit recovery.

## Verify recovery

After every action, run `/exec status <id>` and confirm:

- the full run ID did not change;
- the worktree and branch did not change unexpectedly;
- no second external operation was created;
- status/stage moved as intended;
- the progress file records the transition.

For final completion, also verify plan checkbox truth, the relevant test/build
checks, archived-plan location, and `git status --short --branch`. State every
remaining finding or unverified check.
