# Autonomous runtime contracts

A run is admitted
only when the selected runtime advertises explicit lifetime support and full
ownership of every operation-owned descendant. The current installed npm
package does not provide the new public native contract. The pre-release source
pins are recorded below; do not infer support from a latest npm release or an
unpinned local checkout.

## Native production dependency

The required native dependency is the public
`pi-subagents/kernel-owned-process` module. Its production API is the durable
kernel-owned process boundary used by local checks, bootstrap, Bridge/native
workers, Fusion, and the Revmux adapter:

- `prepareKernelOwnedProcess(request)` returns an immutable operation binding;
- `launchKernelOwnedProcess(request)` starts the already prepared operation;
- `observeKernelOwnedProcess(operationDirectory)` reports a bound operation;
- `reconcileKernelOwnedProcess(operationDirectory)` recovers the same prepared
  operation without replacing its immutable identity;
- `cancelKernelOwnedProcess(operationDirectory, { deadlineMs })` requests
  retirement and returns proof or an unknown result;
- `requestKernelOwnedProcessCancellation(operationDirectory)` records a durable
  stop request.

The request binds `operationDirectory`, artifact storage, immutable `argv`,
`cwd`, captured `env`, and `lifetime: { kind: "unbounded" }` or
`{ kind: "bounded", timeoutMs }`. The binding includes operation ID, request
digest, host ID, and boot ID. A successful operation requires an authoritative
kernel retirement proof for the same binding. Unknown, malformed, or changed
bindings remain fenced and cannot be retried as a new writer.

The supported native target is Darwin with a GUI launchd session and the
compiler/toolchain prerequisites required by the native ownership module. The
current branch does not claim Linux or headless Darwin support. The exact local
or project installation path must preserve the pinned source refs and must not
change global npm configuration; npm 12.0.2 is required for transitive Git refs.
The repository checkout uses project-local `allow-git=root`; a packed consumer
uses project-local `allow-git=all`.
No published npm version should be treated as satisfying this contract.

## Lifetime and recovery

The frozen run policy is either `{ "mode": "unbounded" }` or
`{ "mode": "bounded", "timeoutMs": <positive integer> }`. Unbounded means no
wall-clock deadline. Local verification and bootstrap commands always use an
unbounded kernel-owned operation and remain user-stoppable, even when the run's
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

## Caller, native, and kernel identities

These identity namespaces are separate and must never be equated:

- the plan-exec caller digest covers the controller request and is sent through
  the provider owner/caller binding;
- the native operation has its own operation ID and native request digest;
- the kernel binding has operation ID, request digest, host ID, and boot ID, and
  its retirement proof must match that binding.

Bridge v2 requires `singleAgentSpawn: true`, explicit lifetime support, durable
operation lookup, terminal proof support, and
`processTreeOwnership: { scope: "owned-process-tree", escapedDescendants:
"contained" }`.
The owner DTO is `{ kind: "pi-plan-exec", runId, key, requestDigest }`; the
request digest is the canonical digest of `{ cwd, params }`. A Bridge proof must
bind the caller, native operation, and kernel retirement evidence.

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
and the plan-exec adapter must wrap it in the outer kernel-owned process
boundary. Revmux's internal process-group proof is narrower and cannot satisfy
the full ownership contract by itself. Its report remains invalid unless source
coverage, agent health, findings, and unresolved questions all validate.

## Local commands and task prerequisites

Local required checks and bootstrap execute sequentially through the same kernel
boundary. They use immutable environment/argv, durable command grants, the
run's authorization and stop generation, and a kernel retirement proof before
success or failure is accepted. A missing result after confirmed retirement is
a confirmed command failure and may retry; malformed identity or unknown
retirement remains fenced. Controller Git commands route through owned workspace
commands with injected environment cleared at the boundary; observations disable
fsmonitor and optional index writes. The local active-operation index keeps
cancellation, cleanup, and exclusivity fenced until kernel retirement is proven.

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
model turns are scripted; a passing smoke run is not a live-LLM guarantee. A
Darwin host with the native GUI/compiler prerequisites is required for the
supported path. The full pipeline passed on the final dependency pins. The
main full gate passed all 537 tests, lint, TypeScript and package validation,
including optional skip races and frozen candidate checkouts, and
`npm run test:runtime-smoke` passed the installed controller, Bridge/native RPC,
owned workers, required review, promotion and archive. The cumulative Revmux
confirmation remains pending.

## Source and review tracking

- Main draft: [pi-plan-exec #8](https://github.com/alexei-led/pi-plan-exec/pull/8).
- Revmux adapter evidence: [revmux #35](https://github.com/umputun/revmux/pull/35).
- Fusion dependency: [pi-fusion #12](https://github.com/alexei-led/pi-fusion/pull/12).
- Native runtime: [pi-subagents #2376](https://github.com/nicobailon/pi-subagents/pull/2376).
- Bridge dependency: [pi-subagents-bridge #2](https://github.com/alexei-led/pi-subagents-bridge/pull/2).

The source pins currently under review are:

- native `pi-subagents`: `e78595340ff36ad481e205c0872fadba9412227d`;
- Bridge: `3e99ec2752a25c88cc75475db524c44f3157f69d`;
- Fusion: `b113212469bb5d2d0ad7bb5ff98e7cec12e25c7e`;
- Revmux: `988904f30da351e76c29d5779c6833a6bf890b51`;
- Pi SDK: `0.86.1`.

Reported dependency checks are native 3337/3361 unit and 1101/1109 integration
tests with the 10 unit and 1 integration failure reproduced unchanged on the
prior revision as Darwin environment failures (`/var` canonicalization and
unix-socket `EINVAL`), seven actual owned-worktree cases, Bridge 72 tests
plus delayed-admission/restart/cancel and exact-checkout smoke, Fusion 258 unit,
132 integration, and one E2E, and the Revmux full Go gates. These are dependency
evidence, not a claim that the main product gate or full production pipeline is
complete.

Local project checks have passed. Revmux's upstream Ubuntu CI requires
maintainer approval and has executed no jobs; its Linux path is
compile-verified, while Darwin runtime tests passed. The
cumulative Revmux confirmation is still pending. The
implementation remains draft; no release or production support claim follows
from host smoke checks or dependency test results alone.
