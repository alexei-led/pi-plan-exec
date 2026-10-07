# Stuck Run Recovery

Continue the same durable run and preserve its checkout. **Resume the plan run ID, not the child ID.** Never launch a second writer because a worker is quiet,
a directory disappeared, a lookup is empty, or a stop request was delivered.

## Establish evidence

```text
/exec status
/exec status <full-run-id>
```

These are read-only views of registry ownership and supported native evidence.
Capture the full run ID, stage/status, worktree/branch, operation ID/digest,
native root/child IDs, progress path, current session/host and exact error.
If unreadable, inspect `~/.pi/plan-exec/runs/<id>/run.json` read-only and use
`git status --short --branch` in the reported checkout. Do not edit records or
reset source to make recovery appear successful.

The default backend is unmodified pi-subagents 0.76.1. There is no Bridge
extension or task-store prerequisite. Native request UUID and structured
workflow inventory, not text summaries, bind a lost launch. Correlated events
may retain identity; actual published retirement still gates acceptance.

## Interpret status without inventing authority

- A live controller/lease means wait and observe unless the user chooses stop.
- Activity is advisory. A snapshot is not current liveness, and silence is not
  death. An unpolled view cannot restart a child by being displayed.
- A prepared native request has not been emitted. Dispatching/unknown requests
  cannot be replayed. Restore the original session and supported correlation.
- A terminal wrapper is not sufficient proof. Actual async children need their
  exact nonempty child proof. A no-child failed workflow cannot finish a task.
- Missing/expired identity or proof stays fenced. Repeating resume cannot create
  evidence; do not guess an ID from time, prompt text, paths or a dead PID.

An exact successful sole child can be recovered from a
`settled-awaiting-resume` receipt after the wrapper loses its JavaScript
continuation. It still needs matching root/request/child identity, proof and
bound output. Do not start another worker/reviewer merely because that wrapper
failed; arbitrary failed output is not success.

## Pause, cancel and permanent force-stop

```text
/exec pause <full-run-id>
/exec stop <full-run-id>
/exec stop <full-run-id> --force
```

Pause preserves the checkpoint and is resumable. Ordinary stop is final
cancellation without a dialog (`cancel` remains an alias). Both preserve newer
stop generations over stale callbacks and refuse a live foreign controller.
Do not use resume merely to erase an intentional pause.

Stop intent, delivery and retirement are different facts. A delivered receipt
cannot clear ownership. Public native stop can refuse queued, paused or reloaded
workflows; keep the same operation and report the pending reason. Observation
and permitted delivery retry, not another launch.

Force-stop backs up and durably marks `abandoned` before best-effort control.
It ends management, not necessarily the worker. It cannot be resumed, polled
back into life or restored by UI/reload. Unknown work, failed identities and
quarantined checkouts stay reserved. Only exact retirement and controller-lock
quiescence permit final fsynced registry cleanup. Worktrees, branches and native
provider artifacts are not deleted by this command. Repeated explicit force-stop
may retry cleanup; there is no automatic abandonment cleanup loop.

On 0.76.1 an early stop can report `writer-close-unverified` despite a runner
close. Treat that as unknown. Do not kill guessed descendants, fabricate a
terminal flag, delete the reservation or reset its checkout. Preserve the record
and report the native limitation to the operator.

## Resume and native session authority

```text
/exec resume <full-run-id>
/goal resume <full-run-id>
```

Normal resume uses registry leases/CAS, the same stage, worktree and identity.
A plan lease takeover is not native session adoption. Native controls require
the recorded session file identity (or session UUID for an unpersisted session).
A different session may observe supported evidence but cannot impersonate the
original owner. Restore that session for control, or leave ownership fenced.

A foreign-host lease is not a renamed local host by assumption. Where applicable:

```text
/exec resume <full-run-id> --same-machine
```

This is an explicit machine assertion, not proof the worker exited. Live foreign
leases and unresolved ownership still win. Recover on the original machine when
that is what the lease names. Do not change hostnames or native session IDs in
records to bypass the gate.

## Advanced read-only legacy snapshot import

Existing historical native IDs need no journal. For an unbound legacy operation:

```text
/exec resume <full-run-id> --legacy-journal /absolute/path/to/offline.sqlite
/goal resume <full-run-id> --legacy-journal "/absolute/path/offline snapshot.sqlite"
```

The file must be a **consistent offline schema-7 SQLite snapshot**. Prefer a
closed/checkpointed database; a WAL snapshot must include the consistent WAL.
Never copy only the main file of a live WAL database. The extension does not
find/open a default live journal, construct its old service, migrate, reset,
copy or delete it. SQLite read-only mode is not a guarantee that arbitrary live
WAL/SHM sidecars are untouched; supply offline evidence.

Import checks the original run, operation and request digest. It preserves the
original params/digest and records only validated binding, correlation,
rejection/cancellation evidence under fresh CAS. Newer cancellation, generation,
foreign lease and abandonment win. A missing digest on an unbound record cannot
be invented. Missing, mismatched, corrupt, unsupported or busy snapshots leave
the original identity fenced.

Import is not a spawn, absence proof, retirement proof, replay permission or
transfer of native control. A retained stop receipt does not mean the writer
exited. Abandoned records cannot import or resume. Do not reinstate Bridge as a
fallback launcher.

## Independent checkout recovery

```text
/exec recover-isolated <full-run-id> /absolute/new-checkout
/exec recover-isolated <full-run-id> /absolute/new-checkout --apply
```

Preview first and obtain explicit local-files-only approval. Native dispatch is
fenced by the old registry generation before preparing the independent target.
The old checkout and exact operation remain quarantined/reserved; shared files,
hardlinks, symlinks, partial/ignored artifacts and foreign repository identity
must not be smuggled into the new lane. New HEAD, checks and approved plan facts
remain controller-owned. This is not proof the old worker stopped or permission
to disregard external side effects.

Read-only legacy import cannot revoke a historical dispatcher. Unresolved legacy
isolation refuses before target mutation; do not replace that refusal with a
journal write, a copied live database or a hidden backend.

## Task, review and prerequisite recovery

An incomplete committed task retains its lane. Independent ready tasks may use
a clean lane from the accepted baseline; dependencies cannot be waived by
checkbox edits. A worker `TASK_FAILED` diagnostic with observed
`Prerequisite: credentials|permission|missing_executable|runtime` and `Evidence:`
can enter waiting-external state. Repair that exact prerequisite; do not infer
credentials from generic error text. Required review and frozen checks remain
required after failure.

Native review uses a readonly namespaced role and a typed report bound to the
exact full commit. Empty findings requires successful child evidence and Git
verification. Missing/malformed/wrong-commit reports never pass. Do not switch a
configured agent, model or backend implicitly. If an explicit model retry is
needed, use the existing `--model current|provider/model` resume option and keep
the recorded original operation unchanged until it retires.

Requested native turn limits are not enforced by 0.76.1. Unbounded workflow mode
does not remove native child defaults; bounded mode passes the requested timeout
to root and child. Time, silence and ordinary tool-timeout prose do not authorize
a replacement. Local checks/bootstrap remain user-stoppable owned processes.

## Plan, branch, archive and cleanup

If plan structure changed, inspect the diff and restore the approved structure
or use interactive resume to confirm adoption. Only checkbox completion is the
normal worker edit. Do not accept unrelated heading/dependency changes as proof.
If the branch changed, inspect it and use explicit interactive
`--adopt-current-branch` only without a tracked external operation. Never reset
branches or discard user changes to pass a check.

Optional stage skip requires an explicit reason and confirmation; it cannot
waive mandatory review/checks, and its tracked worker must retire before the
stage advances. A cancelled or abandoned run is not a resume target. Completed
runs need no new worker. Failed/unknown identities are not cleanup candidates.

For archive failures, preserve the current commit and staged user content. The
controller's owned Git operation must reconcile before another archive mutation.
Inspect failures rather than manually committing arbitrary staged files. Cleanup
previews are read-only; actual removal requires retired ownership, retention and
lock quiescence. Hiding a widget does not hide/delete a run or change a lease.

If a record is missing/corrupt, report its exact path and error and preserve the
checkout. Do not reconstruct authority from prose, create a replacement run in
the same reserved target or manufacture process proof.

## Verify the outcome

Read status again. Confirm the same run/operation identity, intended stage,
stop intent, worktree, candidate and checks. Progress needs an applied registry
transition; a reassuring model response or stale widget is not evidence.
If safety cannot be proved, report the concrete missing identity/proof, preserved
reservation and operator action needed. Never claim recovery from silence.
