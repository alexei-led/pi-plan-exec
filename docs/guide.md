# pi-plan-exec Guide

<!-- markdownlint-disable MD013 -->

Use this guide to install `pi-plan-exec`, write an executable plan, run it, and
recover a run safely. See [Architecture](architecture.md) for implementation
contracts and component ownership.

## Requirements

- Pi in an **interactive** session. `/exec` asks whether to use a worktree.
- A Git repository with a non-detached `HEAD`.
- A plan file inside that repository.
- These independently installed Pi packages, at compatible versions. In
  particular, `@alexeiled/pi-subagents-bridge` must be `0.2.2` or later:
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
pi install npm:@alexeiled/pi-subagents-bridge@>=0.2.2
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
- Changing task structure during a run pauses the run for review. Restore the
  original structure, or use interactive `/exec resume` to explicitly adopt the
  current structure before continuing.

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
Git worktree. Prefer the worktree. On selection, Pi forks the current session
into the worktree; its tools, footer, and task projection then use the execution
branch. Worktrees live outside the source repository:

```text
~/.pi/plan-exec/worktrees/
```

No stage pushes or merges a branch.

## Commands

Use `/exec help` for the same list inside Pi. Run IDs are optional for normal
use: when one run matches the current repository or worktree, `/exec resume` and
`/exec stop` select it automatically. Force-skip is intentionally different: it
always requires a full run ID, reason, and interactive confirmation. If several
runs match, Pi opens a picker; headless mode asks for the full ID. Bare
`/exec status` never picks a run — it reports every run in the registry, so the
full ID is always in front of you.

```text
/exec [plan]            Start a run; bare /exec opens the plan picker
/exec status [run-id]   No run ID: every run grouped by what it needs, any missing package, and one next command per run. With a run ID: that run in detail
/exec resume [run-id] [--model current|provider/model]
                        Continue a stuck run: take the lease over from a dead session, reset a run whose worker is provably gone, retry a failure in the same stage and worktree
/exec stop [run-id]     Ask whether to pause the run (resumable) or cancel it (final, worktree preserved)
/exec cleanup [full-run-id] [--apply]
                        Preview retired runs older than 7 days; --apply deletes their registry entries only
/exec skip <full-run-id> --reason <text>
                        Stop the tracked child, waive a blocked review/finalize/stats stage, and continue
/exec help              Show this list
```

### Reading every run at once

`/exec status` with no run ID is the whole read. It lists every run in the
registry, groups the runs that claim work in flight by the evidence for that
claim — `abandoned`, `ambiguous`, or `live` — lists the settled ones under
`waiting for you` or `finished`, reports any missing prerequisite package with
its install command, and ends every row in exactly one next command.

Terminal runs drop out of that listing 24 hours after their last update. The
footer names how many are hidden and both escapes: `/exec status --all` shows
them, `/exec cleanup` removes them.

### Retiring run records

`/exec cleanup` previews and deletes nothing. `/exec cleanup --apply` deletes.
A run is removable only when it is terminal, no live lease holds it, and its
last update is more than 7 days old. `failed` runs are excluded by default,
because their registry entry is what `/exec resume` needs; add
`--include-failed` to consider them, or name one full run ID to act on exactly
that run. Naming a run ID also bypasses the retention window — you named it —
but still needs `--apply`, and a non-terminal or live-leased run is still
refused.

Removal deletes the registry entry only. The worktree, the branch, and the
`.ralphex/progress/` log are all left in place.

### Retired names and scripted flags

`/exec stop` and some `/exec resume` branches ask a question, which a headless
caller cannot answer. Every prompt has a non-interactive equivalent, and the
former subcommand names still dispatch. They are absent from `/exec help` on
purpose; `/skill:exec-plan` collects them for agents. `/exec runs` and
`/exec doctor` both mean `/exec status`, `/exec setup` still prints the install
commands that `/exec status` now reports inline, `/exec adopt` means
`/exec resume`, and `/exec pause` and
`/exec cancel` are `/exec stop` without the question. `/exec start` was deleted
outright: it was the same code path as bare `/exec`.

### Following a run in flight

Pi shows the execution-worktree path and branch with the current stage and active
worker while a run is polling. Stage transitions, observation degradation, and
terminal states generate notifications. `/exec status <full-run-id>` shows the
last successful observation and retry count, then names the run's situation in
plain words and one safe next action.

### What status can prove about a worker

A stored `running` status is a claim, not evidence, so status never renders the
absence of a signal as health. Four in-flight situations read four different
ways:

- `running, and the worker reported activity` — the provider reported per-turn
  activity. Wait for it.
- `running, but nothing proves the worker is alive` — nothing reports what the
  worker is doing, so it is neither confirmed alive nor confirmed dead. Re-check
  later; do not start a second run.
- `running longer than its budget allows` — the bridge still reports the worker
  running past a wall-clock bound derived from that stage's own turn budget
  (75 turns for an implementation worker, 30 for a reviewer or the statistics
  pass) times a per-turn allowance of 2 minutes. The allowance is a deliberately
  generous placeholder pending measurement across real runs. It is a prompt to
  look, never proof of a stall.
- `the worker's files are gone, so nothing is running` — the directory the worker
  was writing to no longer exists. `/exec resume` clears the dead worker and
  continues without starting a second one.

A run spawned in workflow mode reports no trustworthy per-turn activity, so
elapsed time is the only bound available for it. That limit is upstream and
temporary: `nicobailon/pi-subagents#920`.

A lease is live only when the calling session owns it, or its heartbeat is fresh
and — on this host, where the pid means something — that process still exists. A
lease whose pid is dead on this host is stale at once, so `/exec resume` takes
the run over with no wait. A lease recorded before the hostname field existed is
judged by its 30-second heartbeat window alone.

### Recovering a failure

After repeated provider-observation failures, plan-exec records the failure
without discarding the external operation ID. A failed run preserves its
worktree and remains visible in `/exec status` and the projected task
description. `/exec resume` reconciles that known operation before retrying the
stage; it does not create a duplicate worker. If the provider has no record of an
operation whose launch outcome is unknown, plan-exec stops rather than guessing
and creating a duplicate worker. Legacy runs stopped by a plan structure mismatch
can be resumed interactively after confirming the current structure. The first
resume may only transition a legacy mismatch to `paused`; status explains that a
second interactive resume is required after review. An explicit `/exec resume`
retries a no-progress implementation task in the preserved worktree. Only a run
reading `a task is blocked by something outside this run` asks for confirmation
before retrying; implementation still cannot be skipped.

A run reading `stopped because the model or provider could not be used` is
recorded separately from task progress. The controller keeps the failed child ID
and terminal error, does not consume an implementation retry, and retries with
the current authenticated Pi model. `--model current` or
`--model provider/model` is an advanced override for that one replacement child;
it never pins later workers in the run.

`/exec skip` is a last-resort waiver, not a pass. It is available only while a
review, finalization, or statistics stage is failed, paused, or already
skip-pending. If a Bridge/Fusion operation is tracked, the controller requests
stop and remains `skip_pending` until the provider proves that operation is
terminal. The skipped stage remains visible in status and projected tasks, its
known findings remain unresolved, and final completion is
`completed_with_findings`. Implementation and archive stages cannot be skipped.

If the execution directory was moved to another named branch outside plan-exec,
the normal branch guard stops the run. An interactive `/exec resume <full-run-id>`
asks before rebinding: it requires no active child, verifies that the worktree
still belongs to the same Git repository, records the old and new branch in the
durable run, and then resumes the same stage. Review that branch before
answering. A caller with no human passes `--adopt-current-branch` to answer the
same question in advance.

## Watching and recovering a long run

The controller polls an active worker or review operation every second. It does
not impose a wall-clock limit of its own, and it has been exercised in runs
lasting a few hours. You do not need to keep reissuing `/exec` while it works.
Use this sequence instead:

1. Run `/exec status` to see every run, what each one needs, and one next command
   per run. Add a full run ID for the stage, active operation, worktree, branch,
   progress path, and any error of that one run. It only observes.
2. Run `/exec stop` when you want the run to end and pick pause or cancel at the
   prompt. Run `/exec resume` when you are ready to continue a paused run.
3. Use the full run ID from `/exec status` with another command when more than
   one run matches the repository and Pi cannot choose unambiguously.
4. After a Pi restart or a session handoff, run `/exec status` first. A matching
   run owned by the returning session reattaches automatically; `/exec resume`
   takes over an unfinished run whose owning session is proven dead, and resets a
   run whose worker is provably gone before continuing it.
5. For a run reading `stopped because the model or provider could not be used`,
   run `/exec resume`. It uses the current authenticated Pi model. Use
   `--model current|provider/model` only to override that one replacement child.
   Do not retry the reported failing model repeatedly.
6. If repeated recovery cannot finish a skippable stage, inspect the known
   findings and active operation, then use
   `/exec skip <full-run-id> --reason <text>`. Do not use it to hide
   unimplemented plan work.
7. When a run is over, `/exec cleanup` previews the records that can be retired
   and `/exec cleanup --apply` deletes them.

Do not start the same plan again after an interruption. Inspect the existing run
first. If the selected run uses a different worktree, `/exec resume` hands the Pi
session into that worktree before it continues, so subsequent tools use the
correct branch.

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
survive configured review caps, or any stage is force-skipped, the result is
`completed_with_findings`. The controller does not claim that reviews passed.

## Recovery and safety

Authoritative records live at:

```text
~/.pi/plan-exec/runs/<run-id>/run.json
```

They store stage, attempts, active Bridge/Fusion operation, worktree, branch,
findings, force-skip audit records, and lease. Durable operation IDs let the controller replay an
ambiguous or interrupted start without intentionally launching a second writer.
Registry compare-and-set updates and controller locks keep stale reload instances
from overwriting cancellation, pause, or operation state.

Pi-tasks is a session-scoped UI projection. On adoption, the projection is
rebuilt from the global record and plan.

Pause, cancellation, failure, and completion preserve the worktree for review.
Cancellation retries transient provider failures without dropping the active
operation record. Use `/exec status <run-id>` before manually changing it.

A record is retired, not accumulated: archiving stamps the run, terminal runs
leave the default listing a day later, and `/exec cleanup --apply` deletes the
record itself after 7 days. Nothing in that lifecycle touches the worktree, the
branch, or the progress log — deleting a record only gives up the ability to
`/exec resume` or inspect that run.

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
