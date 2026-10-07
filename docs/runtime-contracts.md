# Runtime contracts

## Released baseline and ownership

The default backend uses **unmodified pi-subagents 0.76.1** and Pi 1.0.4
(`^1.0.4`). It does not require an upstream patch, Bridge, pi-tasks, or cc-thingz.
Install pi-subagents and this package as independent Pi packages. Restart Pi
after package upgrades; `/reload` is for local source/config changes.

Status/doctor use a read-only native inspection seam: it shares exact identity and
proof validation but never binds, persists, claims, dispatches or controls a run.
Later reconciliation revalidates the scanned operation/generation under CAS; stale
prepared evidence cannot fence a concurrently claimed dispatch.

The controller owns task/goal policy, Git acceptance, frozen checks and review.
`RunRegistry` is the only operation ledger for new work. Fleet and the progress
view are advisory; `run.tasks` supplies task summaries. Old task-projection
session attribution is recognized read-only, not rebuilt into another store.

## One native launch protocol

Each operation is one public async `subagents:rpc:v1` script awaiting
`runs.run("main", {...})`. Do not set child `async:true`: that returns a receipt
instead of the awaited result. The released runtime normally executes this
awaited child in a detached process. Actual `steps[].async`, not omitted input
or a mock, determines the required retirement proof.

Before dispatch the controller persists:

- operation ID, kind, task/review iteration and reviewed commit;
- controller session UUID, native session identity (`getSessionFile() ??
  getSessionId()`), execution/stop generations and immutable request digest;
- a distinct native RPC UUID and exact request;
- unique absolute run-owned output binding and requested limits.

The requested cwd must canonically equal the authoritative `run.worktreeCwd`,
including a selected nested/task lane. Dispatch rechecks the current registry
target and authority; an arbitrary absolute override is not permission.

Phases are `prepared -> dispatching -> bound -> retired`. CAS claims dispatch
before emit. An intact prepared record proves no request was emitted; a
`dispatching`/unknown operation is **never replayed**. Native readiness failure
before preparation is an explicit retryable prerequisite, not a consumed child
attempt. A lost reply is recovered using `status` with exact
`rpc-spawn-<persisted-uuid>` correlation and validated `workflowChildren`.
Correlated completion events may retain the binding before temporary indexes
expire; they are not retirement or acceptance proof. No prompt/path/time guesses
or scans of unrelated native runs are used. Missing/expired correlation stays
fenced, even across repeated resume.

### Application admission before dispatch

A still-`prepared` operation is validated through the public
`pi-subagents/preflight` `resolveSubagentLaunchContract` API before its dispatch
CAS or spawn emission. Validation uses the exact saved fresh-child literal
(agent/task/model/cwd/output/schema), current available and scoped models,
parent model/session, native capability ceiling and the real Pi host for built-in
MCP snapshots. Public imports are lazy: a missing optional peer does not prevent
extension startup and retains the existing bounded runtime prerequisite behavior.
Missing selected skills, missing configured agents and denied required tools
refuse with an actionable diagnostic and zero native dispatch. Fix the selected
configuration and resume; the prepared request is not rewritten. Upstream 0.76.1
execution alone treats missing selected skills as warnings; plan-exec now gates
that case itself with the public validator.

Validation is not dispatch, authoritative non-start, retirement or acceptance
proof. It creates no separate store. Session/ownership and cancellation checks
are repeated after the await, the original revision gates dispatch CAS, and
already-dispatched/unknown operations never re-enter admission or replay.

**Narrow 0.76.1 runtime-role exception:** public preflight discovers configured
agent files, not runtime registrations, even with `runtimeSnapshotHost`. Our
fixed `plan-exec-reviewer` reviewer/stats role explicitly declares `skills: []`,
`inheritSkills: false`, readonly tools and no model override. Only that exact
role, with this extension's successful undisposed registration on the current
event bus, may proceed past the validator's plain unknown-agent discovery result.
Registration liveness is rechecked after admission and immediately before emit.
Unavailable/disposed registration and configured collisions refuse; a name match
alone is insufficient. Invalid configuration, missing skills, denied tools,
model/scope errors and other returned failures are never exempted. This is not a
claim that preflight validated the invisible runtime definition: actual native
execution retains model/tool/schema/collision enforcement. No agent files,
private imports, arbitrary runtime-agent allowlist or user bypass are introduced.

Native session authority is not transferred by a plan-exec lease takeover.
Another session can inspect supported evidence but cannot impersonate the
original native session to stop/resume a child.

## Retirement, stop and abandonment

Published workflow proof must bind the exact root and complete closed child
inventory. An actual async `main` requires its one exact nonempty child process
proof. A recorded synchronous child uses the runtime's corresponding published
workflow proof; an empty roster alone proves nothing. A no-child failed workflow
may retire dispatch, but cannot complete a task or pass review.

Observe retirement before stop. Stop delivery, stopped/paused wrapper text,
a missing directory, elapsed time and a dead PID are not retirement proof.
Queued/paused/reloaded workflows can refuse public stop; intent and delivery
errors remain recorded and observation/delivery can retry against the same ID.

`/exec stop <id>` requests final cancellation; `/exec pause <id>` is resumable.
`/exec stop <id> --force` durably backs up and abandons the run **before**
best-effort native control. Abandonment ends management, not necessarily worker
ownership. Ordinary writes, automatic recovery and UI restoration cannot revive
it. Only the registry's narrow exact-retirement path can release its reservation.
Controller/record lock ordering, final fsynced archive and quiescence precede
cleanup; worktrees and provider storage are not deleted by management cleanup.

An early native stop can publish `writer-close-unverified` even when a runner
close is recorded. This is a safe limitation of 0.76.1, not an excuse to infer
exit. The run remains abandoned and its target reserved. The packed consumer
smoke verifies no restart takeover and retains its isolated evidence in this
case rather than deleting unknown ownership.

## Output and required review

New output comes only from the unique caller-bound path and exact native
root/child/key/request identity. The controller copies validated output and
proof to `native/<request-uuid>/controller-result.json` under the owning run,
with an authorized record-lock check before writing/accepting it. Missing,
symlinked, oversized or contradictory artifacts never mean success. Bound
failure text may carry worker/goal blocker diagnostics; it cannot turn a failed
child into a successful task, goal or review.

The default reviewer and optional statistics role is `plan-exec-reviewer`,
registered through public runtime-agent events on session start and disposed on
shutdown. It has only `read`, `grep`, `find` and `ls`; no model is pinned. Explicit
frozen agent/model choices retain their meaning and are never silently replaced.

Required native review submits `structured_output` with:

```json
{"schemaVersion":1,"reviewedCommit":"<exact full commit>","findings":[]}
```

Findings require uppercase `CRITICAL|MAJOR|MINOR`, summary, concrete evidence and
suggestion. There is no redundant verdict. Empty findings is clean only after
runtime success/retirement and independent Git/candidate verification. Unknown
fields, malformed/missing reports and wrong commits fail closed.

**Released output settlement:** worker/marker operations retain `file-only`
output. Requests with `outputSchema` keep the exact absolute `output` path but
omit `outputMode`, using supported default inline settlement. On 0.76.1 a real
read-only `structured_output`-only turn with `file-only` can fail its required-file
guard before persistence. Default inline settlement persists the schema value at
the bound path without granting write tools or changing launch backend. The
normal-loader tarball smoke covers clean/findings reports and refusal of
malformed, missing and wrong-commit reports.

The specific `settled-awaiting-resume` case is supported: a sole successful child
settled after supervisor detachment, but the JavaScript wrapper stopped before
returning its value. Recovery requires its exact receipt, complete child
identity, retirement proof and bound output. It does not restart that worker or
reviewer merely because the wrapper failed. Arbitrary failed-workflow prose is
not a fallback result; missing settlement evidence stays fenced.

## Honest limits

`executionLifetime` is a frozen **request**: `{ "mode": "unbounded" }` or
`{ "mode": "bounded", "timeoutMs": <positive integer> }`. Bounded timeout is
passed to both workflow and child. Unbounded omits the workflow deadline; it
does not remove native child defaults. Requested and observed limits are stored
separately. Legacy `workerMaxTurns`, `reviewerMaxTurns` and `statsMaxTurns` remain
recorded requested settings, but native RPC 0.76.1 does not enforce them
(`maxTurnsEnforced:false`). Goal `maxTaskIterations` is a separate controller
iteration budget, not a native child turn guarantee.

Only explicit structured bounded-expiry evidence plus retirement and useful
progress can grow a later bounded request. Tool timeout prose, silence and
advisory activity cannot do so. No wall-clock or PID heuristic authorizes a new
writer. Native proofs do not invent containment of arbitrary escaped descendants.

Local bootstrap, checks and Git mutations keep plan-exec's owned POSIX
process-group runner, unbounded user-stoppable lifetime, exact local binding,
start identity, generation fencing and durable writer-exit proof. Escaped
process-group descendants remain a documented best-effort limitation. Native
workflow lifetime does not impose a timer on those local commands.

## Explicit legacy snapshot import

Existing Bridge records are data, never a live fallback. Already-recorded exact
native IDs can be observed without a journal. For an unbound legacy operation:

```text
/exec resume <full-run-id> --legacy-journal /absolute/path/to/offline.sqlite
/goal resume <full-run-id> --legacy-journal "/absolute/path/with spaces/offline.sqlite"
```

Supply a **consistent offline schema-7 snapshot**, preferably a closed,
checkpointed database, or a consistent SQLite snapshot including its WAL. Do
not copy only the main file of a live WAL database. No journal is discovered,
created, migrated, copied or reset by this extension; it never opens a default
live journal. SQLite is opened lazily read-only with bounded row size/lock wait;
SQLite can manage WAL/SHM sidecars, so this is not a filesystem-wide immutability
claim for arbitrary live databases.

Import requires the original plan run ID, operation ID and request digest.
Fresh CAS preserves newer stop/generation/lease changes and refuses abandoned
runs. It retains validated binding, RPC correlation, rejection and cancellation
evidence without rewriting the original params/digest. Mapping is not retirement,
non-start or replay authority. Missing, mismatched, corrupt, busy or unsupported
snapshots preserve the original identity and fence work. Stop still requires the
exact original native session; delivery receipts never release ownership.

Native isolated recovery can fence its old generation locally and retain the
quarantined checkout. An unresolved legacy dispatcher cannot be fenced by this
read-only importer, so isolated recovery refuses before mutating its target.

## Explicit alternative review backends

Fusion and Revmux remain explicit choices with empty default fallback lists.
They must attest their existing lifetime, durable lookup and owned-process
proof contracts. Fusion 0.9.3 does not satisfy this strict controller contract;
Revmux requires the documented lifecycle adapter. Neither is silently replaced
with native review when selected. An unknown start never permits fallback over
an uncertain writer. Source-named backend tests retain capability refusals.

## Verification boundaries

- `npm test`: domain, registry/CAS, native transport/proof/result, legacy SQLite
  import, UI and command tests; both Vitest and node:test run.
- `npm run test:runtime-smoke`: real released detached workers with deterministic
  scripted sessions, required review/fix/checks and captured evidence.
- `npm run test:native-recovery`: new OS hosts, exact workflow correlation and
  nonempty child proof; direct-leaf missing correlation remains a negative case.
- `npm run test:packed-consumer`: actual tarball in an isolated install with only
  Pi, native subagents and this package; normal ambient loading, localhost model,
  default readonly reviewer, plan/goal, lost reply, rejection, stop/restart and no
  child command registration or lease takeover. Neither removed package resolves.
- `npm run pack:dry`: runtime-only tarball and host peer declarations.

These checks do not claim live-model reliability or repair an unavailable native
identity/proof. The executable plan and independent review own final acceptance.


## Confirmed provider failure and one-attempt model recovery

A native implementation failure with exact retirement and a retained provider/
model diagnostic (including actual 401 or model-not-found errors) holds that task
as a provider prerequisite. The ordinary retry timer or credential presence is
not evidence that a known-bad model/authentication now works. Independent ready
tasks remain eligible; goals keep their existing explicit-pause policy.

`/exec resume <id> --model current|provider/model` may recover the current eligible
retired failed task/goal even when the overall plan is still running. Healthy,
in-flight, unknown, contradictory/stale-generation and abandoned work cannot be
redirected. Authority is rechecked under existing controller locks/CAS; explicit
stop races win. Frozen config and old request/digest are not rewritten.

`TaskExecution.providerFailure` holds at most one proven-retired native provider
failure for that task, in the existing registry record. Existing identity/digest/
workflow-proof validation applies; a state label or error string alone is not
proof. A new provider failure replaces that task's snapshot; recording a new
authorized attempt atomically clears it and consumes the one-attempt override.
Held-task evidence survives independent task failures; the latest global
failedOperation is only a selection hint, never another task's authority. Legacy
records without this optional evidence remain readable and acquire no invented
proof. A latest contradictory same-operation record refuses recovery.

With multiple held failures, explicit recovery selects the eligible latest task
first, then another retained eligible task after it settles (the two-task probe
recovers B then A). The selected model cannot affect another task, required review,
stats or subsequent attempts. Missing or stale proof remains safely fenced.
