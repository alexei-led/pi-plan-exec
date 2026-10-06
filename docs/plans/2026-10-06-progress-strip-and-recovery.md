# Progress strip and reliable recovery

Chosen UI: progress strip. Green means healthy running or complete. Amber means
waiting, uncertain, or stopping. Red means failed. Paused/cancelled is muted.
Symbols and text always carry the same meaning as color.

Scope: code, regression tests, docs, real Pi/agterm screenshots and integration.
Bridge work has a separate visible Pi session and sole writer. No mutation of
the user's unresolved router run, no global installs, no invented retirement.
Release changes through the owning repository's supported workflow only.

Evidence: [investigation](../prototypes/plan-ui/INVESTIGATION.md).
This checklist tracks manual implementation; it is not an active /exec run.

## Verification and remaining limits

- Passed: Biome/types, 557 Vitest tests, 117 node:test command/lifecycle tests,
  2 native-runtime smoke tests, package allowlist and clean packed-consumer RPC.
- Actual Pi/agterm recovery: one accepted task, one rejected request plus one
  successful worker request, legacy launch still blocked. Cancelling the legacy
  fixture and removing its checkout neither recreated it nor launched work.
- [Native screenshots and UI checks](../ui-validation.md) cover the chosen strip,
  status colors, width and theme changes, hide/show and reload behavior.
- [Bridge 0.5.5 released](https://github.com/alexei-led/pi-subagents-bridge/releases/tag/v0.5.5)
  at `0875ed2` through its approved workflow. Main plan-exec changes remain local.
- Upstream paused/queued native RPC stop is still unsupported. Its error remains
  pending, never a false retirement claim. Missing legacy launch correlation
  cannot be reconstructed. No real router run or globally installed package changed.
- Independent review findings were reproduced and fixed, including terminal
  display retention replay. Additional negative receipt and advisory isolation
  tests pass.


### Task 1: Record the implementation contract and baseline

- [x] Create the checked plan from every investigation finding. Preserve legacy unresolved run evidence. Establish existing test/check baseline and map failures before code changes.

### Task 2: Implement the status-colored progress strip

- [x] Replace verbose widget with two/three width-safe themed lines. Green healthy running/completed; amber retry/external/unknown/stopping; red failed; muted paused/cancelled. Prioritize run stop state over stale tasks; distinguish accepted tasks from overall completion. Test states, Unicode, widths and colors.

### Task 3: Add immediate persistent hide, show, and clear controls

- [x] Independent presentation preferences and per-run dismissals; no --apply for display. Suppress timer/projection/startup/late repaint, clear only owned keys, deterministic multi-run selection, preserve RPC text and no-UI behavior. Regression tests across reload/session teardown.

### Task 4: Fix cancellation delivery and recovery semantics

- [x] Separate intent, delivery and retirement; retry exact operation after unknown/failed delivery/late binding; migrate old acknowledgement interpretation; preserve CAS stop generation and no duplicate writer. Test Bridge-shaped replies, restart, late identity, terminal proof and user stop precedence.

### Task 5: Handle missing worktrees without recreating them

- [x] Keep recovery diagnostics under durable run directory, avoid resurrecting deleted checkouts, make status/cancel independent of plan/projection reads and stop repeated misleading warning noise. Test deleted workspace and retained unknown launch.

### Task 6: Coordinate Bridge fixes in a visible Pi/agterm session

- [x] Separate writer in pi-subagents-bridge: explicit cancellation delivery/pending-stop handling, advisory observations, listener/timer lifecycle; inspect paused native RPC limitation. Code/tests/docs and prepared release through repository policy; agree exact additive contract before plan-exec consumes it.

### Task 7: Align observations, lifetime claims and upstream recovery limits

- [x] Consume validated advisory activity without promoting it to proof. Missing costs/activity remain unknown. No false end-to-end-unbounded claim; preserve native operation correlation and runtime-replaced workflow safety. Regression tests for malformed/stale/foreign observation and unsupported stop.

### Task 8: Decouple optional projections from execution tracking

- [x] Record active background work even when Fleet admission fails; prune bounded terminal display rows; use correct public API types; no-session pi-tasks projection explicitly unavailable; owned-row isolation and failed projection tests.

### Task 9: Align dependency baselines and package upgrade guidance

- [x] Test Pi 1.0.4/subagents 0.76.1 (or verified newer approved contract), compatible released Bridge; dependency resolution in clean packed consumer, updated lockfile, process restart guidance. No global package edits.

### Task 10: Update documentation and capture real screenshots

- [x] README/guide/runtime-contracts/upstream-audit/skill/development align with new controls, colors, cancellation/recovery/lifetime limits. Include cropped screenshots from actual Pi/agterm UI, not HTML mocks. Align chosen HTML prototype.

### Task 11: Exercise the complete flow in live Pi/agterm sessions

- [x] Use isolated disposable fixtures: healthy progress/completion, hide/show/clear across reload, pause/cancel, legacy unbound launch, deleted worktree, delayed projection, narrow/light/dark rendering. Record exact commands, session IDs and evidence. Do not alter the user's unresolved real run.

### Task 12: Run release-grade verification and reconcile all tasks

- [x] Full lint/types/tests/package/runtime gates on final source, cross-repo integration with released Bridge if needed, inspect final diff, mark only proven tasks complete and list any upstream/authorization blocker.
