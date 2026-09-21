# Autonomous runtime contracts

This branch is an incomplete implementation. The strict autonomous controller
requires a runtime that can attest ownership of every operation-owned descendant.
The currently tested POSIX runtime implementations cannot provide that guarantee.
They must be rejected before dispatch; their process-group observations do not
authorize another writer or successful commit acceptance.

## Lifetime and control requests

The persisted `executionLifetime` is either `{ "mode": "unbounded" }` or
`{ "mode": "bounded", "timeoutMs": 1800000 }`. Unbounded execution creates no
elapsed-time deadline. Bounded execution is an explicit compatibility choice.
Omission, zero, infinity and a large sentinel do not implement unbounded execution.

Control RPC timeouts remain finite. Losing a reply does not establish whether
the child started or stopped. Lookup, replay, adoption and cancellation use the
same durable operation ID and immutable request digest. Cancellation fences must
survive a delayed dispatch and restart.

| Evidence | Meaning |
| --- | --- |
| `capabilities.executionLifetime` | Versioned list of supported explicit lifetime modes |
| `effectiveExecutionLifetime` | Actual resolved lifetime returned by the runtime |
| `processTreeOwnership` | Scope of the runtime's ownership guarantee, independent of lifetime support |
| `processTerminalProof` | Evidence for the identified native runner and its owned descendants |
| `workflowTerminalProof` | Closed workflow dispatch plus terminal evidence for every child; the Pi host need not exit |

A full ownership capability must explicitly identify
`scope: "owned-process-tree"` and `escapedDescendants: "contained"`.
`scope: "posix-process-group"` with `escapedDescendants: "unverified"` is
insufficient. A wrapper's terminal state, successful cancellation request,
missing directory, elapsed heartbeat or empty observed process group cannot
replace terminal ownership proof.

## Verified limitation

A real subprocess regression starts a detached descendant and lets its original
parent exit before the next process snapshot. The original group becomes empty
while the detached descendant remains alive. This invalidates using periodic
`ps` snapshots or group-drain observations as universal descendant-exit proof.

The Revmux dependency exposes its narrower scope honestly. Its adapter refuses
strict execution against that capability. Local verification and bootstrap also
refuse nonempty command batches before launch until a verified containment
adapter exists. The diagnostic local monitor retains request identity, grants,
cancellation and group observations; its observations cannot authorize
production handoff. A bounded timeout does not repair this ownership gap.

This is a delivery blocker. A supported containment backend and its actual
boundary tests are required before the implementation plan can be completed or
the main PR made ready. No global runtime installation or release is part of
this change.

## Source and review tracking

- Main draft: [pi-plan-exec #8](https://github.com/alexei-led/pi-plan-exec/pull/8).
- Scoped Revmux evidence: [revmux #35](https://github.com/umputun/revmux/pull/35),
  commit `5fbd8a6670d1102d613561a504bec66b3258a97d`.
- Fusion dependency: [pi-fusion #12](https://github.com/alexei-led/pi-fusion/pull/12),
  commit `766f8bc3c2d39a8e440c11d6e806bd8a45a54887`.
- Native runtime: [pi-subagents #2376](https://github.com/nicobailon/pi-subagents/pull/2376),
  commit `7a9f03a97c19468f92a9ec78551955da9ef580a7`.
- Bridge dependency: [pi-subagents-bridge #2](https://github.com/alexei-led/pi-subagents-bridge/pull/2),
  commit `544f911571ec4552dcc71d5ce548175f1ad7f612`.
- pi-subagents source baseline: `1ac7b5e` (0.70.1).
- Bridge source baseline: `cfa60b6` (0.3.0).
- Fusion source baseline: `077c85c` (0.9.0).

Exact dependency feature commits and validation results are recorded in the
[active implementation plan](plans/2026-09-21-autonomous-execution.md). The final
development Revmux review is separate from the product's configured review
backend.
