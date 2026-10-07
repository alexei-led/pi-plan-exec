# Historical upstream compatibility audit

> Historical, pre-native-cutover record. The Bridge/pi-tasks dependency and
> integration statements below describe the earlier implementation, not current
> installation requirements. See [current runtime contracts](runtime-contracts.md)
> for the released native path and supported recovery behavior.

Checked 2026-10-06 against npm releases, installed source and native Pi fixtures.
Release notes are not proof of execution ownership.

## Tested baseline

| Package | Baseline | Integration |
| --- | --- | --- |
| Pi | [1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4) | Host peer `^1.0.4`, development dependency |
| pi-subagents | [0.76.1](https://github.com/nicobailon/pi-subagents/releases/tag/v0.76.1) | Optional peer `>=0.76.1 <0.77.0`, development dependency |
| Bridge | [0.5.5](https://github.com/alexei-led/pi-subagents-bridge/releases/tag/v0.5.5) | Owner-bound delivery receipts and advisory activity |
| pi-tasks | 0.9.0 | Optional session-file projection only |
| Fusion | 0.9.3 development baseline | Strict plan-exec review contract remains unsupported |

Bridge 0.5.5 was co-released through its tag workflow. Its npm artifact matches
commit `0875ed2a3f01d29e39ad89f7495f4502a66ef858`, with provenance.
No globally installed package was changed by this work.

## Adopted contracts

- pi-subagents 0.76.1 fixes idle completion/supervisor wakes bypassing
  `before_agent_start`, and retained completion ownership across reload.
- Pi `agent_end` is not final settlement. `agent_settled` is notification-only,
  after automatic continuation. Neither proves process exit.
- Session replacement invalidates old extension contexts. Plan-exec retains
  startup/shutdown retirement and fresh `withSession` context.
- Bridge distinguishes cancellation intent (`pending`) from exact native stop
  delivery (`delivered`). Plan-exec requires the matching operation, digest and
  native run before retaining a delivery receipt. Retirement is separate.
- Native-root activity is advisory, bounded and versioned. It cannot populate
  verified task progress, cost, expiry or ownership proof. Wrong/stale/malformed
  snapshots are discarded.
- Bridge proof listeners and reconciliation timers are session-owned and disposed.
- Native Fleet/background-work registrations use transcript-path identity;
  durable leases and pi-tasks use session UUIDs. Correlated cancellation refusal
  details survive ordinary status observations until delivery or retirement.
- Display cache failures cannot suppress background-work bookkeeping. Terminal
  Fleet rows are bounded. No-session pi-tasks projection is explicitly unavailable.
- Session path aliases do not trigger redundant handoffs. Pi defers a new
  transcript file until a conversation message; a slash-only session can control
  an isolated worker without forking a nonexistent transcript.

## Limits retained, not bypassed

- **Paused/queued native RPC stop:** 0.76.1's model-facing paused-stop fix is not
  in its event-bus RPC route. Real RPC tests reproduce `invalid_state`.
  Bridge preserves pending intent and the original error. There is no silent
  switch to the model tool, CLI, or another process-control protocol.
- **Unknown legacy launches:** no authoritative native caller-operation lookup
  or cancel-before-dispatch fence exists. An old row without correlation cannot
  be declared never-started. Upgrading does not recreate missing evidence.
- **Unbounded workers:** no outer workflow deadline does not remove the ordinary
  native child's 30-minute default. Status says “unbounded requested”, not
  “unbounded end-to-end verified”.
- **Workflow reuse:** reuse after runtime replacement is not exactly-once dispatch.
  Keep the controller's operation identity, authorizations and writer fence.
- **pi-tasks:** its internal file store has no supported refresh event.
  A ready file projection does not guarantee widget registration or repaint.
  Do not control its foreign `tasks` widget key or treat metadata as access control.
- **Other review backends:** preserve the Fusion/Revmux capability refusals in
  [runtime contracts](runtime-contracts.md). No new compatibility claim is made.

## Upgrade requirements

Stop Bridge-owning Pi processes and back up its journal before upgrading to
Bridge 0.5.5. Schema 7 retains nullable delivery receipts without manufacturing
legacy proof, but older Bridge cannot reopen it. Unknown workers still need
independent retirement evidence.

Restart Pi after installed-package upgrades. `/reload` is for local source/config
changes, not a mixed old/new package runtime.

Pi 1.0.3 renamed the Azure provider; check frozen model identities if used.
Pi 1.0.4 changed MCP allowlist behavior; test actual child tool ceilings rather
than infer permissions from model-facing declarations.

Host SDK/TUI/TypeBox remain peers, never private runtime copies. Native public
API imports declare a versioned optional pi-subagents peer. Package guards and
the real-host smoke check these boundaries. pi-tasks 0.9.0's own TypeBox runtime
dependency is an upstream packaging issue, not repaired by editing this package.

## Evidence

[UI validation](ui-validation.md) records actual Pi/agterm checks and screenshots.
The isolated model boundary is scripted; these are not live-LLM performance claims.
Controller tests exercise cancellation intent/delivery, restart, native proof,
missing directories, projection failures and late UI updates.
Bridge's release gate passed 153 tests, including real Pi 1.0.4/native 0.76.1 RPC.

Dependency audit findings are separate from runtime proof. Do not apply a forced
dependency downgrade below the compatible runtime to make an audit count green.
This audit does not claim the dependency graph is vulnerability-free.
