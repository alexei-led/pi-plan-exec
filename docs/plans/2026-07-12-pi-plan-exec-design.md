# Pi Plan Exec Design

<!-- markdownlint-disable MD013 -->

Status: agreed design; implementation not started

## Problem

Adapt the upstream ralphex `/exec` workflow from [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz/tree/master/plugins/planning/skills/exec) to Pi.

The upstream workflow is a 13-step plan executor. It runs ordered implementation tasks in fresh agent contexts, checks plan checkboxes rather than trusting agent claims, performs several review/fix phases, finalizes the branch, reports statistics, and archives the completed plan.

A prompt-only port is not reliable enough. Stage order, retry limits, crash recovery, cross-session adoption, worktree safety, and conditional review loops must be code-owned and testable.

## Goals

- Preserve the upstream 13-stage behavior for Git repositories.
- Execute exactly one writer at a time in one shared execution worktree.
- Use fresh Pi subagents for every implementation, fix, review, finalization, and stats operation.
- Reuse pi-tasks, pi-subagents, pi-subagents-bridge, and pi-fusion instead of duplicating them.
- Resume safely after Pi restarts and adopt runs from another Pi session.
- Prevent duplicate writers after crashes or retries.
- Keep plan checkboxes as the implementation-progress source of truth.
- Provide deterministic, unit-testable transitions and retry caps.

## Non-goals

- Mercurial support.
- A new task manager, subagent runtime, or model panel implementation.
- A dependency on cc-thingz agents.
- Parallel implementation tasks.
- Automatic push or merge.
- Guaranteed identical model output across runs.

## Package Shape

`pi-plan-exec` is a standalone Pi package.

```text
package.json
src/
  index.ts                 # Pi command and controller wiring
  controller.ts            # background run controller
  transition.ts            # pure state transition logic
  registry.ts              # global run registry and leases
  plan.ts                  # strict compatible plan parser
  git.ts                   # repository, branch, and worktree safety
  config.ts                # layered config and frozen run config
  adapters/
    bridge.ts              # generic pi-subagents-bridge RPC client
    fusion.ts              # pi-fusion RPC client
    pi-tasks.ts            # optimistic internal TaskStore adapter
  prompts.ts               # override resolution and placeholder expansion
skills/exec-plan/SKILL.md  # model-facing usage and policy
references/
  prompts/                  # task, review, fixer, finalizer, stats
  reviewers/               # specialist review instructions
```

No TypeScript code executes or reviews user code directly. The controller only chooses legal transitions and invokes existing execution services.

## Ownership

### pi-plan-exec

Owns:

- `/exec` commands and interactive worktree choice.
- Strict plan parsing and canonical task identity.
- Git branch/worktree validation.
- The 13-stage state machine.
- Retry counters and conditional review/fix loops.
- The global run registry, controller lease, and cross-session adoption.
- Durable operation IDs.
- Projection into pi-tasks.
- Progress logging, completion state, and plan archival policy.

Does not own:

- Agent execution.
- Agent catalogs or model providers.
- Task UI implementation.
- Multi-model panel execution.

### pi-subagents-bridge

Promote the bridge from a pi-tasks compatibility adapter to the supported execution facade for plan-exec while preserving its existing protocol.

Add a generic, versioned RPC that owns:

- Single and parallel pi-subagents spawn requests.
- Forwarding `cwd`, agent, model, context, limits, timeout, and worktree options.
- Agent alias resolution.
- Completion polling and result-file handling.
- Structured normalization of completed, failed, stopped, timed-out, and malformed results.
- Cross-session observation/adoption of an existing run ID.
- Persistent idempotency by caller-provided `operationId`.

Proposed methods:

```text
ping
spawn
status
adopt
result
stop
```

`spawn` accepts either one agent request or a pi-subagents parallel request. Retrying the same durable `operationId` returns the existing run instead of launching another.

The bridge persists operation-to-run mappings atomically. Its current in-memory request cache is insufficient for process crashes.

Cross-session stop may be rejected by pi-subagents. The bridge reports this explicitly; it must not bypass the ownership guard by killing an unverified process.

### pi-subagents

Owns:

- Fresh child sessions.
- Built-in `worker` and `reviewer` agents.
- Model execution.
- Parallel review groups.
- Child artifacts and runtime status.
- Per-child worktree support for isolated reviewers.

Plan-exec uses these built-ins:

- `worker`: implementation, fixes, and finalization.
- `reviewer`: specialist reviews and stats.

Every invocation uses a fresh context. Agent and model settings are configurable by role. When no model is specified, pi-subagents' configured agent default is used.

### pi-fusion

Owns the adversarial external review phase.

Add a machine-readable, versioned RPC with:

```text
ping
start
status
adopt
result
cancel
```

Requirements:

- `start` accepts a durable `operationId` and is idempotent across restarts.
- Status and result responses are structured.
- Runs persist outside one Pi session and can resume between panel and judge phases.
- Results include the full report, normalized findings/severities, and artifact paths.
- Foreign-session cancellation limitations are explicit.

Plan-exec does not reproduce panel, judge, profile, or model-selection logic.

### pi-tasks

Owns its existing task data format, DAG behavior, locking, and widget.

Pi-tasks has no cross-extension CRUD RPC and cannot be changed. Plan-exec therefore uses a version-aware adapter around the shipped internal `TaskStore`.

Policy:

- Target and test one exact pi-tasks version.
- Warn, but do not fail solely because a newer version is installed.
- Run capability and data-shape probes against newer versions.
- Continue when the required contract is compatible.
- Pause on an actual adapter or store-operation failure.
- Never rewrite an unknown task format.

Pi-tasks is a per-session projection, not authoritative plan-exec state. On cross-session adoption, plan-exec rebuilds task rows in the new session with stable plan-exec run and stage IDs in metadata.

## Authoritative State

The authoritative registry lives under:

```text
~/.pi/plan-exec/runs/<run-id>/run.json
```

Writes use a lock plus temporary-file rename. One controller lease may own a run at a time.

Minimum run state:

```ts
interface PlanExecRun {
  schemaVersion: number;
  runId: string;
  repositoryRoot: string;
  planPath: string;
  planStructureHash: string;
  worktreeCwd: string;
  branch: string;
  defaultBranch: string;
  status:
    | "starting"
    | "running"
    | "pausing"
    | "paused"
    | "cancel_pending"
    | "cancelled"
    | "failed"
    | "completed"
    | "completed_with_findings";
  stage: string;
  attemptsByStage: Record<string, number>;
  activeOperation?: {
    operationId: string;
    service: "bridge" | "fusion";
    externalRunId?: string;
    state: "intended" | "active" | "terminal";
  };
  unresolvedFindings: Finding[];
  frozenConfig: ResolvedConfig;
  promptHashes: Record<string, string>;
  lease?: {
    sessionId: string;
    pid: number;
    heartbeatAt: number;
  };
  createdAt: number;
  updatedAt: number;
}
```

`planStructureHash` canonicalizes task headings and checkbox text while ignoring checked/unchecked state. Checkbox updates are expected. Other task-structure changes pause the run for user review.

The plan file inside the execution worktree is the implementation-progress source of truth. The registry is the orchestration source of truth. Pi-tasks is the UI projection.

## Public Interface

```text
/exec [plan]          Start a run; select a plan when omitted
/exec status [run]    Show stage, child, retries, findings, and worktree
/exec pause [run]     Finish the active operation, then stop advancing
/exec resume [run]    Resume a paused run
/exec cancel [run]    Stop when safe and preserve the worktree
/exec adopt [run]     Claim a stale or released run from another Pi session
/exec runs            List active, paused, blocked, and recent runs
```

Starting a second run for the same plan/worktree is rejected.

A run starts in the background after validation and the required worktree question. Status remains visible through `/exec status` and projected pi-tasks rows.

## Configuration and Overrides

Resolution order:

```text
project: .pi/plan-exec/
user:    ~/.pi/agent/plan-exec/
bundle:  package defaults
```

Configuration includes:

```text
plansDir                   default docs/plans/
taskRetries               default 1
maxTaskIterations         default 50
reviewIterations          default 5
fusionIterations          default 10
finalizeEnabled           default true
fusionProfile
roles.worker.agent/model/maxTurns
roles.reviewer.agent/model/maxTurns
roles.stats.agent/model/maxTurns
specialist reviewer overrides
```

Defaults use pi-subagents `worker` and `reviewer`. Explicit models are optional. The fully resolved role configuration, limits, prompt hashes, and rules hash are frozen into the run record. Adoption never silently changes them mid-run.

## Plan Contract

Accept the upstream-compatible subset:

```markdown
### Task 1: Title

- [ ] Required outcome
- [ ] Verification
```

`### Iteration N:` is also accepted.

Reject before any mutation:

- No runnable tasks.
- Duplicate task/iteration numbers.
- Task sections without checkboxes.
- Malformed or ambiguous ordering.
- Unsupported structural edits to a running plan.

## Git and Worktree Policy

V1 supports Git only.

The user is always asked whether to execute in place or in an isolated worktree. Auto mode does not skip this question.

Before every writer operation, verify:

- `cwd` is the recorded repository/worktree root.
- The worktree belongs to the expected repository.
- The expected branch is checked out.
- No unresolved Git operation makes the next write unsafe.

A selected worktree must not silently omit relevant dirty state:

- A tracked modified plan must be committed or executed in place.
- An untracked plan may be copied explicitly into the new worktree.
- Other dirty state is reported; the user chooses in-place execution or abort.

When already on a feature branch, isolated execution creates a derived branch from the current HEAD rather than attempting to check out one branch in two worktrees.

No operation pushes or merges.

## Thirteen Stages

### 1. Resolve plan

- Resolve a supplied path or select from `plansDir`, excluding `completed/`.
- Parse and validate the plan.
- Detect repository root and default branch.
- Resolve and freeze config, prompts, rules, agents, and model overrides.

### 2. Ask isolation

- Inspect current branch and dirty state.
- Always ask in-place versus isolated worktree.
- Create and verify the selected execution location.

### 3. Project task list

Create one pi-task row per implementation section, then rows for:

- Comprehensive review.
- Smells review.
- Fusion review.
- Critical review.
- Finalization.
- Stats.

Rows carry plan-exec run/stage IDs in metadata. They mirror controller state.

### 4. Create branch

Derive the branch from the plan filename, stripping a date prefix. Stay on an existing feature branch for in-place execution; use a safe derived branch for isolated execution.

### 5. Initialize progress

Create the progress artifact and record its path in the run. All later progress appends use one controlled helper.

### 6. Sequential implementation loop

Until no unchecked boxes remain:

1. Re-read and parse the plan.
2. Select the first task section with unchecked boxes.
3. Persist operation intent with a durable operation ID.
4. Ask the bridge to launch exactly one fresh `worker` in the shared execution `cwd`.
5. Wait asynchronously for normalized terminal state.
6. Re-read the plan; never trust success text alone.
7. Require the task changes, checkbox updates, and commit to be complete.
8. Retry with a fresh worker when needed.

Stop on exhausted task retries or after 50 task-loop iterations by default.

No implementation tasks run in parallel.

### 7. Comprehensive review loop

Iteration one launches five `reviewer` children in one bridge-managed parallel run:

- Quality.
- Implementation correctness.
- Testing.
- Simplification.
- Documentation.

Later iterations launch quality and implementation critical re-checks only.

Reviewers run in isolated per-child worktrees so their configured write-capable tools cannot mutate the execution worktree. Review prompts explicitly require review-only behavior.

Collect complete outputs without filtering. If findings exist, pass the unedited outputs to one fresh `worker` fixer in the execution worktree. Re-review up to `reviewIterations`.

### 8. Smells review

Run one isolated `reviewer` with the smells contract. Pass complete findings to one fresh worker fixer when needed. Run once.

### 9. Fusion review loop

Start an idempotent pi-fusion run using the configured profile. Give Fusion the plan, progress, default branch, and diff contract.

Pass the complete judged report to a worker fixer. Re-run while CRITICAL or MAJOR findings remain, up to `fusionIterations`. Minor-only findings are fixed once without another Fusion round.

### 10. Critical review

Launch quality and implementation reviewers in parallel, restricted to CRITICAL and MAJOR findings. Pass complete findings to one worker fixer. Run one pass.

### 11. Finalize

When enabled, launch one worker to rebase, clean commits, and verify. This stage is best-effort. Failure is recorded but does not erase prior implementation/review results.

### 12. Stats

Launch one isolated reviewer with the stats contract. It aggregates Pi and subagent artifacts plus Git churn and returns compact Markdown. This stage is best-effort.

### 13. Complete

- Append terminal progress.
- Move the plan to its sibling `completed/` directory and commit the move, best effort.
- Preserve the execution worktree and branch for review/merge.
- Report final task count, branch, worktree, findings, and best-effort failures.

If known findings survive review caps, use `completed_with_findings`. Do not claim that reviews passed.

## Agent Output Contracts

Implementation completion is determined from plan state and Git state, not worker prose.

Review prompts return a structured envelope containing:

```text
finding ID
severity: CRITICAL | MAJOR | MINOR
summary
file and line evidence
reason
suggested correction
```

The raw response is retained and passed unchanged to fixers. Structured parsing controls loop decisions only.

Malformed review/Fusion output is an infrastructure/protocol failure, never a clean review.

## Failure Semantics

Before mutation, stop on:

- Missing required package or RPC capability.
- Invalid plan/config.
- Unsupported Git state.
- Incompatible pi-tasks adapter contract.

During execution:

- Worker failure or unchanged checkboxes: retry, then fail the run on exhaustion.
- Dirty/uncommitted worker result: retry with instructions to complete and commit.
- Reviewer/Fusion malformed result: retry once, then pause.
- Known review findings after a configured cap: continue and preserve unresolved findings.
- Pi-tasks projection failure: pause; do not corrupt or discard registry state.
- Finalizer, stats, and plan move failures: record and continue.

## Pause, Cancel, and Adoption

- `pause` lets the active external operation finish and prevents the next transition.
- `cancel` requests stop when allowed and otherwise becomes `cancel_pending`.
- The execution worktree is preserved on pause, failure, or cancellation.
- A lease heartbeat prevents two controllers from advancing one run.
- Adoption is allowed only after the previous lease is stale or released.
- When an old-session child remains active, the bridge adopts and observes it. The new controller does not launch a replacement.
- A foreign-session child that cannot be interrupted must terminate before pause/cancel completes.

## Crash Safety

Before an external start:

1. Persist transition intent and `operationId`.
2. Call bridge or Fusion RPC with that operation ID.
3. Persist the returned external run ID.

If the controller dies between these steps, it repeats the same operation ID. The service returns the existing run.

This idempotency is required in both the bridge and Fusion. An in-memory cache alone does not prevent duplicate writers after process restart.

## Testing Strategy

### Unit tests

- Strict plan parser table.
- Every legal and illegal transition.
- Task, review, and Fusion retry caps.
- `completed` versus `completed_with_findings`.
- Pause, cancel-pending, stale lease, and adoption.
- Worktree identity and branch safety.
- Config resolution and frozen hashes.

### Bridge contract tests

- Forward `cwd`, model, context, timeout, limits, and worktree options.
- Single worker and parallel reviewer roots.
- Persistent operation-ID deduplication across restart.
- Normalize every terminal and malformed result state.
- Adopt an old-session run.
- Live opt-in probe: a harmless child reports `pwd`, which must equal the requested worktree.

### Fusion contract tests

- Idempotent start.
- Structured status and result.
- Persistence and cross-session adoption.
- Crash between panel and judge.
- Invalid severity output.
- Foreign-session cancellation behavior.

### Pi-tasks adapter tests

- Exact supported-version contract.
- Newer-version warning plus capability probe.
- Existing atomic store and lock behavior.
- Projection rebuild in a new session.
- Projection never becomes authoritative controller state.

### End-to-end tests

Use temporary Git repositories and fake bridge/Fusion services:

- Full happy path.
- Dirty checkout and untracked plan.
- Crash before and after spawn.
- Crash after child completion but before checkpoint.
- Cross-session adoption with a running worker.
- Missing checkbox update.
- Malformed review output.
- Exhausted findings with `completed_with_findings`.
- Finalizer, stats, and archive failures.
- Assertion that two writer operations never overlap in one worktree.

Live-model tests remain opt-in because they cost money and are provider-dependent.

## Key Decisions

- Full ralphex stage parity, Git only.
- Minimal TypeScript state machine; no prompt-owned control flow.
- Background execution with explicit control commands.
- Full cross-session adoption.
- Always ask about worktree isolation.
- One shared writer worktree; no parallel implementation.
- Use pi-subagents built-in `worker` and `reviewer`; no cc-thingz dependency.
- Extend pi-subagents-bridge into the execution facade.
- Add machine-readable, resumable pi-fusion RPC.
- Do not modify pi-tasks; use an optimistic version-aware internal adapter.
- Global registry is authoritative; pi-tasks is a per-session projection.
- Plan checkboxes remain implementation-progress truth.
- Continue after review caps like upstream, but report unresolved findings honestly.
- Use pi-subagents model defaults unless explicitly overridden.
