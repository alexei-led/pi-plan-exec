# Autonomous runtime contracts

A run is admitted only when the selected runtime advertises explicit lifetime
support and ownership of every operation-owned descendant. Plan-exec 1.5 uses
only released packages: `pi-subagents@0.71.0` as the installed runtime,
`@alexeiled/pi-subagents-bridge@0.5.0`, and `@alexeiled/pi-fusion@0.9.3`. No Git
pins are required.

## Owned-process runner

Local checks, bootstrap commands, and the Revmux adapter run through
`src/owned-process.ts`, a POSIX process-group runner owned by plan-exec:

- `prepareOwnedProcess(request)` returns an immutable operation binding;
- `launchOwnedProcess(request)` starts the prepared operation as a detached
  process group and records the leader pid, start identity, host ID, and boot ID;
- `observeOwnedProcess(operationDirectory)` reports `pending`, `running`,
  `retired`, `never-started`, or `unknown`;
- `cancelOwnedProcess(operationDirectory, { deadlineMs, cancelled })` sends
  `SIGTERM` to the group, escalates to `SIGKILL`, and returns the observation;
- `requestOwnedProcessCancellation(operationDirectory)` sends `SIGTERM` without
  waiting.

The request binds `operationDirectory`, immutable `argv`, `cwd`, captured `env`,
and `lifetime: { kind: "unbounded" }` or `{ kind: "bounded", timeoutMs }`. The
binding includes operation ID, request digest, host ID, and boot ID. Retirement
proofs are `{ kind: "process-group-retired" }` for a dead group or
`{ kind: "never-started" }` for an operation that never reached a launch record;
both must match the binding. Malformed, changed, or host/boot-mismatched
operations stay fenced.

Liveness is ps-based: the recorded leader pid is checked with a zero signal and
its `ps -o lstart=` identity. A child that calls `setsid` or double-forks out of
the group escapes containment; that is the documented best-effort ceiling, and
the same ceiling the released runtime carries. The supported platform is any
POSIX host (Darwin or Linux).

Signal paths (`cancel`, cooperative cancellation, and the bounded-lifetime
timer) first prove the binding still belongs to this host and boot, that no
retirement was already persisted, and, when a start identity was recorded, that
the leader pid was not reused. Retirement is persisted once observed and
short-circuits every later signal. A successful launch keeps `launching.json`
as the durable launch lock, so a concurrent launcher observes instead of
spawning a second group. With no launch record and no `launch-failed.json`, an
unresolved claim is `pending` while fresh and fenced as `unknown` once stale;
it is never reported as `never-started`. A failed spawn records
`launch-failed.json` and releases the claim: local operations relaunch on the
next attempt, while the Revmux adapter reports `unknown` until the review is
cancelled.

## Released runtime and Bridge dependency

Bridge v2 requires `singleAgentSpawn: true`, explicit lifetime support, durable
operation lookup, terminal-proof support, and
`processTreeOwnership: { scope: "owned-process-tree", escapedDescendants:
"best-effort" }`.

The released `pi-subagents` runtime executes an async agent task as a
**persistent workflow host**: the parent run publishes no writer-exit proof.
Since 0.71.0, its targeted status includes `details.workflowTerminalProof`
only after dispatch closes and each async child has observed exit evidence or
a recorded `not-started` failure. Bridge 0.5.0 validates and forwards that
native proof; it no longer reconstructs one from child events or sidecar files.
Absent, pending, unknown, or malformed proofs cannot release ownership. A
closed terminal workflow without a native proof field yields an upgrade/status
artifact diagnostic rather than a claim that its process tree exited.

Fusion 0.9.3 supports ordinary panels and judges with this native runtime, but
plan-exec's strict Fusion review path requires durable native operations and
contained process-tree ownership that 0.71.0 does not provide. Selecting
`reviewBackend: "fusion"` fails preflight on this released stack; the default
subagent review backend remains available.

## Lifetime and recovery

The frozen run policy is either `{ "mode": "unbounded" }` or
`{ "mode": "bounded", "timeoutMs": <positive integer> }`. Local verification
and bootstrap commands use an unbounded owned-process operation and remain
user-stoppable, even when the run's model/review policy selects bounded mode.
For native model work, bridge unbounded mode omits the outer workflow deadline,
but `pi-subagents@0.71.0` may still apply a default timeout to its child. It
does not guarantee end-to-end unbounded execution.

For Bridge, native review, Fusion, and Revmux operations, bounded mode is an
explicit compatibility timeout. The controller only treats
`terminationReason: "execution_lifetime_expired"` plus full retirement proof as
a confirmed expiry and recent verified model/tool progress as evidence for a
continuation. It persists that fact and doubles the next bounded budget, up to
the native timer maximum, while changing the continuation strategy. The frozen
base policy is unchanged. A heartbeat, silence, unknown result, wrapper exit,
cancellation acknowledgement, or process-group snapshot never counts as
progress or expiry.

Control RPC deadlines remain finite. A lost reply does not establish whether a
child started or stopped. Lookup, replay, adoption, and cancellation retain the
same operation ID and immutable digest across restart.

Recovery records preserve ownership as well as lifetime. Ordinary native resume
cannot downgrade an owned run to the legacy launcher. Continuation uses a fresh
correlated owned operation after predecessor retirement. Owner-bound Bridge
lookup and cancellation use v2 even before a new client negotiates capabilities.

## Caller, native, and process identities

These identity namespaces are separate and must never be equated:

- the plan-exec caller digest covers the controller request and is sent through
  the provider owner/caller binding;
- the native operation has its own operation ID and native request digest;
- the owned-process binding has operation ID, request digest, host ID, and boot
  ID, and its retirement proof must match that binding.

The owner DTO is `{ kind: "pi-plan-exec", runId, key, requestDigest }`; the
request digest is the canonical digest of `{ cwd, params }`. A synthesized
workflow proof binds the parent run to the attested writer-exit proofs of its
children; the direct native process-terminal proof, when the runtime publishes
one, takes precedence.

## Review backends

The default review backend is one required Bridge/subagent reviewer with
`reviewFallback: []`. Fusion and Revmux are explicit backend selections, not
implicit safety fallbacks.

Fusion uses a structured panel graph with one judge and the
`plan-review-v1` caller-output contract. Strict early-agreement profiles are
currently unsupported and must be rejected before dispatch; they cannot be
treated as equivalent to the structured panel-plus-judge path. Fusion start,
lookup, result, and cancellation preserve the caller digest and operation ID.
Shared project admission serializes concurrent starts across Pi processes.
Writers must use the updated protocol; conflicting unknown legacy snapshots
remain visible and fenced rather than being discarded or replaced by age.

Revmux must support the explicit `--execution-lifetime=unbounded|bounded`
selection from [Revmux commit 988904f](https://github.com/umputun/revmux/pull/35/commits/988904f30da351e76c29d5779c6833a6bf890b51),
and the plan-exec adapter wraps it in the outer owned-process group. Revmux's
internal process-group proof is narrower and cannot satisfy the full ownership
contract by itself. Its report remains invalid unless source coverage, agent
health, findings, and unresolved questions all validate.

## Local commands and task prerequisites

Local required checks and bootstrap execute sequentially through the same
owned-process runner. They use immutable environment/argv, durable command
grants, the run's authorization and stop generation, and a process-group
retirement proof before success or failure is accepted. A missing result after
confirmed retirement is a confirmed command failure and may retry; malformed
identity or unknown retirement remains fenced. Controller Git commands route
through owned workspace commands with injected environment cleared at the
boundary; observations disable fsmonitor and optional index writes. The local
active-operation index keeps cancellation, cleanup, and exclusivity fenced until
process retirement is proven. The run registry itself uses an OS `flock` on a
compiled helper, not the process-group runner.

When a worker reports `<<<RALPHEX:TASK_FAILED>>>`, only an observed
`Prerequisite: credentials|permission|missing_executable|runtime` together with
an `Evidence:` line creates `waiting_external`. That state preserves the task,
records the evidence, and schedules an automatic wake. Generic blocker prose,
silence, elapsed time, or a guessed prerequisite remains ordinary recovery and
does not create an external-wait classification.

Native status, the Pi widget, pi-tasks, and Fleet are advisory projections of
`run.json`. Projection failure cannot block admission, recovery, or restart
ownership decisions.

`npm run test:runtime-smoke` is the declared host-boundary smoke check. Its
model turns are scripted; a passing smoke run is not a live-LLM guarantee. It
runs on any POSIX host, and its scripted worker is executed by a detached
released-runtime runner so the bridge must obtain a workflow terminal proof
(native in 0.71.0, or its compatibility fallback) for the run to complete. The main full gate covers the controller, Bridge
RPC, owned-process runner, required review, promotion, and archive.

## Source and review tracking

- Main draft: [pi-plan-exec #8](https://github.com/alexei-led/pi-plan-exec/pull/8).
- Revmux adapter evidence: [revmux #35](https://github.com/umputun/revmux/pull/35).
- Fusion dependency: [pi-fusion #12](https://github.com/alexei-led/pi-fusion/pull/12).
- Bridge dependency: [pi-subagents-bridge #2](https://github.com/alexei-led/pi-subagents-bridge/pull/2)
  and the workflow-proof synthesis in
  [pi-subagents-bridge #4](https://github.com/alexei-led/pi-subagents-bridge/pull/4).

The dependency pins are:

- native `pi-subagents`: released `^0.71.0`;
- Bridge: released `@alexeiled/pi-subagents-bridge@^0.5.0`;
- Fusion: released `@alexeiled/pi-fusion@^0.9.3`;
- Revmux: `988904f30da351e76c29d5779c6833a6bf890b51`;
- Pi SDK: `0.86.1`.

These are dependency evidence, not a claim that the full production pipeline is
complete. The implementation remains a release candidate; no production support
claim follows from host smoke checks or dependency test results alone.
