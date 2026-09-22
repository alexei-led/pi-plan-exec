# Planless `/goal`

Status: implemented on `feat/autonomous-execution`; local gates and runtime smoke pass; validation and review pending.

## Purpose

`/goal <goal text>` pursues a goal autonomously without a plan file or checkbox
list. It reuses the autonomous plan-exec controller — registry, leases, owned
Bridge/Fusion operations, stop fences, recovery, review and final verification —
and adds only what is goal-specific: the turn loop, the worker outcome protocol,
check-based acceptance, stall detection, and blocker pauses.

## Model

- A goal run is the existing run record with `goal: { text, hash, iteration, noProgress, lastOutcome?, lastCheck? }`
  instead of `planPath`/`planHash`/`tasks`. `dependency planPath/planHash` are optional;
  plan-only paths call `requirePlanPath` and fail loudly when handed a goal run.
- Stage `implementation` is the goal loop. `advanceGoal` launches one owned worker
  turn per iteration; `finishGoal` parses the outcome and decides the next step.
  The existing pipeline after implementation is reused unchanged; `archive`
  transitions a goal straight to `complete`.
- The worker protocol is `<<<RALPHEX:GOAL_DONE>>>` for a completion claim,
  `<<<RALPHEX:TASK_FAILED>>>` plus `Blocker:`/`Next step:` for an external
  blocker, and any other final answer is an intermediate result that schedules
  the next turn.
- A completion claim is not acceptance. The controller runs the frozen
  `requiredChecks` on every turn; a claim with failing checks continues the
  loop. On green checks the run enters the normal review/finalize pipeline, and
  `completionPrerequisite` requires the verified commit to be HEAD with a clean
  tree.
- Progress is HEAD movement or a change in the check fingerprint. Three
  consecutive turns with neither pause the goal. `maxTaskIterations` is the
  turn budget.
- A diff guard pauses completion when the goal diff deletes test files or adds
  `skip`/`only` markers.
- Goal runs require at least one check at start (`--check "<command>"` overrides
  auto-detection) and a clean worktree; they run in place on the current branch.

## Commands

`/goal <text> [--check "cmd"]`, `/goal status [id]`, `/goal resume [id]`,
`/goal pause [id]`, `/goal cancel [id]`, `/goal help`.

## Acceptance

`/goal Fix the failing tests` in a repository with a failing test, with no plan
file: the goal investigates, fixes the test, commits, claims done, passes the
required checks and the configured verification, and completes. It continues
automatically after intermediate answers and stops only when achieved, stopped
by the user, or blocked.

Covered by `test/autonomous-goal.test.ts`: intermediate-answer continuation,
false done with failing checks, start refusal without checks, three-turn stall
pause, blocker resume, restart mid-turn without relaunch, deleted-test
completion guard, command parsing, and goal status/widget output.

## Explicitly excluded

- No second scheduler: the existing per-run controller tick drives goals.
- No plan requirement, checkbox acceptance, task DAG, or pi-tasks projection for goals.
- No separate goal registry, status, or LLM-verifier turn; checks and the
  existing review pipeline are the verification.
