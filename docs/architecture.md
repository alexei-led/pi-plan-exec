# Architecture

Plan-exec owns domain policy and durable authorization. Pi and pi-subagents own
agent execution. The [runtime contract](../skills/exec-plan/references/runtime-contracts.md)
defines proof/compatibility; this document defines module responsibilities.

## Boundaries

| Module | Responsibility |
| --- | --- |
| src/index.ts | Commands, session lifecycle/handoff, polling and native UI wiring |
| src/controller.ts | Task/goal stages, checks, review, Git acceptance, retries and stop policy |
| src/registry.ts | Sole operation ledger, CAS, leases, reservations and durable critical transitions |
| src/registry-lock.ts | Stable-path kernel flock; no stale-lock guessing |
| src/native-single-runtime.ts | Version-2 direct-single identity/status/output/process-proof mapping |
| src/native-runtime.ts | Shared authority/transport/admission and historical workflow decoder |
| src/operation-safety.ts | Immutable native digest, dispatch/binding and record validation |
| src/execution-contract.ts | Versioned capability and native proof validation |
| src/native-reviewer.ts | Public namespaced readonly runtime role registration |
| src/config.ts / src/lanes.ts | Effective configuration, bootstrap/check detection and frozen argv |
| src/plan.ts / src/scheduler.ts | Plan identity/dependencies and eligible task selection |
| src/goal-loop.ts | Goal outcome protocol, fingerprints and reassessment signals |
| src/inspector.ts / src/run-view.ts | Read-only preview/details and semantic responsive presentation |
| src/runtime-integration.ts | Advisory subagents Fleet/background-work projection |
| src/local-operation.ts / src/owned-process.ts | Durable local-command intent, group ownership and retirement |
| src/git.ts / src/isolation.ts | Checkout identity, lanes, checkpoints and explicit quarantine |
| src/legacy-operation.ts | Lazy read-only offline schema-7 import |
| src/fusion.ts / src/review-backend.ts | Explicit optional backends and capability refusals |
| src/progress.ts | Applied-transition progress history, not execution authority |

## Data flow

Commands allocate one run and freeze its effective plan/check/review policy.
The controller chooses one eligible operation. New native intent is a **direct
single**, not a script workflow; native workflow auto-resume cannot create a new
root for that operation. The registry persists UUID/digest/cwd/output before
emission. Native alias lookup and published artifacts provide exact observations;
they do not authorize another spawn.

The record lock serializes the final prepared CAS, fsynced dispatch intent and
synchronous emit with stop/abandon writes. It is released before any provider
wait. Authority, reservation, acceptance and control transitions are fsynced;
repeated heartbeat/diagnostic updates remain atomic without an unnecessary flush.

Binding is not retirement. Process proof must identify the exact single and
runner closure; result settlement then needs consistent native status and
caller-bound output. Native result JSON is transient after notification delivery,
so it is checked when supplied but is not the only settlement source.

The controller independently verifies committed checkbox truth, ancestry,
checkpoint integration, required commands, clean-tree state and reviewed/final
commits. Model prose, activity and tool receipts cannot replace these gates.

## Recovery and history

Prepared, dispatching, bound and retired are distinct phases. A lost response
uses the saved exact RPC alias; unknown/expired/ambiguous correlation stays
reserved. Native spawn itself is not idempotent. Neither a registry lease nor
readable foreign status transfers native session control authority.

Version-1 records retain their original decoder and immutable requests. The
new production path refuses unresolved historical workflow continuation rather
than manufacturing a no-successor guarantee. Explicit isolated recovery keeps
the old identity/target quarantined and requires local-files-only approval.

Pause/cancel intent is independent of stop delivery and exit. Cancel hides the
view immediately; pending cleanup still counts as background work. Force-stop
backs up and abandons management before best-effort exact control, preserving
unknown ownership. Cleanup does not remove worktrees/branches.

Local bootstrap/checks use their own durable process-group runner, not native
agent retirement. Escaped-descendant limitations are explicit; no stronger
containment is inferred from a PID or wrapper exit.

## Presentation

The same pending-cleanup policy is shared by controller, strip and background
projection. Shared diagnosis serves plan and goal status. A selected eligible
run governs actions; stale menus are revalidated against fresh registry state.

Only a matching locally observed lease with a recent successful poll earns live
presentation. Pending polls age into Snapshot. Native jobs-changed events are
coalesced refresh hints; the periodic controller remains the recovery fallback.
Native model/activity/usage projections are advisory.

View preferences use branch-relative Pi custom entries, not model context.
The inspector uses native selection/confirmation instead of replacing Pi's
editor/footer or inventing terminal attention events.

## Verification

Pure tests cover parsers, policy, identity, proof and rendering matrices.
Real native fixtures cover detached execution and recovery. Packed normal-loader
tests use an actual tarball, unmodified Pi/native dependencies, default readonly
review and a local scripted model. Agterm covers actual interactive rendering
and controls. These layers are complementary; substituted child-session fixtures
do not certify normal-loader or real-TUI behavior.

See [development](../DEVELOPMENT.md) for commands and
[UI validation](ui-validation.md) for measured evidence.
