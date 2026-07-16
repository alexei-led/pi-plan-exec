# Changelog

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
