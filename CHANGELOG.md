# Changelog

## 1.8.0 - 2026-10-06

### Changed

- `/exec stop` now requests final cancellation without a pause-or-cancel dialog.
  Use `/exec pause` for resumable work, and `/exec ui on|off` for display only.
  Legacy cancel/hide/show/clear commands remain supported.
- `/exec stop <full-run-id> --force` permanently abandons controller management,
  including legacy unknown launches. No automatic retries, restoration or
  resume follow abandonment. The run disappears from progress displays and
  the default status list, including other open observing sessions.
- Force-stop attempts cancellation only for the exact tracked ownership.
  Unknown workers are not reported as stopped; their operation evidence and
  checkout reservations remain. A live foreign controller refuses the action.
- Eligible registry artifacts are removed only after controller quiescence and
  flushed backups. Worktrees, branches, progress files and provider journals
  are preserved. Repeat the command to retry partial cleanup.
- Late callbacks cannot revive abandoned runs or report successful completion.
  Pending archive mutations recheck stop authorization.

### Upgrade

- Restart every Pi session sharing the registry after upgrading. Change scripts that relied on the old stop
  chooser to `/exec pause` for resumable stops.
- Force-stop is irreversible abandonment, not recovery or proof of worker
  death. Inspect retained records by full ID or `status --all`; do not
  downgrade or use older cleanup while abandoned records remain: older versions
  reject the new status but their corrupt-record cleanup can erase its reservation.
- No dependency upgrade or live journal migration is required.

[Full changes](https://github.com/alexei-led/pi-plan-exec/compare/v1.7.1...v1.8.0)

## 1.7.1 - 2026-10-06

### Fixed

- Show paused operations as paused, not working. Keep active work visible when
  another task waits on an external prerequisite.
- Preserve user-pause intent in recovery guidance, including stale and
  renamed-host leases. A paused state no longer implies a supervisor question.
- Keep execution state visible alongside the Snapshot qualifier, including
  pending cancellation and pause cleanup.
- Log stage transitions only after their saved state changes successfully.
- Preserve completion and cancellation cleanup timestamps across task-projection
  repair and lease release. Older final records keep their previous cleanup age.

### Documentation

- Describe Fusion 0.9.3 as the tested baseline, not the current version.
  Strict review compatibility depends on advertised runtime capabilities.

### Upgrade

- Restart Pi after updating plan-exec. Dependencies and dispatch/retry policy
  are unchanged. Bridge and native background-work registration are unchanged.

[Full changes](https://github.com/alexei-led/pi-plan-exec/compare/v1.7.0...v1.7.1)

## 1.7.0 - 2026-10-06

### Added

- Compact, theme-aware progress strip with status-colored progress and accepted
  task counts. Locally observed work and completion are green; unpolled
  in-flight runs are amber snapshots, not claims of worker health.
- `/exec hide`, `show [run-id]`, and `clear [run-id]` display controls without
  `--apply`. They do not stop workers or delete recovery evidence. Preferences
  follow the active transcript branch and survive reload.
- On-demand worker lifetime, review backend and bounded advisory activity in
  `/exec status`. Advisory telemetry is not verified progress or retirement proof.

### Fixed

- Retry stop delivery after intent-only acknowledgements and late child binding.
  Preserve correlated cancellation refusals across successful observations and
  restart; distinguish delivered stops from confirmed worker exit.
- Keep recovery history and progress logging independent. Logging no longer
  recreates a deleted execution checkout.
- Keep background-work tracking independent of optional task/Fleet failures.
  Use native transcript-path identity, bound terminal display retention, reject
  stale snapshots, and handle no-session projection explicitly.
- Avoid redundant worktree handoff for path aliases and nonexistent fresh-session
  transcripts. Preserve stop-state precedence and task retry waits in the strip.
- Read colors from the active Pi theme, fit narrow terminals, and remove terminal
  escape and bidirectional control characters from display titles.

### Upgrade and limits

- Use Pi 1.0.4+, pi-subagents 0.76.1 (compatible 0.76.x), and Bridge 0.5.5
  (compatible 0.5.x). Restart Pi after package upgrades; `/reload` is for local
  source/config changes.
- Before upgrading Bridge, stop Bridge-owning Pi processes and back up its
  journal. Schema 7 cannot be reopened by older Bridge versions. Stopping Pi
  owners does not prove unknown workers exited.
- Paused/queued native RPC stops and legacy launches without identity evidence
  remain blocked. Hiding UI never clears execution ownership.

[Full changes](https://github.com/alexei-led/pi-plan-exec/compare/v1.6.4...v1.7.0)

## 1.6.4 - 2026-10-05

### Fixed

- Reattach an exactly bound live child after controller restart without launching a replacement.
- Preserve unrelated task prerequisites and accepted progress during explicitly confirmed recovery.

### Added

- `/exec recover-isolated` previews and confirms continuation of the same logical run in an independent checkout. It uses the accepted commit and checked plan, fences old redispatch and acceptance, and preserves the old operation, tree, partial work and progress as quarantined lineage.
- Show task/check/bootstrap details, old HEAD/commit delta and ignored-file metadata before recovery. Stop/cancel and crash recovery preserve ownership; preparation failures pause for explicit repair/retry.

### Upgrade and limits

- Install Bridge 0.5.4 and reload Pi. It retains exact RPC request identities for lost-reply recovery; existing unbound records without evidence still cannot use ordinary resume.
- Isolated recovery changes the target, not the old worker's retirement state. It supports local implementation tasks only, leaves the new target paused, and does not copy unaccepted edits, bypass required checks, or provide a security sandbox. Quarantined targets remain reserved.

## 1.6.3 - 2026-10-05

### Fixed

- Preserve original Bridge launch errors and structured upstream codes across restart and later lookup failures.
- Validate owner-bound, correlated pre-launch rejection receipts from Bridge before requesting a durable cancellation fence and retrying the preserved task. Lost replies, mismatched identities, and late cancellation remain fenced.
- Show the request digest and lookup diagnostic in status; explain missing proof instead of recommending repeated resume.

### Upgrade

- Install Bridge 0.5.3 and pi-subagents 0.76.0 or compatible later versions, then reload Pi. Admission now requires Bridge's pre-launch rejection capability.

### Known limits

- Legacy unresolved launches without a persisted correlated rejection remain blocked. This release does not prove that those workers never started; no force-resume or retrospective evidence importer is provided.

## 1.6.2 - 2026-10-04

### Changed

- Validate the host API against Pi 1.0.2 and bound the Pi SDK development and peer range to `^1.0.2`. Keep host SDK/TUI/TypeBox packages out of runtime and bundled dependencies; packaging checks now accept the tested Pi peer range and verify the runtime-only tarball.
- Controller, child RPC, lifecycle, cancellation, and recovery behavior are unchanged.

### Upgrade

- Upgrade Pi to 1.0.2 or later in the 1.x series before installing this release, then reload Pi. Older hosts are no longer supported.

## 1.6.1 - 2026-09-30

### Changes

- Validate the development stack against Pi `0.99.1` and pi-subagents `0.73.1`, including package loading, detached workers and native terminal proofs. The newer subagent runtime fixes async recovery, prompt-cache retention and a shutdown race.
- Reject private Pi SDK, TUI and TypeBox dependencies during packaging; add regression checks for host-module warnings. Existing plan-exec host dependencies remain wildcard peers. Warnings from other installed extensions require fixes in those packages.
- Correct setup commands and installation docs to use released runtimes without Git pins. Limit optional pi-tasks compatibility to the adapter's supported `0.9.x` range.
- Publish GitHub release notes from this changelog with the version tag as the title.

### Known limits

- Strict Fusion review and released Revmux still lack required ownership/lifetime contracts. Native child execution is not guaranteed to be unbounded.
- Dependency audit findings remain unresolved; the suggested force fix downgrades below the required terminal-proof baseline. See [upstream audit](https://github.com/alexei-led/pi-plan-exec/blob/v1.6.1/docs/upstream-audit.md).

[Full comparison](https://github.com/alexei-led/pi-plan-exec/compare/v1.6.0...v1.6.1)

## 1.6.0 - 2026-09-23

- Require released `pi-subagents@^0.71.0`, Bridge `^0.5.0`, and Fusion `^0.9.3`; update peer ranges without Git or fork pins.
- Accept a native `not-started` child only inside an observed, dispatch-closed workflow proof. Reject standalone not-started proof as terminal ownership evidence.
- Remove unused workflow-proof capability projections. Use the upstream targeted status proof forwarded by Bridge, not synthesized child proof.
- Add an installed-runtime smoke check for the native startup-failure proof. Clarify that bridge unbounded mode omits the outer deadline but does not remove the native child's default timeout; strict Fusion review remains unsupported on this released stack.

## 1.5.0 - 2026-09-22

- Add planless autonomous `/goal`: a bounded loop runs the frozen pipeline against repository checks, detects progress from normalized check output, pauses after three stalled turns, and accepts completion only when every check passes.
- Run only released runtimes: `pi-subagents`, `@alexeiled/pi-subagents-bridge@0.4.2`, and `@alexeiled/pi-fusion@0.9.2`. No Git pins.
- Replace the kernel-owned process dependency with plan-exec's own POSIX process-group runner: detached launch, ps-based leader identity, writer-exit retirement, persisted retirement markers, guarded cancellation, and best-effort containment for descendants that leave the group.
- Accept the released Bridge contracts: best-effort owned-process capability, upstream-shaped process proofs, and the bridge-synthesized workflow terminal proof for persistent workflow hosts.
- Keep every durable identity and cancellation fence: local-operation intents to v3, active index to v2, and stop fences honored even when retirement lands first.
- Modernize tooling: TypeScript 7, Biome (replacing ESLint), Vitest (replacing node:test for all but the documented session-lifecycle file), and npm 12.

## 1.4.1 - 2026-09-20

- Consume implementation worker output before retrying unchecked tasks. An explicit `TASK_FAILED` pauses the plan with its reason instead of relaunching workers and ending in a generic failure.
- Persist task blockers across reloads and require confirmation before retrying the same task; preserve completed work, operation identity, and retry budget.
- Recover single-worker output from retained workflow status after temporary result files disappear, and recognize legacy blocked-run diagnostics.
- Let the controller's checkbox contract own implementation completion instead of rejecting legitimate no-edit blockers in the subagent mutation guard.
- Explain blocker recovery in status, notifications, worker instructions, and the execution skill; never treat retry permission as a waiver of plan prerequisites.

## 1.4.0 - 2026-09-10

- Accept lightweight heading-based Markdown plans such as `P0 — ...`, `Phase 1: ...`, `Step 1: ...`, and `T001: ...` while keeping canonical Task/Iteration numbering compatible.
- Accept `*`, `+`, and ordered list markers for checkbox items and ignore fenced code examples.
- Document the supported executable-plan formats and parser limits.

## 1.3.0 - 2026-09-09

- Add explicit `/exec --worktree <path> <plan-path>` to execute in an existing registered worktree without creating a branch or copying the plan.
- Resolve plan paths relative to the selected worktree, support quoted paths, and validate canonical Git and filesystem boundaries.
- Preserve in-place session cwd and keep background polling independent of unrelated registry records.
- Prevent conflicting starts and failed-run recovery, including symlink aliases and deleted nested worktrees.
- Document the new workflow and add real Git, concurrency, and recovery regression tests.

## 1.2.0 - 2026-09-08

- Add preparation-only `/goal`: inspect the repository in a restricted planning turn and save a validated plan with one explicit `/exec` next action.
- Preserve goal identity and plan hashes, reuse unchanged prepared plans, and refuse to overwrite edited plans.
- Keep planning read-only after invalid finalization or rejected concurrent commands; restore tools at safe lifecycle boundaries.
- Clarify fail-closed recovery evidence and add lifecycle and task-projection regression coverage.

## 1.1.0 - 2026-08-30

- Integrate with pi-subagents 0.60 external-runs/background-work registries using one owned PlanExec row and provider.
- Add durable bridge v2 capability negotiation, request identity, process-terminal proof, and fail-closed unknown-launch recovery.
- Make reload reconciliation idempotent and keep pi-tasks 0.9 projection as a rebuildable cache with visible degraded state.

## 1.0.5 - 2026-08-28

- Correlate settled workflow receipts using the actual pi-subagents schema:
  top-level workflow identity plus the completed status step's parent identity.

## 1.0.4 - 2026-08-28

- Preserve and poll workflows paused for supervisor coordination instead of
  failing the plan run; a live controller continues automatically after the
  reply.
- Recover settled detached children from durable receipts and output archives;
  `/exec resume` reattaches unresolved workflows instead of launching a
  duplicate.
- Report supervisor-paused and detached-workflow recovery actions explicitly in
  `/exec status`.

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
