# Execution contract: complete on the released runtime

The operator explicitly removed the upstream-release prerequisite. Complete the
migration on pi-subagents 0.76.1 even if PR #2717 never merges. Keep all 1.8.0
force-stop/abandonment guarantees. No global installation, live registry
migration, release, push or new PR is authorized by this implementation pass.

## Decisions

- One normal launch shape: public async RPC spawn of a generated script awaiting
  one keyed `main` child. Fresh child context, controller-owned cwd/worktree,
  `mission: false`, controller-owned acceptance. Do not set child async:true:
  it returns a launch receipt instead of final output.
- Keep the wrapper because released workflows retain the originating tool-call
  identity and expose structured workflowChildren. Direct-leaf optimization is
  deferred. No second backend, feature toggle or runtime source import.
- Record the RPC UUID and immutable request before dispatch. Validate
  `workflowChildren.parentToolCallId === rpc-spawn-<uuid>` and its
  workflowRunId on recovery. Correlated started/completion events may speed
  binding; they do not replace durable state.
- Bound child output to a unique absolute path under the owning run directory.
  Do not guess report filenames, native IDs or paths from prose. Copy validated
  results/proofs before acceptance and handle retained legacy artifacts separately.
- The RunRegistry record is the durable operation ledger. No Bridge protocol,
  separate SQLite journal for NEW work, new scheduler, daemon or idempotency API.
- prepared -> dispatching -> bound -> retired. Claim dispatch before emit.
  Never emit another spawn for a dispatching/unknown operation. Only exact
  native retirement or proven local/native pre-dispatch non-start allows a new
  attempt.
- Missing/expired correlation or proof stays fenced with a useful status.
  This exceptional path does not block ordinary healthy operations or require
  installing an unpublished runtime.
- Observe retirement before attempting stop. Already-retired paused children
  need no successful stop RPC to end controller ownership. For live queued/
  paused RPC refusals, preserve stop intent and retry observation/delivery;
  force-stop can end management without claiming worker exit.
- No fabricated native lifetime/turn guarantees. An omitted workflow deadline
  does not remove native child defaults. Record requested vs observed limits,
  preserve supported bounded timeout behavior, and document unsupported legacy
  knobs rather than silently advertising enforcement.
- Preserve `abandoned`, ordinary CAS immutability, no autoresume/UI resurrection,
  active/failed unknown identities, quarantine reservations, controller/record
  lock ordering and fsynced backup/final archive before cleanup.
- Default agents must work in a clean consumer with only Pi, pi-subagents and
  this package. A small namespaced runtime reviewer registration through the
  public event API is permitted if the old short reviewer name is unavailable.
  Honor configured agents; never silently replace a user's frozen agent.

## Component ownership

Each component works in its own worktree and commits a bounded handoff. Shared
files may only be changed within the explicitly assigned contract. The integration
owner resolves cross-component conflicts and activates the native path.

### Native runtime component

Own `src/native-runtime.ts`, `src/operation-safety.ts`,
`test/native-runtime.test.ts`, `test/operation-safety.test.ts`.
Permitted narrow shared edits: new native metadata/service fields in
`src/types.ts` and their validation in `src/registry.ts`. Do not alter
controller, index, projection/owner-session fields or force-stop policy.

Export a small NativeRuntimeClient and operation metadata types. Constructor:
EventBus, existing RunRegistry, and a getter for the CURRENT ExtensionContext.
Never capture stale ctx across reload. Provide internal prepare, spawn,
operation, cancelOperation, status/result (observation), stop and dispose seams.
Method names can follow the existing controller service shape; no second RPC
service or claimed Bridge v2 protocol.

prepare creates the immutable native metadata/request before the controller
persists it. spawn re-reads the current authorized operation, CAS-claims
dispatching and sends exactly that request. Bind observations with fresh CAS
while preserving newer stop intent; abandoned records reject ordinary writes.
Use separate predicates for dispatch authorization and binding an already-started
child. Preserve ambiguity rather than invent absence proof.

Use public native RPC and documented JSON artifacts/structured DTOs only.
The current local bridge.ts pure proof/digest helpers may be imported temporarily;
the integration owner moves reusable helpers before deleting that client.
Do not duplicate the whole Bridge implementation. Return exact API/type examples
in the handoff so the integration owner need not guess.

### Projection-removal component

Own pi-tasks projection removal: `src/task-projection.ts`, projection-only
slices of `src/index.ts`, `src/registry.ts`, `src/types.ts`,
`src/runtime-integration.ts`, `src/run-view.ts` and related tests.
Do NOT change native transport/controller launch semantics, manifests or docs.

Extract run.tasks-derived summaries into a small dependency-free helper.
Remove TaskStore imports, cache queues/writes and degraded-cache UI.
Preserve Fleet/bg_wait/view behavior and force-stop suppression.
Replace new-run projection-based session ownership with an explicit owner field.
Retain narrowly validated READ-ONLY migration of old taskProjection.sessionId
where needed for old history; no foreign file writes or extra cache.

Replace old projection-driven CAS/retention test triggers with real permitted
registry metadata/lease writes; do not delete the concurrency/retention assertions.
Parent removes the manifest dependencies after all components integrate.

### Legacy-reader component

Own `src/legacy-operation.ts` and `test/legacy-operation.test.ts` only.
Expose a bounded read-only schema-7 Bridge operation lookup with expected
operation ID, run owner and original digest. Use built-in node:sqlite readOnly;
never instantiate Bridge's mutating journal or create missing DBs.

Return explicit found/missing/unavailable/incompatible/mismatch results.
Found means identity mapping, NOT proof of retirement or launch absence.
Preserve native RPC/run IDs, paths, original params/digests, cancellation intent,
delivery receipt and rejection evidence. No task-only row migration, speculative
old schemas, status-text parsing or new dispatch. Do not mutate run records;
parent controls explicit adoption and abandoned-state protections.

### Result/review component

Own additive typed native result/review support in `src/artifact.ts`,
`src/review.ts`, `test/artifact.test.ts`, `test/review.test.ts`.
Keep existing legacy decoders working; parent selects the new path on integration.

Export the minimal JSON schema and semantic validator for:
schemaVersion=1, reviewedCommit and findings[] (severity, summary, evidence,
suggestion). Bind the expected commit and reject empty/malformed/contradictory
data. No separate redundant verdict flag. Empty findings is clean only after
controller success/proof validation.

Support explicit caller-bound file/result references and structuredOutput from
the selected one-child workflow. Validate root/child/key identity when decoding
native envelopes; never treat launch receipts, summaries, truncated text or
missing data as a review pass. Preserve worker/goal marker behavior.

## Integration owner

After handoffs: integrate into controller/index, add runtime role registration
if needed, move shared proof helpers, implement explicit legacy adoption,
remove BridgeClient and both package dependencies/lock entries, update fixtures,
normal-loader/packed-consumer tests and user docs. Keep manifests stable until
replacement tests exist. One mutator in the integration worktree.

The integration worktree can contain parent-owned briefing-only commits after
272c81c; verify the common base and clean source rather than discarding them.

Normal-loader safety check: background children load ambient extensions. Current
index.ts auto-restores any claimable contextual run, with no child guard. The
0.76.1 runner sets PI_SUBAGENT_CHILD=1 before loading those extensions and makes
its own ambient entry point inert. Reproduce child-mode startup before activating
our controller there; add a small inert-child guard/test if confirmed. Do not
disable all ambient extensions, which would break custom model/MCP providers.
Do not import private native modules to read this environment marker.

Run the existing complete suite plus selected native RPC/recovery smoke and
a clean packed consumer without removed packages. Map the plan's scenarios to
actual tests and explicit safe limitations. Do not mark a checkbox on prose alone.
Task headings/checkmarks remain in plan.md; this file records the revised
implementation contract, not a second task queue.
