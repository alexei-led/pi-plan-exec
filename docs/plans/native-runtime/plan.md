# Native runtime integration and minimal safety kernel

## Overview

Replace pi-plan-exec's pi-tasks projection and separately installed
pi-subagents-bridge with direct public pi-subagents integration and a small
internal safety kernel. Preserve the controller's useful behavior and recovery
guarantees; remove protocol translation, not ownership evidence.

This is one executable plan, with five sequential, independently verifiable
iterations. Each task owns one integration boundary and ends at a commit-sized
checkpoint; its work items may use smaller commits. Do not advance past a failed
gate. Do not execute this plan merely because it exists.

**Status:** proposed implementation, approved direction. No implementation or
upstream fix is claimed by this document. Package versions below are the
investigated baseline, not promises about later releases.

**Scope:** native execution transport, durable operation safety, legacy recovery,
result contracts, projection/dependency removal, and regression verification.
Keep the existing plan parser, scheduler, Git acceptance rules, owned local
command runner, user commands, and explicitly selected review backends.

## Source artifact

The operator approved the preceding integration analysis and requested a single
executable plan in an isolated worktree. This document records that design and
its evidence so execution does not depend on chat history.

Baseline: pi-plan-exec `757b6a3` / 1.7.1; Bridge `0875ed2` / 0.5.5;
pi-subagents 0.76.1; Pi 1.0.4; pi-tasks 0.9.0. The two upstream documentation
files fetched for the analysis matched the installed 0.76.1 files byte-for-byte.
Recheck exact installed versions at execution time.

| ID | Observed evidence | Implication |
| --- | --- | --- |
| E1 | [Native Extension API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md): async RPC accepts direct agent/task, scripts and named resources; structured delegation is foreground-only | Use async RPC for durable children, not a foreground replacement |
| E2 | [Workflows](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md): reuse requires matching session/script/args and runtime-replaced stop | Workflow reuse is not an idempotent launch ledger |
| E3 | Bridge `src/workflow-spawn.ts:1`, `src/plan-exec-rpc.ts:360–485` wrap every leaf in `runs.run("main", ...)` | Direct native leaves can remove a layer after contract tests |
| E4 | Bridge `src/plan-exec-rpc.ts:1140–1230`, `src/operation-journal.ts:228` persist identity before dispatch and refuse ambiguous replay | Preserve identity, fencing and cancellation; do not copy its general-purpose RPC service |
| E5 | [task-projection.ts](../../../src/task-projection.ts), [index.ts](../../../src/index.ts) projection queue; [upstream audit](../../upstream-audit.md) | pi-tasks is optional derived state with an internal file-store dependency |
| E6 | [runtime-integration.ts](../../../src/runtime-integration.ts) imports public external-runs/background-work APIs | Keep these independent of pi-tasks |
| E7 | [controller.ts](../../../src/controller.ts) launchBridge/observeBridge/verifyCandidate; [registry.ts](../../../src/registry.ts) CAS, locks, leases and reservations | Keep one controller and one authoritative run record |
| E8 | [runtime contracts](../../runtime-contracts.md), native `src/extension/rpc.js:441–548` | Same-session stop authority and paused/queued RPC stop limitations must not be hidden |
| E9 | Native `src/workflows/workflow-reuse.js:30` allows redispatch after lost child journal entry; `src/runs/background/process-terminal.js:133` requires observed retirement | Missing history, dead PID or a completed wrapper is not retirement proof |
| E10 | [artifact.ts](../../../src/artifact.ts), [review.ts](../../../src/review.ts) | Replace new-run output heuristics and text findings with explicit validated result contracts |
| E11 | [DEVELOPMENT.md](../../../DEVELOPMENT.md), [smoke fixture](../../../test/autonomous-runtime-smoke.mjs) | Preserve both test runners and real detached-runner evidence |
| E12 | Native [observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md) | Completion replay/output archives are temporary; copy accepted evidence into the run record's storage |
| E13 | Release 1.7.1 / `d1893f5`: controller transition CAS; registry retirement anchor; recoveryGuidance/progressView and their controller/index/registry/run-view tests | Preserve accurate pause intent, snapshot/activity labels, retention age and applied-transition-only logging while removing projection |

Use the published version's docs/declarations and real-host tests as authority
for API fields. Internal upstream source is diagnostic evidence, not permission
to import private modules into production.

## Success criteria

- Fresh packed-consumer execution loads only Pi, pi-subagents and pi-plan-exec
  for the default backend. Neither removed package is installed or discovered.
- No pi-tasks or Bridge runtime imports, RPC channels, install instructions or
  required peer/dev dependencies remain in the normal execution path.
- One writer remains reserved per execution target, including alternate lanes,
  prepared targets, failed runs and quarantined generations.
- A lost reply/reload cannot cause another launch for an uncertain operation.
  A safe continuation is a new attempt only after predecessor retirement or
  authoritative non-start evidence.
- Recoverable observations, unavailable extensions and missing external
  prerequisites retry with bounded backoff. Explicit user pause/cancellation
  never authorize new work; same-operation stop delivery can still retry.
- Both `/exec` and `/goal`, native review/fix/stats, local checks, worktree
  handoff, status, cleanup and legacy recovery satisfy the matrix below.
- Routine single-agent execution has no artificial workflow root.
- Defaults remain one required reviewer, no implicit backend fallback, no
  optional statistics child, and no extra mission/scheduler.
- Preserve 1.7.1's applied-transition-only progress logging and terminal cleanup
  age across migration, result capture, lease release and advisory writes.
- Every advertised recovery guarantee is demonstrated by an executable test;
  nonrecoverable uncertainty is reported as such, not disguised as self-healing.

## Target design and decisions

### D1 — Keep one durable controller

`PlanExecController` owns task eligibility, accepted/reviewed commits, attempts,
retry policy and final acceptance. `RunRegistry` owns persistence, leases, CAS
and checkout reservations. The native runtime owns child execution and its
process proofs. Fleet/UI/background-work are projections only.

Preserve 1.7.1's transition CAS discipline: append a stage-transition message
only after its matching state write succeeds. A stale snapshot can return the
newer record but cannot log progress it did not commit. Removing TaskProjector
does not remove this concurrency invariant.

Do not add a generic workflow engine, provider plugin framework, daemon,
message broker, retry DSL, or new database. Do not rewrite unrelated controller
logic or unify Fusion/Revmux just to fit the native adapter.

### D2 — Safety kernel is operation state, not another service

Keep native operation state in the existing durable run record. Introduce only
the typed fields and validation needed to distinguish prepared, dispatching,
bound and retired operations. The controller must persist preparation and
claim dispatch before calling the native transport.

Suggested code boundaries (names may change only for an existing equivalent):

| Module | Owned knowledge and public boundary | Must not own |
| --- | --- | --- |
| `src/native-runtime.ts` | RPC request/reply validation, capability probe, exact native correlation, status/proof normalization, output capture; small start/observe/stop interface | Plan state, retry decisions, accepted commits |
| `src/operation-safety.ts` | Pure identity, dispatch-state, cancellation and retirement predicates/transitions used by registry/controller | Timers, event subscriptions, filesystem launch, another run registry |
| `src/registry.ts` + `src/types.ts` | Authoritative operation fields, immutable bindings, CAS and admission | Native status text parsing |
| `src/controller.ts` | Domain decisions using normalized evidence | Private native APIs, independent launch paths |
| `src/legacy-operation.ts` | Read-only import/normalization of supported old Bridge records/results | Bridge dispatch, SQL migrations, new legacy launches |
| `src/artifact.ts` | Explicit new-run result decoding; separately named bounded legacy decoding | Filename guessing for new operations |
| `src/runtime-integration.ts` + `src/run-view.ts` | Observational projection and view state | Execution authority |

These are modules in one deployment, not independently deployable services.
Keep the high-strength relationship between operation transitions and registry
local. Put the volatile external DTO mapping behind one adapter. Do not invent
a large interface for hypothetical runtimes.

Use the existing `src/rpc.ts` transport helper, extended narrowly to accept a
caller-supplied, already-persisted request ID and validate response correlation.
A transport timeout is an unknown outcome, never a synthetic launch rejection.

### D3 — Exact launch protocol

Persist before dispatch:

- logical plan run ID, operation UUID, kind/task/review iteration;
- execution and stop generations, canonical execution cwd and branch/baseline;
- immutable native request fields and canonical digest;
- a native RPC request UUID distinct from operation UUID;
- originating Pi session UUID AND native runtime session identity
  (`getSessionFile() ?? getSessionId()`), plus the existing host ownership;
- requested lifetime and separately observed/effective native lifetime;
- review candidate commit, output schema version and output location, when used.

Do not equate caller digest, native launch-contract digest, session UUID,
transcript path, native run ID or runner process-instance ID.

The internal start method accepts the recorded run/operation identity, not an
arbitrary prompt supplied by another extension. It must re-read and verify
current authority before dispatch. Missing run, stale operation, changed digest,
old generation or retired operation means no launch. This removes the need for
Bridge's public idempotency service and infinite tombstones: an old request
cannot recreate a deleted run or an operation no longer current.

Use the existing controller lock and record lock order. Never hold the record
lock while waiting for native RPC. A reply arriving after stop/reload is merged
against fresh state; it may bind the already-started child but cannot erase
stop intent, advance a stage or accept a candidate.

| Stored phase | Allowed work | Recovery |
| --- | --- | --- |
| prepared | Claim dispatch once after checking authorization; or cancel locally | An intact prepared record is proof no transport call occurred |
| dispatching | Bind a correlated receipt/event/artifact; request stop once bound | If dispatch outcome is unknown, observe only; never emit spawn again |
| bound | Observe exact native run; retry stop delivery when requested | Reattach the same run without changing its launch contract |
| retired | Consume captured result or schedule a fresh authorized attempt | No control signal or launch under this operation ID |

Retirement requires one of: exact native process-terminal proof; a validated
workflow terminal proof for imported legacy roots; local pre-dispatch fencing
of a prepared operation; or a precisely correlated upstream pre-dispatch
rejection whose non-start semantics were contract-tested. Generic
`execution_failed`, `invalid_state`, timeout, missing directory, EOF and
unmatched error text never qualify.

`dispatching` persisted before emit has an unavoidable crash window. If no
supported native evidence resolves it, it remains fenced. Do not weaken this
rule to make a restart test pass.

Keep stop intent as monotonic data separate from phase. A delivered stop
receipt is not retirement. Record native delivery identity, original error and
next delivery attempt separately from observation errors.

### D4 — Recovery policy stays small and evidence-driven

A single serialized tick reads durable state, obtains evidence, then does one
of: observe, deliver pending stop, accept a retired result, schedule an authorized
next attempt, or report a prerequisite/uncertain ownership. Native completion and
readiness events only wake that loop; persisted state/status remain authoritative.

Reuse current retry timing where adequate. Avoid a second recovery timer family.
Persist the next eligible wake, cap backoff, coalesce duplicate wakes and dispose
subscriptions/timers on session replacement. Wake immediately on relevant ready
or completion evidence, then re-read current state. Do not tight-loop on a bad
model or unavailable package.

Safe automatic repairs: reattach exact known run, consume a captured result,
retry read/status or same-operation stop delivery, rebuild Fleet, retry a
documented prerequisite probe, and continue domain work after proven retirement.

Unsafe automatic repairs: guessing a run from prompt/path/time, replaying an
unknown spawn, silently changing model/backend/worktree, resetting a branch,
releasing a foreign-host reservation, force-installing packages, or modifying
upstream/global configuration.

Preserve 1.7.1's distinction between an observed operation pause, an actual
supervisor request and an explicit user pause. A native paused state alone must
not produce a claim that a question is waiting. A live controller can keep
observing an attached paused operation. An explicit user pause takes precedence
over stale leases, renamed-host guidance, branch/plan errors and generic recovery
advice. Without a live controller, status observes pending pause cleanup but
cannot restart it. Recommend resume, including --same-machine, only when the
operator intends to continue, not as a way to repair a paused run's ownership.

Cross-session plan lease takeover does not grant native stop/resume authority.
If native controls require the original session, retain that identity and direct
the user to restore it. A new session may inspect supported evidence but cannot
forge ownership. When old parent death prevents a valid terminal proof, report
the actual limitation and preserve the existing explicit isolated-recovery path.

### D5 — Direct leaves by default; workflows only for real composition

Worker, fixer, default reviewer and optional stats are direct async RPC leaves.
Set fresh context, controller-owned cwd, `worktree: false`,
`mission: false`, and disable native acceptance only where the controller
provides the acceptance contract. Verify actual support for turn limits,
completion guard and every forwarded field; accepting an unknown schema field
does not prove enforcement.

Do not copy Bridge's capability advertisements. Native admission checks only
real advertised/tested capabilities. Preserve requested bounded/unbounded policy,
but do not claim end-to-end unbounded execution when the native leaf still has
a default deadline. Record the limit visibly. A confirmed timeout with retirement
can follow existing bounded continuation rules; silence cannot.

No new fanout, named resource or retained-resume dependency is required by this
migration. The current one-reviewer default needs no workflow. If an already
supported composite is found during characterization, preserve it through
public RPC `script`/named resource inputs, stable keys, awaited `runs.run` or
`runs.all`, and captured child references; do not enable it as a new feature.

For a later deliberate review fanout, one review round is a sensible workflow
boundary. Controller still fixes the candidate SHA and evaluates results.
Do not put the full plan/goal loop, Git acceptance or recovery inside JavaScript
workflow state. Do not set child `async: true` when awaiting a final result:
that explicitly returns only a launch receipt.

Do not replace owned local argv/environment command execution with
`runs.host`: current host steps require finite timeout, shell commands and
different authority/lifetime semantics. Do not replace task lanes with
`runs.lanes` or managed temporary worktrees.

### D6 — Results are typed, owned and durable

New native reviewers return schema-validated findings, not text interpreted as
approval. Minimal result: schema version, reviewed commit and an array of
severity/summary/evidence/suggestion entries. Empty findings means clean only
for a successfully completed, retired, correctly bound review. Derive blocking
severity in controller code; no second contradictory verdict flag.

Schema validation is followed by semantic validation: nonempty evidence/fix,
known severities, bounded sizes, exact candidate and matching operation.
Review hints cannot waive required checks or authorize a fix/merge.

Keep existing worker `TASK_FAILED`, prerequisite and goal marker behavior for
this migration; committed plan/check evidence remains authoritative. Converting
all worker/goal protocols to JSON is unrelated scope.

Bind outputs outside the implementation worktree so reports do not dirty the
candidate. Capture validated result, usage and proof under the controller's run
directory before clearing the active operation or accepting its candidate.
Persist content/hash/identity, not only a temporary path. Never treat a launch
receipt, status preview, truncated tail or missing report as a clean result.
Retained old text review records use only the legacy decoder.

Native paths are trusted-runtime evidence, not arbitrary public paths. Validate
identity, allowed root/file type, size and path traversal at the read boundary.
Do not scan unrelated sessions or disclose task text/credentials in UI metadata.

### D7 — Remove projection, retain presentation

Delete pi-tasks TaskStore integration, queues, task IDs, ready/degraded projection
status and package requirements. Move the useful `run.tasks` summary to the
existing view/domain helper rather than deleting task information.

Preserve progress strip, hide/show/clear, status, Fleet and background-work.
Keep 1.7.1's execution label alongside the Snapshot qualifier (including
Cancelling, Pausing and stopping an optional stage). An observed operation pause
is amber, not green Working or proof of a supervisor question. When one task is
running/verifying and another waits externally, show both activity and wait.
A prerequisite wait does not automatically mean human input is required.

Replace `taskProjection.sessionId` ownership fallbacks with explicit run/session
ownership during migration; do not orphan historical run visibility.
Preserve session UUID versus transcript-path distinctions.

No new replacement task-list extension. Leave users' pi-tasks files and global
package installation alone; explain that `TaskExecute` is no longer involved.

### D8 — Bounded legacy compatibility, not a second runtime

New runs use the native adapter only after integration and migration gates pass.
Before that checkpoint, the old path stays working; never automatically fall
back between old and new launchers. No permanent backend-selection flag.

Retain a small read-only legacy decoder/importer, not the Bridge implementation.
Import schema-7 operation rows with Node's built-in SQLite reader in read-only
mode; never instantiate Bridge's mutating journal constructor. Older/unknown
schemas stay fenced with explicit migration guidance. Rows belonging only to
pi-tasks are not this extension's data to migrate.

Migration is idempotent and owner/digest/generation-bound. Preserve raw legacy
parameters and their original digest; do not recompute them as a new native
request. Import cancellation intent and delivery receipts independently,
including pending errors, partial results, failed operations and quarantines.

Choose the existing explicit resume/reconciliation path for applying a run
migration; status may describe it but never claim a lease or dispatch. Creating
new native records needs a schema discriminator that old code rejects, not a
silent reinterpretation of `service: "bridge"`. Test that the previous
registry refuses conflicting admission when it sees an unreadable new record.
That refusal does not make downgrade safe: 1.7.1's explicit cleanup can delete
an unreadable record. Do not rename the entire persisted model for aesthetics.

| Legacy state | Required handling without Bridge installed |
| --- | --- |
| Terminal run, no active operation | Read/display/history preserved; normal cleanup rules |
| Paused run, no unresolved operation | Preserve pause; native successor only after explicit resume |
| Active bound single/workflow with valid artifacts | Import exact mapping; observe original identity/proof; never relaunch root |
| Bound terminal result | Capture and validate legacy result/proof, then continue current stage once |
| Stop requested, not delivered | Preserve pending intent/error; use only authorized native control for that identity |
| Correlated non-start rejection | Validate receipt and preserve fence; a later retry uses a fresh operation |
| Dispatching/unknown, no exact mapping | Preserve uncertainty and reservations; no automatic replay |
| Mapping disagrees with run/digest/session | Fail closed, retaining both diagnostics |
| Missing/locked/corrupt/unsupported journal | Visible migration prerequisite; no empty-new-database fallback |
| Foreign live owner or ambiguous host | No takeover; existing explicit same-machine rules remain |
| Quarantined generation | Preserve inventory/reservations; no old result may advance new generation |

Migration must account for the WAL: use a consistent SQLite snapshot/backup, not
a copy of only the main database file. Before applying to real records, require
quiescent old controllers/Bridge-owning hosts and an operator-approved backup.
Never stop those hosts automatically. Live old children are not presumed dead
when their host exits. This plan authorizes fixture migrations only.

**Hard rollback condition: do not run an older controller against a registry
containing any native-format record.** In 1.7.1 (as in 1.7.0), explicit cleanup treats an
unrecognized record as corrupt and can delete its reservation. A new schema
can stop old admission, but cannot fix an already released old cleanup command.
Test and document both behaviors using a pinned previous-version fixture.

For rollback, first stop new launches and settle every affected operation using
the compatible new controller. Preserve terminal history in a backup outside
the registry scanned by the old runtime. Remove eligible native-format records
only through the new controller's safe cleanup, and verify none remain before
starting the old version. Any unresolved record or quarantine blocks rollback.
Never restore a pre-migration backup over newer active ownership. Keep legacy
storage untouched. Quiescence and rollback conditions are operational release
gates, not a claim that this package can police a separately launched old binary.
Here, rollback preflight means an explicit operator check with the compatible
new runtime: stop new work, enumerate every record including terminal/failed
history, refuse while any native-format record or quarantine remains, and only
then authorize the old runtime. Reuse status/cleanup and tested registry
predicates; do not add a generic updater or pretend to intercept old binaries.

### D9 — Cleanup cannot erase uncertainty

Preserve the 1.7.1 retention contract in RunRegistry: successful transitions to
completed, completed_with_findings or cancelled stamp retiredAt once. Later
writes preserve the anchor. An older final record without retiredAt keeps its
pre-write updatedAt as the anchor on its next write, including migration or
artifact metadata updates. Running, paused, cancel_pending and recoverable failed
records do not acquire a terminal retention stamp. A rejected CAS stamps nothing.
The run's retiredAt is retention metadata, never native operation-exit proof.

Use existing reservations and locks; strengthen cleanup where needed. A
nonterminal, failed-resumable, unretired active/failed operation or quarantine
cannot be forgotten. For native-format records, unreadable/corrupt ownership
must refuse deletion, including `--include-failed`; do not retain the old
generic corrupt-record deletion shortcut for these records.

No arbitrary operation-ID replay endpoint exists. Once a safely retired run is
removed, all late events/start requests must be rejected because the owning
run no longer exists. Never auto-create it. Test this instead of introducing
another permanent tombstone database.

The guarantee is safe admission and recovery, not exactly-once external effects
inside arbitrary agent tools. Escaped descendants remain the runtime's documented
best-effort limitation, not a security sandbox.

## Upstream work: minimum necessary, never speculative

Production code must use released public APIs. First run contract probes against
the selected release and inspect whether an existing public mechanism suffices.
Do not import private launch/control modules or patch installed node_modules.

| ID | Baseline fact / gap | Smallest acceptable response | Gate |
| --- | --- | --- | --- |
| U1 | RPC stop rejects paused/queued runs while tool behavior differs | A narrow upstream bugfix reusing the existing stop-state/ownership policy, with tool/RPC parity tests | Prove correct stop behavior for supported states before claiming it; preserve pending intent meanwhile |
| U2 | Lost reply correlation after host restart is not a documented durable caller-operation lookup; current Bridge parses status text | First prove whether structured status/artifacts already expose an exact request binding. If not, propose a bounded, session-scoped structured correlation lookup/projection using the existing RPC request identity and native run storage | A found exact binding enables reattachment; not-found is still unknown, NOT non-start or replay permission |
| U3 | Parent death before observing runner close can leave retirement unknown | Document and test the boundary. Propose a native fix only if existing authoritative evidence is being incorrectly dropped or inaccessible | No PID/file-age inference, fake proof, new supervisor daemon or redesigned process engine |
| U4 | Turn/lifetime/completion controls may differ between direct leaf and wrapper | Verify documented support and actual enforcement. If a documented option is broken, provide one repro/fix; otherwise report the unsupported behavior | No invented executionLifetime capability or silent loss of a supported control |

U2 is a proposal, not an existing endpoint or a demand for a second durable job
engine. Persisting/exposing correlation before dispatch should reuse native run
storage; bound lookups, handle duplicate request identity explicitly, validate
session ownership, and distinguish unavailable/stale/ambiguous from found.
Never make spawn replay idempotent by accident. An authoritative non-start
protocol would be a different, separately justified upstream change.

Any upstream proposal must include: minimal reproduction, current documented
behavior, exact public contract, compatibility/security impact, failing/passing
tests, and why existing APIs cannot do it. No plan-exec names, SQL schema, task
semantics or caller policy in upstream. Check for existing merged/released fixes
before proposing another.

Upstream source work uses its own separate worktree when separately authorized.
Opening PRs, publishing packages, upgrading global installations and editing
user settings need explicit approval. A blocked release dependency is recorded
as `Prerequisite: runtime` with evidence, not bypassed by CLI/tool fallback.
A local fixture against an upstream patch is development evidence, not released
compatibility. Do not enable the new production path until its required contract
gates pass on the pinned released package.

## Supported-scenario and test matrix

Identifiers below are acceptance requirements, not extra execution tasks.
Every row must map to a test name in the evidence record. Reuse existing tests
where they prove behavior; do not duplicate them solely under a new filename.

Layers: P = pure/table tests; C = controller with real temp registry/Git and fake
external RPC boundary; H = real Pi/public RPC and detached native runner with a
deterministic local model; X = separate host processes with fault barriers.

| ID | Scenario | Required assertion | Layer / starting coverage |
| --- | --- | --- | --- |
| S01 | Plan in new worktree, in place, explicit existing worktree, nested cwd | Correct branch/path, same accepted baseline, no extra native worktree | C/H; git, isolation, autonomous-controller |
| S02 | Legacy sequential dependencies and explicit independent tasks | Same readiness; failed A preserved, independent B can run in safe lane, dependent C waits | C; autonomous-controller, scheduler behavior |
| S03 | Untracked/tracked plan, approved structural change, dirty partial lane | Preserve approved checkbox facts, history and ancestry; refuse unapproved drift | C; autonomous-controller |
| S04 | `/goal` intermediate answer, done claim, failing checks | Continue until committed checks/review pass; no plan file invented | C/H; autonomous-goal |
| S05 | Goal stall, turn budget, blocker, deleted/skipped tests | Existing pause/confirmation policy; explicit resume only where required | P/C; goal-loop, autonomous-goal |
| S06 | Native worker, fixer, reviewer, optional stats | Direct leaf; exact effective agent/model/cwd/tools; one launch per authorized attempt | H; new native-runtime contracts |
| S07 | Concurrent starts/resumes through path aliases | One reservation/dispatch; loser observes/refuses without overwriting state | C/X; registry, controller |
| S08 | Crash before preparation / prepared before dispatch claim | Zero workers; valid prepared intent may start once after safe claim | C/X; new operation-safety |
| S09 | Crash after dispatch claim before event emit | No blind replay; unknown outcome fenced unless authoritative correlation resolves it | C/X |
| S10 | Worker launched, reply dropped | Same operation reattaches from exact correlation; one worker side-effect | H/X; adapt faulty-bridge |
| S11 | Reply received, persistence fails, then restart | Recover exact native binding or stay fenced; never a second child | C/X |
| S12 | Completion arrives before reply / duplicate or late events | Bind only matching request; monotonic result; old generation ignored | C/H |
| S13 | Native pre-dispatch invalid-params rejection vs runtime failure | Only proven correlated non-start retires without process proof | P/H; bridge/recovery fixtures |
| S14 | Reused operation UUID with different params/session/generation | Refuse; no overwrite and no dispatch | P/C |
| S15 | Extension reload, session fork/switch, process restart | New context/subscriptions; dispose old callbacks; no stale launch/acceptance | C/H/X; index lifecycle tests |
| S16 | Long quiet tool / stale lastUpdate / no activity event | Neither timeout inference nor duplicate worker | C/H |
| S17 | Native extension unavailable at startup or during status | Bounded probe/backoff; same operation resumes when ready | C/H |
| S18 | Stop before dispatch | Persist fence; zero native launches; eventual paused/cancelled according to intent | C/X |
| S19 | Stop races spawn and late successful completion | Bind child then stop; no acceptance or next task after stop generation | C/H/X |
| S20 | Stop delivery timeout / invalid-state / lost ack / repeated stop | Intent survives; exact-run retry; delivery is not retirement | C/H |
| S21 | Running, queued, paused, supervisor-wait child stops | Match supported native semantics; unsupported route stays pending with real reason | H; U1 gate |
| S22 | Result says complete/failed/stopped without terminal proof | No writer release, lane rotation, promotion or replacement | P/C/H |
| S23 | Parent killed before child close; orphan later exits | Reattach if public proof exists, otherwise retain uncertainty; no PID heuristic | X; U3 characterization |
| S24 | Proof wrong run/runner/caller; malformed/missing/private candidate only | Reject; unknown never becomes non-start | P/C |
| S25 | Observed pause vs supervisor question vs user pause | Paused alone proves no question; explicit user intent wins stale/renamed-host and generic recovery guidance; unpolled status does not restart cleanup; real supervisor continuation stays same child/session | C/H; controller, index |
| S26 | New session takes plan lease but not native control ownership | No forged native session; clear restore-original-session guidance | C/H |
| S27 | Foreign host, same-machine assertion, reused PID, stale lease | Preserve existing host and ownership gates; no age-only takeover | C/X; registry, owned-process |
| S28 | Bounded expiry, default native deadline, unbounded request | Honest requested/effective lifetime; continuation only with confirmed cause/proof | P/H |
| S29 | Model/auth/provider failure and explicit one-attempt override | Preserve operation error; no endless same bad-model redispatch or permanent override | C/H; controller |
| S30 | Credentials/permission/executable/runtime prerequisite | Evidence required; backoff probe; preserve lane and permit eligible independent work | C; autonomous-controller |
| S31 | Typed review clean/blocking/minor/malformed/wrong candidate | Required review cannot falsely pass; fixes re-review current SHA; minor findings retain correct terminal status | P/C/H; review, review-backend |
| S32 | Missing/truncated output, deleted temporary result, retained archive | Prefer bound complete captured evidence; missing evidence blocks acceptance | P/H; artifact |
| S33 | Output schema/tool ceiling conflict, missing agent/skill | Fail admission or proven non-start; never widen tools to satisfy schema | H |
| S34 | Frozen native controls actually enforced | Max turns, model scope, tool limits and completion behavior verified, not merely echoed | H |
| S35 | Local required check/bootstrap interrupted or orphaned | Existing owned-process cancellation and retirement remain unchanged | C/X; local-operation, owned-process |
| S36 | Dirty/untracked candidate, wrong ancestry, changed branch | No checkbox/prose-only acceptance; confirmations remain required | C; controller, owned-git |
| S37 | Promotion/archive crash, ignored files, output branch changed | Safe retry/fast-forward; preserve user files; no duplicate acceptance | C/X; autonomous-controller |
| S38 | Optional stats failure / required review failure / explicit waiver | Stats degrade; required review cannot skip; waiver ends with findings | C; controller |
| S39 | Explicit Fusion/Revmux, unavailable provider, fallback policy | Preserve existing supported behavior and capability refusals; no implicit new compatibility | C; fusion, review-backend |
| S40 | Status/hide/show/clear and slash-only/no-session host | No lease claim; execution label survives Snapshot; operation pause stays amber; active work and external wait both visible; no pi-tasks requirement | P/H; run-view, index, pi-rpc-smoke |
| S41 | Fleet failure, stale update, terminal retention, bg_wait | Display failure cannot erase active tracking; one row/provider per owned run | C/H; runtime-integration |
| S42 | Legacy terminal/paused/active/failed/quarantined records | Outcomes match D8; old workflow result can settle once without root replay | P/C/H |
| S43 | Missing/busy/corrupt/schema-unknown legacy SQLite/WAL | Fail closed, preserve database/records, never create an empty replacement | C/X |
| S44 | Migration interrupted before/after atomic record replacement | Repeat safely with same identity; backup unchanged; no launch from migration | C/X |
| S45 | Old and new runtime simultaneously present | Quiescence/admission guard blocks unsafe cutover; no double writers | H/X |
| S46 | Cleanup races resume, corrupt native record, delayed events after deletion | Refuse unresolved cleanup; no resurrection or dispatch after safe removal | C/X; registry |
| S47 | Explicit isolated recovery of unknown native/legacy operation | No assertion of old death; independent repo; old generation remains reserved | C/X; isolation |
| S48 | Removed packages absent / installed but unused | Native execution identical; no foreign widgets, TaskExecute channels or files touched | H; fresh packed consumer |
| S49 | Public RPC boundaries malformed or request IDs mismatched | Reject late/foreign replies; listeners/timers bounded and disposed | P/H; rpc adapter |
| S50 | Native process-proof containment limits | Reject unsupported/overstated proof; reuse existing local owned-process tests unchanged, with no new escaped-descendant containment requirement | P/H; native proof plus existing owned-process coverage |
| S51 | Safe retry after terminal failure | New operation/request IDs; old params/results immutable; no cumulative usage double count | P/C/H |
| S52 | Native artifacts contain foreign paths/oversized payload | Fail bounded and diagnostic; do not read arbitrary files or accept truncated evidence | P/C |
| S53 | New-format record encountered by old registry | Characterize old admission refusal AND old cleanup deletion hazard; supported rollback refuses while any native-format record remains | C; version-pinned legacy fixture and rollback preflight |
| S54 | New controller's dependency removed before final archive | Already running executor remains usable; documented completion path has no self-upgrade requirement | H; pinned execution host |
| S55 | Completion/cancellation retention through later writes and legacy migration | Preserve retiredAt; legacy final record anchors to pre-write updatedAt; unfinished/recoverable and rejected-CAS records gain no stamp; cleanup age never resets | C; registry, index, controller plus legacy import |
| S56 | Concurrent write rejects a stage-transition CAS | No log for rejected transition; next successful transition logs once; same run/generation/attempts and no extra launch | C; controller |

### Test construction rules

- Pure transitions and classifications: table-driven cases; fake clock only at
  clock boundary. Assert allowed effects (spawn count, acceptance count, state),
  not helper call order or private object layouts.
- Controller tests use real RunRegistry, files and temp Git repositories. Mock
  the external runtime boundary, not the kernel and registry together.
- Contract tests load the actual released RPC implementation/extension; use
  private factory injection only inside a clearly version-bound test harness,
  never production. Exercise public event envelopes and native result/proof
  outputs, not a mock that accepts arbitrary fields.
- At least one fresh-host smoke loads the extension through Pi's normal package
  loader without private executor assembly. This catches module resolution,
  load order, runtime agent availability and startup/shutdown bugs.
- H/X tests use a deterministic local HTTP model or existing scripted model
  fixture; no paid API calls or developer credentials. Children run in the real
  detached native runner.
- Crash tests use explicit IPC/file barriers at named durable boundaries and
  terminate only fixture-owned PIDs. Count actual child side effects separately
  from RPC requests: one rejected request plus one launch is not two workers.
- Test both graceful reload and SIGKILL; a mocked rejected promise is not a crash
  test. Kill parent/controller and runner at distinct barriers.
- Bound test waits and cleanup, dump state/proofs/dispatch counts on failure,
  retain failed sandboxes. Cleanup observes fixture process retirement before
  removing their files. Do not widen retries to hide a race.
- Preserve Vitest and the existing separate node:test index suite. Do not add
  infrastructure/tooling dependencies merely for this refactor.
- Keep 1.7.1 regressions when deleting TaskProjector. Replace its use as a CAS
  contention trigger with a controlled legitimate concurrent registry write.
  Replace projection-repair-only retention fixtures with lease release,
  migration or supported metadata writes. Keep a legacy fixture proving that
  an existing final record's cleanup age survives its first new-format write.
  Do not delete these behaviors because their old trigger depended on pi-tasks.
- Required host coverage is Darwin and Linux POSIX. Local Darwin success is not
  Linux evidence. Unsupported platform behavior must refuse clearly.
- Pin native versions for host fixtures; test the minimum supported release and
  the release selected for cutover. Test unsupported capability refusal.
- A package absent from the packed consumer must really be absent from module
  resolution and extension discovery; do not reuse the development dependency
  tree or a user-wide installation for this assertion.
- Task 4 adds a repeatable `test/packed-consumer-smoke.mjs`, not a manual
  interpretation of `pack:dry`. It creates a real tarball with `npm pack --json
  --ignore-scripts --pack-destination <fixture-dir>`, installs it with exact
  tested Pi/native releases in a fresh consumer, and launches that consumer's
  own Pi binary through the normal package loader. Give it isolated HOME,
  PI_CODING_AGENT_DIR, native temp roots and registry; clear ambient NODE_PATH,
  NODE_OPTIONS and extension discovery. Do not inherit auth files. Assert both
  removed packages are absent from the installed dependency tree and cannot
  resolve from either consumer or installed plan-exec package. Exercise plan,
  goal, review, stop and restart against the deterministic local model. Archive
  the tarball manifest, package versions and result/proof references. Bound and
  account for registry-network setup failures separately from runtime failures.

## Validation Commands

Run commands in the implementation worktree. Provision its own dependency tree
with the repository-declared npm version; do not share writable node_modules
with another worktree. Preserve package-lock changes deliberately.

Existing gates:

```sh
npm exec --yes --package=npm@12.0.2 -- npm ci
npm run check
npm test
npm run test:runtime-smoke
npm run pack:dry
```

Task 1 creates `test/native-runtime-contract.test.ts` and
`test/native-recovery-smoke.mjs`. Later tasks extend them. They are proposed
paths, not claims that these commands already work:

```sh
npm exec -- vitest run test/native-runtime-contract.test.ts
node --test test/native-recovery-smoke.mjs
node --import jiti/register --test test/index.test.ts
```

Task 4 adds the actual packed-consumer gate, distinct from the existing
manifest-only dry run:

```sh
node --test test/packed-consumer-smoke.mjs
```

Fitness check: no `.archfit.yaml` exists at the inspected baseline. Add no
archfit framework for this work. Use a narrow boundary regression in
`test/runtime-boundaries.test.ts` plus the existing package guard: production
must not import removed packages or private pi-subagents modules; only the
legacy reader may recognize old protocol/data names. Historical docs and legacy
fixtures are not false-positive failures. Prove the guard fails with a forbidden
import in a test fixture and passes for public imports.

Impact evidence uses a current, worktree-matching GitNexus index, never the main
checkout's stale index. For each task use its named impact command and:

```sh
gitnexus detect-changes --scope all
git diff --check
git diff --name-only
```

If the index is missing/stale, record that fact and use targeted `rg` plus
`git diff --name-only`; do not claim graph verification. Refreshing an index is
optional evidence collection, not a production dependency.

Record verification in `docs/plans/native-runtime/evidence.md` during
implementation: baseline package versions, scenario-to-test mapping, commands,
exit codes, upstream gaps, runtime receipts and sanitized artifact references.
Use plain headings there, not another executable task list. Do not change this
plan's structure after a run starts; only checkbox markers may change.

## Implementation Steps

### Task 1: Characterize the native contract and establish the recovery safety net

Justification: E1–E4, E8–E13; D3–D6; U1–U4. This task settles compatibility
before changing execution. It does not switch the production backend.

Files:
- `test/native-runtime-contract.test.ts` — new real public RPC contract cases.
- `test/native-recovery-smoke.mjs` — new isolated host/crash harness.
- `test/fixtures/native-runtime-host.ts` — fixture-only transport interception.
- Existing `test/fixtures/autonomous-scripted-session.mjs`,
  `test/fixtures/autonomous-git-environment.mjs` — reuse deterministic boundaries.
- `test/runtime-boundaries.test.ts` — boundary guard helper and negative cases.
- `docs/plans/native-runtime/evidence.md` — contract decisions and scenario map.

Preconditions: clean implementation worktree; baseline package versions recorded;
no user run/journal/global settings touched.
Postconditions: direct-leaf behavior and every upstream gap are reproducible;
the old execution path still passes baseline checks.
Fitness gate: establish baseline counts/imports and a guard for new native
modules; do not falsely require old dependencies to disappear before Task 4.
Impact: `gitnexus impact BridgeClient --file src/bridge.ts --include-tests`.
Verification:
```sh
npm test
npm run test:runtime-smoke
node --test test/native-recovery-smoke.mjs
npm run check
```
Manual checks:
- Review each upstream proposal for generic value and minimum scope.
- If a mandatory native contract is missing, record the release prerequisite.
  This task can document the gap; cutover cannot pass by ignoring it.

- [ ] Before changes, capture `npm test` and `npm run test:runtime-smoke` baseline results, package/runtime versions, Bridge/projection source sizes and existing coverage. After this task's changes, run the full listed gates. Do not duplicate a passing test merely to rename it.
- [ ] Build an isolated native RPC fixture that runs a direct async worker and reviewer with the actual release, records exact launch/result/proof identities and counts real child side effects.
- [ ] Test effective context, cwd, model, tools, output schema, output binding, turn controls, acceptance/completion behavior and timeout semantics. Distinguish unsupported options from advertised-but-broken options.
- [ ] Add deterministic barriers for prepared intent, dispatch claim, native launch, reply delivery, binding persistence, result capture and acceptance; support dropped reply, duplicate/late completion and parent SIGKILL.
- [ ] Characterize native status/correlation after reload and process restart, same-session versus foreign-session controls, supervisor wait and process proof when the parent dies.
- [ ] Reproduce U1 against the actual RPC route and compare the existing tool policy without using that tool as a production fallback.
- [ ] Resolve U2 by testing existing public structured identity/artifacts first. Record the exact supported binding mechanism or a minimal upstream proposal; never bless status-text parsing or not-found-as-absence.
- [ ] Record U3/U4 limits and any genuinely necessary upstream bugfix reproduction. Do not change another repository, publish a PR or install a global package under this task.
- [ ] Add the negative boundary-guard cases and map S01–S56 to retained tests, planned tests or explicitly blocked host contracts. Record which assertions require H/X rather than mocks.
- [ ] Run this task's gates, preserve sanitized evidence, and commit only its safety-net changes and checkbox updates. Leave production dispatch unchanged.

### Task 2: Implement the internal native adapter and operation safety kernel

Justification: E4, E7–E9, E13; D1–D4, D9; S07–S30, S46, S49, S51, S55.
This task implements one seam alongside the old path; it does not yet choose it
for user runs.

Files:
- `src/native-runtime.ts` — public RPC adapter, validated native observations.
- `src/operation-safety.ts` — small pure transition/identity helpers.
- `src/rpc.ts` — persisted request ID and envelope correlation.
- `src/types.ts`, `src/registry.ts`, `src/lifecycle.ts` — versioned native
  operation data, CAS, retirement/cleanup predicates.
- `test/native-runtime.test.ts`, `test/operation-safety.test.ts`,
  `test/native-runtime-contract.test.ts`, `test/registry.test.ts`,
  `test/native-recovery-smoke.mjs` — focused coverage.

Preconditions: Task 1 evidence identifies the exact supported native contract.
Postconditions: native operations can be prepared, dispatched, observed and
stopped through one kernel; unknown outcomes cannot launch again.
Fitness gate: new production modules import public native APIs only; no SQLite,
new scheduler or second authoritative native journal.
Impact: `gitnexus impact RunRegistry --file src/registry.ts --include-tests`.
Verification:
```sh
npm exec -- vitest run test/native-runtime.test.ts test/operation-safety.test.ts test/native-runtime-contract.test.ts test/registry.test.ts test/registry-lock.test.ts test/lifecycle.test.ts test/runtime-boundaries.test.ts
node --test test/native-recovery-smoke.mjs
npm run check
```
Manual checks:
- Read the crash-window proof: dispatching-before-emit cannot be replayed.
- Confirm corruption/cleanup cannot delete an unresolved writer reservation.

- [ ] Define the native operation discriminator and immutable fields from D3, with explicit prepared/dispatching/bound/retired transitions and independent stop intent/delivery. Reuse current run state instead of introducing a new database.
- [ ] Implement canonical request digest and exact identity validators, keeping caller/native/process namespaces separate. Reject stale generation, changed parameters and mismatched request/reply IDs.
- [ ] Extend registry validation and CAS transitions so one prepared operation can claim dispatch once. Re-read authorization before emit; missing/currently different run or operation always refuses. Preserve D9's 1.7.1 retention anchors and rejected-CAS behavior (S55).
- [ ] Implement direct async spawn, targeted status/proof reading and authorized stop through public RPC. Register bounded listeners before sending; use fresh session context; dispose idempotently.
- [ ] Implement exact-correlation recovery using Task 1's proven public mechanism. Persist a recovered binding only after identity/owner checks; a lookup error or missing evidence stays unknown.
- [ ] Persist and retry cancellation on the same operation. Treat queued/delivered as transport facts, retain original correlated errors, and accept retirement only through validated proof/non-start evidence.
- [ ] Ensure late replies and events merge against the current record without clearing newer cancellation, pause or quarantine. Do not infer ownership from advisory activity.
- [ ] Add restart/race cases with real registry locks and separate host processes: concurrent dispatch, dropped reply, disk failure, stop during launch, late success and old-generation events.
- [ ] Strengthen native cleanup to refuse unreadable ownership and all unresolved active/failed/quarantined operations. Test safe removal followed by late start/completion cannot resurrect a run.
- [ ] Run the gates and inspect the diff for duplicated controller policy. Record the minimal kernel boundary and commit it while the old production path remains selectable only by existing code.

### Task 3: Route controller execution and results through the native seam

Justification: E3, E6–E13; D1, D4–D7; S01–S06, S15–S17, S25–S41, S51, S54–S56.
Integrate one native controller path, initially under test composition until the
migration gate in Task 4. Do not add a permanent user backend switch.

Files:
- `src/controller.ts`, `src/index.ts`, `src/diagnostics.ts`,
  `src/lifecycle.ts` — native launch/observe/cancel and wake wiring.
- `src/artifact.ts`, `src/review.ts`, `src/types.ts` — result/proof capture
  and typed native review contract.
- `src/runtime-integration.ts`, `src/run-view.ts` — observer identity/state.
- `test/controller.test.ts`, `test/autonomous-controller.test.ts`,
  `test/autonomous-goal.test.ts`, `test/artifact.test.ts`,
  `test/review.test.ts`, `test/diagnostics.test.ts`,
  `test/index.test.ts`, `test/runtime-integration.test.ts`,
  `test/native-recovery-smoke.mjs`.

Preconditions: Task 2 kernel gates pass; upstream-dependent production behavior
is not claimed until its exact released contract passes.
Postconditions: the test-composed controller runs plans/goals through direct
native leaves and accepts only durable validated results; domain behavior is
unchanged.
Fitness gate: controller has one native launch path; no Workflow replay loop,
private native imports or new local command runner.
Impact: `gitnexus impact PlanExecController --file src/controller.ts --include-tests`.
Verification:
```sh
npm exec -- vitest run test/controller.test.ts test/autonomous-controller.test.ts test/autonomous-goal.test.ts test/artifact.test.ts test/review.test.ts test/diagnostics.test.ts test/runtime-integration.test.ts test/run-view.test.ts test/local-operation.test.ts test/owned-process.test.ts
node --import jiti/register --test test/index.test.ts
node --test test/native-recovery-smoke.mjs
npm run check
```
Manual checks:
- Review one complete task, required-review/fix cycle and goal trace.
- Compare effective native limits with frozen requested policy; document any
  unsupported limit instead of silently dropping it.

- [ ] Replace Bridge-shaped controller assumptions with the normalized native seam for worker/fixer/reviewer/stats, preserving original operation, task, review and stop generations.
- [ ] Preserve local Git/check/bootstrap execution, accepted-baseline verification, partial task lanes, promotion/archive and explicit review-backend selection. Do not broaden Fusion/Revmux compatibility.
- [ ] Use direct leaves with fresh context, controller-owned cwd/worktree and no mission; remove new-run single-child workflow wrappers rather than replacing them with a named one-child resource.
- [ ] Define a minimal typed native reviewer schema and semantic checks. Bind candidate SHA and operation; keep native text review parsing only for imported old results.
- [ ] Bind new outputs under run-owned storage and atomically capture complete result/usage/proof before acceptance. Fail closed on missing/truncated/wrong-identity artifacts or capture failure.
- [ ] Connect completion/readiness wake hints to the existing serialized loop with periodic reconciliation/backoff as fallback. Test duplicate wakes, load-order delay and disposed contexts cannot start work.
- [ ] Preserve automatic recovery, one-attempt model overrides and D4's 1.7.1 user-pause precedence without inventing supervisor questions. Keep stage logging conditional on applied CAS (S56); remove duplicate branches only with equivalent tests.
- [ ] Keep supervisor waits on the original child. Preserve native session authority across plan lease takeover; surface the exact safe action when another session cannot control it.
- [ ] Exercise S01–S41, S51 and S54–S56 through the native test composition, including independent lanes, nested cwd, review/fix, goal continuation and local-operation retirement. Count launches and accepted commits.
- [ ] Run the gates, record any unresolved upstream prerequisites as blockers for Task 4, and commit the integrated seam without removing the old migration evidence.

### Task 4: Migrate legacy state and remove pi-tasks and Bridge dependencies

Justification: E4–E6, E8, E13; D7–D9; S40–S48, S53–S56.
This is the cutover checkpoint. No live-data migration or global uninstall is
authorized by this plan.

Files:
- `src/legacy-operation.ts`, `src/registry.ts`, `src/types.ts`,
  `src/isolation.ts`, `src/index.ts`, `src/artifact.ts` — bounded legacy
  reading/import, explicit migration and reservation preservation.
- `src/task-projection.ts` — remove after extracting run-based summaries.
- `src/bridge.ts` — remove after moving only needed proof/type logic.
- `src/runtime-integration.ts`, `src/run-view.ts`, `src/controller.ts` —
  remove projection plumbing and make native runtime the only new-run path.
- `package.json`, `package-lock.json`, `scripts/check-pack.mjs` —
  remove both packages, preserve host peers and required native version.
- `test/packed-consumer-smoke.mjs` — actual tarball install and normal-loader
  execution in an isolated consumer without removed packages.
- `test/legacy-operation.test.ts`, `test/runtime-boundaries.test.ts`,
  `test/pack.test.ts`, `test/registry.test.ts`, `test/isolation.test.ts`,
  `test/runtime-integration.test.ts`, `test/index.test.ts`,
  `test/ui-autonomous.test.ts`, `test/ui-controller-integration.test.ts`.
- `test/fixtures/recovery-host.ts`, `test/fixtures/faulty-bridge.ts`,
  `test/recovery-agterm.mjs`, `test/recovery-agterm.test.ts`,
  `test/autonomous-runtime-smoke.mjs` — migrate fixtures off installed Bridge.

Preconditions: Tasks 1–3 pass; required U1/U2 contract needs are either satisfied
by a pinned released native version or explicitly block this task. No hidden
text-scraping/CLI fallback is accepted.
Postconditions: new runs need neither package; supported old records remain
readable/recoverable or correctly fenced without installing Bridge.
Fitness gate: boundary tests and packed manifest reject both dependencies and
old RPC service code; legacy data readers/fixtures are narrow exceptions.
Impact: `gitnexus impact TaskProjector --file src/task-projection.ts --include-tests`.
Verification:
```sh
npm test
npm run test:runtime-smoke
node --test test/native-recovery-smoke.mjs
node --test test/packed-consumer-smoke.mjs
npm run check
npm run pack:dry
```
Manual checks:
- Review migration preview, consistent backup instructions and non-rollbackable
  active-record cases. Confirm no task asks an agent to kill real user sessions.
- Validate previous-version admission refusal and its unsafe explicit-cleanup
  behavior using disposable fixtures. Verify the supported rollback preflight
  refuses every remaining native-format record, including terminal history.

- [ ] Implement a read-only schema-7 legacy importer with owner/digest binding and version/size validation. Missing database never creates one; preserve original request and receipt data.
- [ ] Implement idempotent fixture migration for every D8 row, including active/failed/quarantined operations, pending cancellation errors and historical workflow outputs. Migration never dispatches.
- [ ] Add crash barriers around snapshot/import/atomic record replacement, WAL consistency cases, conflicting mappings and unsupported schemas. Preserve old data byte-for-byte where no write was authorized.
- [ ] Add cutover quiescence checks/guidance and new-format discrimination. Test previous-version admission refusal and cleanup hazard. Make no-downgrade-with-native-records an explicit rollback preflight condition; preserve native control-session boundaries.
- [ ] Remove TaskStore projection, queues/status/settings and task-ID metadata. Retain run.tasks summaries, explicit ownership and D7's 1.7.1 view semantics. Retarget projection-triggered CAS/retention tests without losing S55/S56 coverage.
- [ ] Remove BridgeClient/RPC envelopes/capability emulation and default bridge installation requirements. Keep only validated proof normalization and read-only legacy compatibility needed by fixtures.
- [ ] Select native runtime for all new operations and remove temporary test-only transition glue from production. Existing unresolved legacy roots remain observed/fenced, never silently re-executed as native leaves.
- [ ] Remove both packages from manifest/lock and packing expectations; update recovery fixtures to intercept native RPC directly. Do not delete third-party task files, Bridge databases or global packages.
- [ ] Implement and run `test/packed-consumer-smoke.mjs` using a real tarball and isolated consumer as specified above. Assert dependency/module-resolution absence and prove plan, goal, review, restart and stop behavior through normal Pi loading.
- [ ] Run the complete `npm test`, runtime/crash/packed-consumer gates, check and pack guard before committing cutover. Compare production scope with baseline. Delete obsolete tests only after equivalent coverage exists; retain legacy safety regressions.

### Task 5: Final verification, documentation and execution handoff

Justification: E1–E13; D1–D9; all S01–S56. This task certifies the migration,
not merely a green unit suite.

Files:
- `README.md`, `DEVELOPMENT.md`, `docs/guide.md`,
  `docs/architecture.md`, `docs/runtime-contracts.md`,
  `docs/upstream-audit.md` — actual new dependencies, lifecycle and limits.
- `skills/exec-plan/SKILL.md`, `skills/exec-plan/references/recovery.md` —
  native recovery guidance, legacy handling and exact commands.
- `docs/plans/native-runtime/evidence.md` — full acceptance matrix and artifacts.
- `package.json`, `.github/workflows/ci.yml` if needed — ensure new contract/
  recovery gates actually run in CI, with deliberate permissions/platform scope.
- Relevant tests/fixtures only for defects exposed by final verification.

Preconditions: Task 4's no-Bridge/no-pi-tasks consumer passes; no unresolved
required upstream capability is papered over.
Postconditions: supported behavior and limits are documented, all acceptance
evidence exists, and implementation worktree is clean after its task commit.
Fitness gate: no production dependency/private API regressions; whole-plan
verification includes actual host/crash checks, not only mocks.
Impact: `gitnexus impact planExecExtension --file src/index.ts --include-tests`,
then `gitnexus detect-changes --scope compare --base-ref main` if index matches.
Verification:
```sh
npm run check
npm test
npm run test:runtime-smoke
node --test test/native-recovery-smoke.mjs
node --test test/packed-consumer-smoke.mjs
npm run pack:dry
git diff --check
```
Manual checks:
- Use a dedicated sandbox Pi session for status, hide/show/clear, stop,
  supervisor question and restart. No production registry or credentials.
- Obtain independent review of dispatch ambiguity, cancellation, legacy import,
  cleanup and simplicity. Human approval/publication remains outside this plan.

- [ ] Close the S01–S56 mapping with exact tests/results; distinguish local Darwin, Linux CI and unrun checks. Any missing required coverage blocks completion, not just a footnote.
- [ ] Run the full gates and normal-loader packed-consumer scenarios without either removed package; confirm fixture descendants are retired and failed-run artifacts remain available for diagnosis.
- [ ] Wire native contract, host/crash recovery and packed-consumer smoke checks into validation/CI. Preserve bounded test runtime and capture proof/identity diagnostics on failure.
- [ ] Update user/operator docs and installed skill sources to match actual native APIs, dependency pins, lifetime limits, self-healing cases, foreign-session restrictions and legacy migration procedure.
- [ ] Document safe upgrade/backup and the hard rollback preflight: no older runtime against any native-format record. Explain the old cleanup hazard, lost optional pi-tasks task list and why global packages/data stay untouched.
- [ ] Verify that running this plan with a separately pinned stable executor is supported through the final archive: do not require the executing Pi process to reload/uninstall its own controller midway.
- [ ] Record actual removed/added code and dependencies, retained compatibility scope, and upstream issue/PR/release evidence if applicable. Do not claim a line-count improvement before measuring it.
- [ ] Resolve independent review findings, rerun only affected checks after fixes, and record a scoped architecture re-review of D1–D9. Commit final docs/evidence and checkbox updates; do not push, tag or release without approval.

## Acceptance criteria

All of the following are required, not inferred from workflow success:

- The new packed consumer operates without pi-tasks and Bridge, with no runtime
  import resolution through an ambient development installation.
- Every new launch/control path enters the same registry-backed kernel.
- Exact dispatch-count assertions pass for lost reply, concurrent resume,
  cancellation races, reload and process death. Unresolvable cases stay fenced.
- Domain acceptance still requires committed facts, ancestry, required checks,
  clean worktree and exact-candidate review.
- New-runtime migration/cleanup tests preserve uncertainty and reservations.
  Supported rollback refuses a registry containing any native-format record.
  Old cleanup's deletion hazard is demonstrated, not represented as protected.
  Normal execution modifies neither old database nor third-party task store.
- Typed reviews and captured artifacts cannot convert missing/truncated/foreign
  output into success.
- Existing plan/goal/local-command/Fleet/view and explicit review-backend
  behaviors remain covered; upstream limitations are accurately exposed.
  The 1.7.1 pause/display, CAS logging and retention fixes have native-path
  regressions, including their replacement fixtures after pi-tasks removal.
- Required native contract gaps have released fixes or prevent cutover.
- The implementation has no new scheduler/database/daemon, automatic backend
  fallback, generic policy DSL, or unused workflow-resource framework.
- Documentation names what heals automatically and what needs a decision.
  "Self-healing" never means guessing that a writer stopped.

## Safety notes and rollback

Execute this plan using a separately installed, pinned stable pi-plan-exec
controller, or an operator-managed implementation session. Do not hot-reload
the code being refactored into the controller currently writing it. A local
development worktree is the target, not the live extension installation.

Before execution, commit this plan after operator approval so its initial
content is preserved in the implementation baseline. Configure required checks
outside the plan if the chosen executor needs them; do not silently change user
settings. Once execution starts, change only checkbox markers in this file.
Record discoveries in the evidence file; material design changes require
approval and a revised plan before another run.

This plan does not authorize touching real run registries, journals, worktrees
outside fixture/implementation targets, global packages, credentials or another
repository. Migration fixtures use temporary copies. Real deployment, upstream
PR submission and release are separate operator decisions.

Do not broaden native process proofs or use a different execution protocol to
make recovery progress. Preserve unknown workers and their artifacts. Existing
explicit isolated recovery remains a user-approved alternative for local-only
work, never an automatic substitute for proof or a solution for external effects.

## Re-review

After implementation, perform a scoped architecture review of
`native-runtime`, `operation-safety`, registry/controller integration, legacy
import and result capture. Check one source of truth, no duplicate retry loops,
bounded external coupling, dependency removal, and every no-second-writer gate.
Then obtain release approval separately.

## Authoring review

Two independent read-only reviews covered safety/migration and execution/tests.
Their confirmed findings were incorporated before handoff:

- Old-version explicit cleanup can delete new-format records. Rollback now has
  a hard no-native-records prerequisite, with a regression demonstrating the
  historical hazard instead of claiming old cleanup is safe.
- Manifest-only packing cannot prove dependency removal. A real tarball,
  isolated install and normal-loader packed-consumer smoke are mandatory gates.
- Baseline and cutover now run the full test suite plus native runtime smoke.
- Containment testing is limited to the native proof contract and existing
  local-runner coverage; this migration does not promise stronger containment.

These reviews assess the plan, not an implementation. The subsequent 1.7.1
refresh was checked against the release diff and its regression tests. It adds
E13/S55/S56 and strengthens S25/S40 without changing the native architecture.
The public-native correlation and stop-contract probes remain implementation
prerequisites.

## Execution handoff

From a Pi session with the stable executor installed:

```text
/exec status
/exec --worktree <absolute-implementation-worktree> docs/plans/native-runtime/plan.md
```

The second command starts work and is intentionally not run while authoring
this plan. Resolve any existing execution-target reservation first; never create
a second run to bypass recovery.
