# Autonomous runtime contracts

A run is admitted only when the selected runtime advertises explicit lifetime
support and ownership of every operation-owned descendant. Plan-exec 1.5 uses
only released packages: `pi-subagents@0.70.1` as the installed runtime,
`@alexeiled/pi-subagents-bridge@0.4.2`, and `@alexeiled/pi-fusion@0.9.2`. No Git
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

## Released runtime and Bridge dependency

Bridge v2 requires `singleAgentSpawn: true`, explicit lifetime support, durable
operation lookup, terminal-proof support, and
`processTreeOwnership: { scope: "owned-process-tree", escapedDescendants:
"best-effort" }`.

The released `pi-subagents` runtime executes an async agent task as a
**persistent workflow host**: the parent run publishes no writer-exit proof, and
only child runs write `process-terminal.json`. Bridge 0.4.2 therefore
synthesizes a workflow terminal proof when the status reply carries a
`workflowChildren` summary with a matching `workflowRunId`,
`inventoryComplete: true`, a terminal `workflowState` (`completed`, `failed`, or
`stopped`), and every child has an attested process-terminal proof. Child proofs
come from the cached `subagent:process-terminal` event or, on a cache miss, from
the child's `process-terminal.json` next to the parent's async directory. A
partial or open inventory yields no proof and plan-exec keeps polling.

## Lifetime and recovery

The frozen run policy is either `{ "mode": "unbounded" }` or
`{ "mode": "bounded", "timeoutMs": <positive integer> }`. Unbounded means no
wall-clock deadline. Local verification and bootstrap commands always use an
unbounded owned-process operation and remain user-stoppable, even when the run's
model/review policy selects bounded compatibility mode.

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
released-runtime runner so the bridge must synthesize the workflow terminal
proof for the run to complete. The main full gate covers the controller, Bridge
RPC, owned-process runner, required review, promotion, and archive.

## Source and review tracking

- Main draft: [pi-plan-exec #8](https://github.com/alexei-led/pi-plan-exec/pull/8).
- Revmux adapter evidence: [revmux #35](https://github.com/umputun/revmux/pull/35).
- Fusion dependency: [pi-fusion #12](https://github.com/alexei-led/pi-fusion/pull/12).
- Bridge dependency: [pi-subagents-bridge #2](https://github.com/alexei-led/pi-subagents-bridge/pull/2)
  and the workflow-proof synthesis in
  [pi-subagents-bridge #4](https://github.com/alexei-led/pi-subagents-bridge/pull/4).

The dependency pins are:

- native `pi-subagents`: released `^0.70.1`;
- Bridge: released `@alexeiled/pi-subagents-bridge@^0.4.2`;
- Fusion: released `@alexeiled/pi-fusion@^0.9.2`;
- Revmux: `988904f30da351e76c29d5779c6833a6bf890b51`;
- Pi SDK: `0.86.1`.

These are dependency evidence, not a claim that the full production pipeline is
complete. The implementation remains a release candidate; no production support
claim follows from host smoke checks or dependency test results alone.
