# Upstream compatibility audit

Checked 2026-09-30 against live npm metadata and GitHub release notes. Release
notes describe upstream behavior; they do not prove this controller's ownership
or lifetime contracts. Local verification is listed separately below.

## Released versions and adopted changes

| Package | Previous development baseline | Latest release checked | Decision |
| --- | --- | --- | --- |
| Pi SDK | 0.86.1 | [0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1) | Update development pin; keep host peer `*`. |
| pi-subagents | ^0.71.0 | [0.73.1](https://github.com/nicobailon/pi-subagents/releases/tag/v0.73.1) | Update development range to ^0.73.1 and lockfile. |
| pi-subagents-bridge | ^0.5.0 | [0.5.0](https://github.com/alexei-led/pi-subagents-bridge/releases/tag/v0.5.0) | Keep native terminal-proof forwarding. |
| pi-fusion | ^0.9.3 | [0.9.3](https://github.com/alexei-led/pi-fusion/releases/tag/v0.9.3) | Keep; strict plan-exec review remains unsupported. |
| pi-tasks | 0.9.0 | [0.9.0](https://github.com/tintinweb/pi-tasks/blob/v0.9.0/CHANGELOG.md) | Limit peer range to `>=0.9.0 <0.10.0`, matching the projection adapter. |
| Revmux | PR #35 commit 988904f | [v0.2.6](https://github.com/umputun/revmux/releases/tag/v0.2.6) | Do not replace the required lifecycle contract with this release. |

### Speed and stability available through the baseline upgrade

- [Pi 0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0)
  adds codemode/MCP and tool-orchestration APIs, fixes session creation and RPC
  listener issues, reduces some CPU use, and changes managed-Git handling of
  host peer packages. Pi 0.99.1 adds a model and fixes bundled OpenAI login;
  it does not add a controller ownership primitive.
- [Pi 0.87.0](https://github.com/earendil-works/pi/releases/tag/v0.87.0)
  changed session/event APIs. The SDK bump therefore needs real host loading,
  type checks, and lifecycle tests, not just a manifest edit.
- [pi-subagents 0.72.0](https://github.com/nicobailon/pi-subagents/releases/tag/v0.72.0)
  adds lazy loading (release notes report 264 to 199 startup modules), uses
  host TypeBox, and improves async external-job recovery and shared temporary
  roots. This is an upstream startup improvement, not a measured plan-exec
  speedup.
- [pi-subagents 0.73.0](https://github.com/nicobailon/pi-subagents/releases/tag/v0.73.0)
  adds failure classification, bounded/marked workflow output, prelaunch
  validation, and timer-limit checks. Version 0.73.1 fixes prompt-cache loss
  and a stop-during-shutdown race. These are useful for long-running workers;
  no controller rewrite is needed to use the runtime fixes.

Bridge 0.5.0 already forwards native workflow terminal proofs introduced in
pi-subagents 0.71.0. Keep this boundary: neither a status label nor a child
message proves retirement. Fusion 0.9.3's released-runtime compatibility does
not establish the durable native-operation/tree-ownership contract required by
strict plan-exec reviews.

## Host-module loading guard

Plan-exec already had correct `"*"` peers for `pi-coding-agent`, `pi-tui`, and
`typebox`; it did not need to move these out of runtime dependencies.

The observed local installation had separate problems:

- `resume-from@0.2.0` declared `@earendil-works/pi-tui` as a runtime dependency,
  matching the quoted warning.
- `@tintinweb/pi-tasks@0.9.0` declared `typebox` as a runtime dependency and
  version-constrained Pi peers.
- `pi-subagents@0.73.1` still declared `pi-ai` as `>=0.86.1`, not `*`.
  This is a peer-policy mismatch, not the same `dependencies` warning.

These packages were inspected, not changed. Follow the warning's package path;
fixing plan-exec cannot repair another independently installed extension.
Upstream fixes should move host runtime dependencies to `"*"` peers and retain
concrete versions only in development dependencies. Do not suppress warnings,
edit installed copies as a permanent fix, or change global npm configuration.

`scripts/check-pack.mjs` now rejects host packages in runtime/optional/bundled
dependencies and rejects non-wildcard host peers, including legacy Pi names and
both TypeBox names. Regression fixtures cover all ten names and both npm bundle
field spellings. The real Pi RPC smoke test loads the package root, checks
`/exec` and `/goal` registration, and rejects host-module warnings. Development
SDK pins remain valid. This guard checks our manifest, not arbitrary installed
third-party extensions.

## Next improvements, in priority order

These are recommendations, not implemented features.

1. **Reject unsupported review backends before implementation starts.**
   `src/index.ts` already checks Bridge capabilities at admission, but strict
   Fusion review can fail only when its stage launches. Preflight the selected
   backend before admitting a writer, then recheck at dispatch. Test unavailable,
   malformed, and changed capabilities. Keep ambiguous launch reconciliation and
   operation IDs unchanged. This avoids doing implementation work that cannot
   pass its required review.
2. **Use structured failure classification through Bridge.**
   Evaluate the 0.73 failure DTO at `src/bridge.ts` and the recovery paths in
   `src/controller.ts` before using it to distinguish auth/quota, startup,
   transport, and task failures. Specify/version the adapter contract first;
   test unknown classifications and old journal records. Classification must
   never count as retirement or authorize a replacement writer. Do not
   automatically switch models to bypass permissions or configuration failures.
3. **Use workflow events to wake reconciliation, not replace it.**
   [pi-subagents 0.71.0](https://github.com/nicobailon/pi-subagents/releases/tag/v0.71.0)
   already exposes structured workflow events. A Bridge-supported wake signal
   could reduce the fixed controller polling in `src/index.ts`. Coalesce events
   by operation ID, keep periodic reconciliation for missed events/restarts,
   and retain lease/CAS checks. Test duplicate, stale, reordered, and lost
   events plus reload unsubscription. Measure wake latency and status-RPC count
   before changing polling intervals.
4. **Keep one controller, use host orchestration only inside worker turns.**
   Pi's codemode/tool-orchestration APIs may reduce round trips for independent
   read-only checks. They are not a replacement for the durable scheduler,
   owned-process runner, or single-writer policy. Validate required-tool
   visibility and cancellation before teaching worker prompts to depend on
   them. Do not add a second agent-owned scheduler.
5. **Stabilize the optional projection boundary before widening versions.**
   `src/task-projection.ts` imports pi-tasks `dist/` internals and accepts only
   0.9.x/session scope. The new `session-global` option is not a drop-in upgrade.
   Ask for a public versioned projection/store contract upstream; keep projection
   errors advisory and `run.json` authoritative. A wider peer range alone would
   promise support the adapter rejects.

For structure, preserve the existing Bridge/Fusion/review adapters and durable
controller boundary. If event-driven wakeups are added, isolate subscription,
coalescing, and disposal from the large command/UI module rather than placing
provider-specific lifecycle logic into more command handlers.

## Remaining release and security limits

- Revmux's explicit lifetime/process-group work is in
  [open PR #35](https://github.com/umputun/revmux/pull/35), not v0.2.6. The
  adapter must continue to reject missing capabilities. Escaped descendants
  remain outside process-group proof even with that work.
- Unbounded outer workflows do not prove unbounded child execution. Keep the
  caveat in [runtime contracts](runtime-contracts.md).
- `npm audit` after the upgrade reports four affected package entries: two
  moderate and two high. Findings include brace-expansion denial of service
  and pi-subagents' pinned `undici@8.10.0` (fixed upstream in 8.10.2), including
  TLS-validation, cache-isolation, and denial-of-service advisories. Reachability
  in this extension was not established. The suggested force fix downgrades
  Bridge/pi-subagents below the terminal-proof baseline; do not apply it.
  Track upstream dependency fixes separately rather than silently weakening
  the runtime contract or claiming the latest release is vulnerability-free.

## Verification

- Packaging regression fixtures failed before the guard and pass after it.
- Biome and TypeScript checks pass on the new SDK.
- Full Vitest suite: 484 tests passed, including real Pi package loading/RPC.
- Separate node:test lifecycle suite: 110 tests passed for setup, reload,
  status, and recovery behavior. `npm run test:all` passed the combined gate.
- Released-runtime smoke: two tests passed, including a detached scripted
  worker, Bridge native proof forwarding, checks, review, promotion and archive.
  Evidence: `.pi/autonomous-runtime-smoke/run-H8B9FS/` (local, ignored).
- `npm run pack:dry` passed the runtime-only file allowlist and host-package
  guard.

These are scripted/local checks, not live-model validation or cross-platform
performance measurements. No package was published and no global extension
installation was changed.
