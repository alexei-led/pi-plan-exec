# Stuck Run Recovery

Read this only for recovery. The goal is to continue the same durable plan run
and worktree without creating another writer.

## Establish evidence

Run these in order:

```text
/exec doctor
/exec runs
/exec status <full-run-id>
```

`/exec doctor` is read-only and comes first after a Pi restart or a session
handoff. It groups every run that claims work in flight as `abandoned`,
`ambiguous`, or `live`, names the evidence behind each verdict, and prints one
next command per run. Pi prints a pointer to it at session start when its
startup sweep finds an abandoned run.

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

## Running or starting

`/exec status` prints one classification for a run that is still in flight.
Match it below and run its command. Never run resume or a manual subagent
merely because a child is slow.

`/exec status` writes for a human at a keyboard, so it names `/exec stop <id>`,
which asks whether to pause or to cancel. An agent has nobody to answer that
question: use `/exec pause <full-run-id>` or `/exec cancel <full-run-id>`
instead. Both still work and neither asks.

### `running, and the worker reported activity`

A trustworthy per-turn activity signal was read. Wait, then re-check:

```text
/exec status <full-run-id>
```

### `running, but nothing proves the worker is alive`

No per-turn activity signal is available, so the worker is neither confirmed
alive nor confirmed dead. This is the normal reading for a workflow-mode run.
Absence of a signal is not evidence of death. Wait, then re-check:

```text
/exec status <full-run-id>
```

### `running longer than its budget allows`

The bridge still reports the operation running past the bound derived from its
own stage budget: two minutes per turn, so 150 minutes for the default 75-turn
worker and 60 minutes for the default 30-turn reviewer. The bound fires only
when no trustworthy activity signal exists, and elapsed time is not proof that
the worker is stuck — a worker mid-model-call reports nothing for a long time.

Re-check first:

```text
/exec status <full-run-id>
```

Once the user accepts losing the in-flight work, stop the run and keep the
worktree:

```text
/exec cancel <full-run-id>
```

Never start a second run for the same plan.

### `the worker's files are gone, so nothing is running`

The operation's async directory no longer exists, so the worker is not running.

When `/exec doctor` classifies the run `abandoned`, reset it:

```text
/exec doctor --reconcile
```

`--reconcile` takes no run ID: it resets every abandoned run in the registry,
not only this one. Read the `/exec doctor` output first and accept the whole
list.

When `/exec doctor` classifies the run `live`, a session still holds its lease
and `--reconcile` will not touch it. Stop the run and keep the worktree:

```text
/exec cancel <full-run-id>
```

### `cannot check on the worker right now`

Either the provider could not be polled, or a worker was launched and plan-exec
never learned its name. Both mean the same thing: nothing can say whether that
worker is still writing, so a resume would risk a second writer. Repair the
provider; the controller resumes polling on its own. Then re-check:

```text
/exec status <full-run-id>
```

### Why no per-turn activity signal exists

The bridge spawns workflow-mode runs. pi-subagents anchors the `Activity:` age
of a workflow-mode run to its launch time, so the age grows without bound while
the worker is healthy, and the run never escalates to `needs_attention`.
plan-exec discards that value rather than render a false signal, which leaves
elapsed time against the stage's turn budget as the only bound. The limit is
upstream and temporary: `nicobailon/pi-subagents#920`.

## Abandoned after a Pi restart

A run is **abandoned** only when all three hold at once: it claims `running`,
`starting`, `skip_pending`, or `cancel_pending`; its lease is not live; and its
operation is provably gone, because its async directory is absent from disk or
the bridge answers `absent` for its operation ID. Anything less is `ambiguous`
and is never reset.

Reset every abandoned run at once:

```text
/exec doctor --reconcile
```

`--reconcile` never launches a worker. Per abandoned run it clears the active
operation, sets `failed` with the evidence as the reason, appends that reason to
the progress file, and leaves `taskAttempts` unchanged. A run that a live
session reclaimed between the scan and the write is skipped, not overwritten.

A reset run is then an ordinary recoverable failure:

```text
/exec resume <full-run-id>
```

A run that was `cancel_pending` before the reset still wants cancelling:

```text
/exec cancel <full-run-id>
```

An `ambiguous` run is never reset, because the evidence is incomplete. Gather
more:

```text
/exec status <full-run-id>
```

## Paused

Status classifies this `paused, waiting for you to continue it`. Use:

```text
/exec resume <full-run-id>
```

A paused terminal child remains controller-owned. Resume applies its result; do
not resume the child directly.

## Failed

Status classifies a recoverable failure `stopped, and you can continue it`.
Inspect the stage, error, and active-operation fields first.

- No active operation: `/exec resume <id>` retries the same stage in the same
  worktree. It automatically resets a no-progress implementation retry because
  the user explicitly requested resume. A run classified
  `a task is blocked by something outside this run` — billing, credentials,
  quota, network, or a manual step — asks for interactive confirmation, or
  takes `--retry-task` from a caller with no human. Implementation is
  sequential; it cannot be skipped.
- Preserved active operation: `/exec resume <id>` adopts or looks up that exact
  operation before retrying.
- Operation lookup is `pending`: wait, reload if needed, then run
  `/exec resume <full-run-id>` again.
- Operation lookup is `found`: the controller observes it; use
  `/exec status <full-run-id>`.
- Operation lookup is `unknown` or the provider is unreachable: repair the
  provider, then `/exec resume <full-run-id>`. Do not launch another child.
- Provider reports the operation absent after an unknown launch outcome:
  plan-exec refuses a blind replay because another writer cannot be ruled out.
  Prove the worker is gone with `/exec doctor`; a run it classifies `abandoned`
  is reset by `/exec doctor --reconcile`.

Budget exhaustion is a plan-run failure. Resume the plan run ID, not the child
ID shown in pi-subagents output. Recovery raises implementation and review
budgets where supported. A resume is idempotent for a healthy tracked child and
reconciles it instead of creating another writer.

## Model or provider failure

When status classifies `stopped because the model or provider could not be used`,
the Bridge child is terminal.
Plan-exec preserves its external run ID and terminal error and does not consume
an implementation task attempt. Recover the same run with one of:

```text
/exec resume <full-run-id>
/exec resume <full-run-id> --model current
/exec resume <full-run-id> --model <provider/model>
```

Normal resume uses the active authenticated Pi model. `current` uses that same
model explicitly. An explicit provider/model override applies only to the
replacement child; it does not pin later launches. Choose a model whose provider
is authenticated and does not have the reported incompatibility or quota failure.
Do not keep retrying the same failing model. After resume, run status again and
verify the failed external run ID was replaced only after its terminal state was
recorded.

`/exec` is a Pi UI command. If the current agent cannot invoke slash commands,
it must give the user the exact command instead of claiming recovery ran or
launching a child directly.

## Force-skip a blocked stage

While the waiver is pending, status classifies the run
`waiting for the stage you waived to stop`; wait it out with
`/exec status <full-run-id>`.

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

Status classifies this `waiting for the stop you asked for`.
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

Status classifies this
`someone else's session was holding this run, and it is gone`. Inspect the
selected run before takeover:

```text
/exec status <full-run-id>
/exec adopt <full-run-id>
/exec status <full-run-id>
```

Adopt is active: it claims and may immediately advance the run. Use it only for
an unfinished run owned by a stale or different session. If resume hands Pi into
the execution worktree, continue recovery in that forked session.

A lease whose pid is dead on this host is stale at once, so no 30-second wait is
needed. A lease recorded without a hostname — the shape of every record written
before this rule existed — is judged by its heartbeat alone; wait until 30
seconds have passed since its last beat before treating it as stale.

## Plan structure changed

Do not silently accept changed task structure. Status says
`the plan file changed shape since this run started` and explains whether the
first resume only records `paused`; if so,
review the plan and run the interactive resume a second time. This is deliberate
for legacy records and is safer than silently adopting a new task contract.

Choose one:

1. Restore the original headings, numbering, checkbox text, and checkbox count,
   then run `/exec resume <full-run-id>`.
2. Review the current plan, then run interactive `/exec resume <full-run-id>` to
   confirm adopting its new structure.

Headless recovery cannot approve a changed plan structure.

## Execution branch changed

Status classifies this `this run belongs to a branch you are not on`. If status
or resume reports `Execution directory is on <current>, expected <recorded>`,
inspect the current branch and worktree first. When the current
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
5. Run `/exec resume <full-run-id>`. When a stale session still holds the lease,
   run `/exec adopt <full-run-id>` first.

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

If both source and completed destination exist, ask the user which copy is
authoritative. Do not overwrite either. After the user names it, delete the
other copy, then run `/exec resume <full-run-id>`. If Git staging or commit
failed, fix the reported Git condition, then run `/exec resume <full-run-id>`.
Archive retry is idempotent when the completed move already committed.

## Run missing or registry corrupt

A record the registry cannot parse is dropped from `/exec runs` with a warning.
`/exec doctor` lists it under `unreadable run records` with its parse error.

There is no supported command that repairs arbitrary `run.json` content. Do not
hand-edit the registry to make the run appear resumable. Once no external
operation can still be alive, remove the entry:

```text
/exec cleanup <full-run-id> --apply
```

That deletes the registry entry only; the worktree, branch, progress file, and
async artifacts stay in place. Durable run lineage is lost, so report it.

To repair the record instead, and only with the extension source available: fix
the loader or migration with a regression test, install the repaired local
package with user approval, run `/reload`, then retry
`/exec status <full-run-id>`.

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

Status classifies every non-failed terminal run `finished` and names
`/exec cleanup` as its one command; nothing here is recoverable.

- `completed`: verify checkboxes, archived plan, tests, and clean/reviewed Git
  state. No resume is needed.
- `completed_with_findings`: terminal and not clean. Inspect progress and review
  findings. Report them; use a new scoped plan only with user approval.
- `cancelled`: terminal and not resumable. To continue later, create a new run
  only after confirming no live child and reviewing the preserved worktree.
- `failed`: terminal for automatic polling but eligible for explicit recovery
  with `/exec resume <full-run-id>`.

`/exec runs` hides a terminal run once it is a day old; `/exec runs --all` shows
it again. A terminal record becomes removable 7 days after its last update, and
`/exec cleanup --apply` deletes it. `failed` records are excluded until
`--include-failed` is passed, because `/exec resume` needs them.

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
