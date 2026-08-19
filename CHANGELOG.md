# Changelog

## Unreleased

## 1.0.3 - 2026-08-19

- Restrict archive commits to literal archive paths so unrelated staged work is
  preserved.
- Recover after staged deletions, untracked plans, missing progress artifacts,
  and registry failures that occur after a successful archive commit.
- Serialize terminal progress deduplication and reject unsafe archive paths or
  concurrent controller lock takeovers.

## 1.0.2 - 2026-08-19

- Make archive retries idempotent after partial renames or staged commits.
- Protect plan-derived Git paths from pathspec magic and force-stage ignored
  progress artifacts.
- Deduplicate terminal progress records during recovery.

## 1.0.1 - 2026-08-10

- Require and request Fusion's `plan-review-v1` contract, consume only validated
  top-level `callerOutput.output`, and fail closed when it is absent.
- Treat Fusion as optional and fall back to the pi-subagents reviewer when its
  launch or replay response is unavailable or unusable.
- Preserve review operation identity and force-skip state during fallback.

## 1.0.0 - 2026-08-09

Breaking:

- Removed `/exec start`. Use `/exec <path/to/plan.md>`. Bare `/exec` opens the
  plan picker. The retired name stops with an error that names the replacement.
- Removed `/exec status --reconcile`. Use `/exec resume <full-run-id>`, which
  resets one named run and continues it. `/exec status` never writes.
  `/exec doctor --reconcile` still works for a scripted caller.

Added:

- `/exec stop` replaces the `pause`/`cancel` pair with one question: pause
  (resumable) or cancel (final, worktree preserved).
- `/exec cleanup` retires run records. It previews by default. `--apply`
  removes the registry entry — never the worktree, branch, or progress file —
  for terminal runs that finished more than 7 days ago. `failed` runs are
  excluded because their record is what `/exec resume` needs.
- Runs receive a durable `retiredAt` stamp on archive, and `/exec status` hides
  terminal runs older than a day unless `--all` is given.

Changed:

- Collapsed the read surface into `/exec status` and the recovery surface into
  `/exec resume`. `runs`, `doctor`, `setup`, `adopt`, `pause`, and `cancel`
  still dispatch as aliases and each names its replacement once in its output.
- Report worker liveness from live evidence instead of a frozen health record,
  judge a lease by both pid and whole hostname, and let a renamed machine
  diagnose and resume its own run.
- Bound an in-flight operation by the turn budget of its own stage, and report
  an overdue operation without claiming it is proof of a stuck worker.
- Rewrote recovery classifications and `/exec help` around the next action, and
  dropped internal state names from the run status view.
- Unpinned the printed Bridge setup version so a copied line is not a
  downgrade, and declared Prettier style for the repository.

## 0.4.5 - 2026-08-08

- Clear legacy recovery model pins on an explicit resume without changing a
  live tracked child, so future workers use the active Pi model.

## 0.4.4 - 2026-08-08

- Make `/exec resume` idempotently reconcile a running worker and automatically
  retry no-progress implementation work after an explicit resume.
- Recover model/provider failures with the current Pi model and make `--model`
  a one-replacement-child override instead of a durable role pin.
- Keep confirmation only for external/manual implementation blockers.

## 0.4.3 - 2026-08-08

- Preserve terminal Bridge diagnostics and failed operation identity for model
  and provider failures without consuming implementation retry attempts.
- Add `/exec resume --model current|provider/model`, an interactive recovery
  model picker, and durable role-specific model overrides for Bridge launches.
- Document model/provider recovery and clarify that `/exec` is a Pi UI command,
  not a shell command or agent tool.

## 0.4.2 - 2026-08-08

- Require `@alexeiled/pi-subagents-bridge` 0.2.2, which translates plan workers
  to the workflowScript-only public API introduced by `pi-subagents` 0.43.0.
- Probe the bridge workflow-spawn capability before creating or resuming a run
  so the incompatible 0.2.0–0.2.1 bridge releases fail during setup instead of
  after the first implementation launch.
- Read the single child output from workflow result artifacts so review findings
  and worker diagnostics are not replaced by the workflow summary.

## 0.4.1 - 2026-07-19

- Made `/exec status` classify recovery and give the next safe action for
  active, blocked, stale, mismatched, paused, cancellation, and terminal runs.
- Require explicit `--retry-task` before retrying exhausted or externally
  blocked implementation work; omitted run IDs now accept that option.
- Clarified changed-plan recovery and corrected stale failed-run guidance.

## 0.4.0 - 2026-07-18

- Fixed failed-fixer recovery so it reconciles a preserved operation before any
  retry, and never adopts a child it launched in the same resume call.
- Disabled the subagent mutation completion guard for review fixers; an
  independently verified false-positive finding may correctly need no edit.
- Added `/exec resume <full-run-id> --adopt-current-branch` for an interactive,
  repository-verified, audited recovery when the execution tree moved branches.
- Added `/exec skip <full-run-id> --reason <text>` for interactive, durable
  review/finalize/stats waivers. It stops tracked children before advancing,
  records the audit trail, and completes honestly with findings.
- Centralized persisted state-machine constants and added ESLint guards for
  magic runtime numbers and raw domain literals in control flow.

## 0.3.0 - 2026-07-16

- Made failed-run recovery preserve and reconcile operation identity before any
  retry, preventing duplicate Bridge workers after an uncertain launch or
  observation failure.
- Added safe recovery for Fusion result failures, failed review fixers,
  cancellation, archive persistence, corrupt registry siblings, and legacy run
  configuration.
- Added Bridge operation-lookup capability checks and now requires
  `@alexeiled/pi-subagents-bridge` `0.2.0` or later.
- Added durable recovery instructions to the shipped `exec-plan` skill.

## 0.2.2 - 2026-07-15

- Internal recovery and packaging fixes.

## 0.2.1 - 2026-07-15

- Added executable plan execution, review, worktree, and recovery workflow.
