# Changelog

## Unreleased

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
