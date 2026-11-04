# Reliability and runtime upgrade — 2.3.0

Approved scope: implement the dependency/reliability/usability review, validate real Pi in isolated agterm sessions, and release the next minor through a PR and the existing publisher. Source review: 2026-11-04, baseline 868ddad / 2.2.0.

## Constraints

- Preserve one-writer authorization, immutable historical requests/digests, exact output/retirement evidence and required review/checks.
- No silent global config/package changes. New operations use versioned direct singles, excluded from native workflow replay; observe/stop existing operations independently. A config file is not effective-policy attestation.
- Use released Pi/TUI 1.5.0, subagents 0.84.0, optional Fusion 0.12.0; do not claim unsupported Revmux/Fusion strict lifecycle support.
- Use an isolated home/registry/local scripted provider for real Pi validation. Never control user runs.
- Main owns source edits and final verification. Read-only research/review and isolated checks may be delegated.
- No direct default-branch edits. Merge the release PR only after gates pass. Publish v2.3.0 through the tag workflow; never bypass OIDC publishing.

### Task 1: Restore coherent lifecycle and control behavior

- [x] Add regressions and fix handoff command expansion, paused cleanup accounting and shared pending-cleanup policy.
- [x] Fix observation freshness including unresolved polls, selection consistency, goal diagnostics/advanced flags, hide preferences and notification deduplication.
- [x] Fix goal test-disable false positives without weakening check/review acceptance.
- [x] Synchronize critical registry intent writes and document platform/compiler requirements.

### Task 2: Upgrade the supported runtime and dependencies

- [x] Implement effective native no-replay admission with actionable refusal and no global edits.
- [x] Update UUID ceilings, project trust and reviewer discovery handling; preserve late authority rechecks.
- [x] Simplify new schema output to file-only; retain historical requests and uncertainty fences.
- [x] Update released dependency baselines, lockfile, fixtures, runtime pins and security audit.
- [x] Cover native reload/reopen, lost replies, stop, failed child, default reviewer, policy changes and bundled public module loading.

### Task 3: Improve usability and structure

- [x] Add a keyboard-first native run inspector with consistent exact-ID actions and RPC/print fallback.
- [x] Make the strip responsive, display observation age/identity/action and retain important meaning at narrow widths.
- [x] Use native jobs-changed as refresh hints with bounded reconciliation; preserve source/proof distinctions.
- [x] Make actual/requested model, known/estimated usage and effective versus inert limits clear.
- [x] Extract shared pure control/diagnosis/display policy where it removes real duplication.

### Task 4: Update docs, packaging and validation

- [x] Update README, guide, runtime contracts, architecture, skill/recovery docs and development requirements from implemented facts.
- [x] Fix installed documentation links; validate against the packed manifest.
- [x] Align release tooling and exact-commit native/packed gates; add supported-host and canary coverage.
- [x] Pass lint/types, full unit/session tests, native runtime/recovery/parent-death/packed consumer gates and security/package checks.
- [x] Validate actual Pi 1.5 in agterm: plan/goal/review, lifecycle controls/reload, inspector selection, narrow layout and themes; retain sanitized evidence.
- [x] Complete independent review and fix verified findings.

### Task 5: Release 2.3.0

- [x] Update package/version lock/changelog with migration actions and verified limitations.
- [x] Review the complete release diff and notes; commit logical changes in this worktree.
- [ ] Push release branch, create PR, verify exact-commit CI, merge via PR.
- [ ] Verify authorization for exact repo/tag/publication, tag the merged commit and trigger the existing publisher.
- [ ] Verify npm/GitHub release identity/artifacts and clean up the merged worktree without force.

## Documentation ownership

- README: human quickstart, supported stack, short controls and truthful limits.
- docs/guide.md: human executable-plan/configuration/control reference.
- skills/exec-plan/references/runtime-contracts.md: installed human/agent safety contract; docs/runtime-contracts.md is its repository pointer.
- docs/architecture.md: maintainer boundaries and protocol direction.
- DEVELOPMENT.md: contributor setup, checks and release procedure.
- docs/ui-validation.md: measured real-session evidence, not intended behavior.

## Evidence

Real-session evidence is in docs/ui-validation.md. Runtime contracts are in the shipped skills/exec-plan/references/runtime-contracts.md. A timeout, inconclusive ownership or mocked UI is never a successful real-runtime gate. A scripted localhost model is deterministic integration evidence, not live-model reliability.

Verified locally: 866 Vitest +156 node tests; full packed-consumer scenarios; 3 native smoke and 3 Node 22.19 floor cases; 6 recovery and 6 parent-death cases including v2 SIGKILL. Audit: zero vulnerabilities. Runtime source SHA-256: 87c71b53d59bb4340bce76ceb690bbbe99b075cfc93cfdeb66909c5618fb11f7. Final publication/cleanup receipts belong to the release PR and tag workflow.
