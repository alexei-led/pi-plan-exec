# Native runtime contract evidence

## Scope and state

This is a partial Task 1 characterization only. Production dispatch, `src/`, package manifests, upstream sources, and plan checkboxes were not changed. Task 1 is incomplete; no U1–U4 cutover claim is made.

Worktree branch: `plan/native-runtime-safety-kernel`. Baseline commit: `581c22a923daa32e72f05324c2b18c4fe3a64159`.

Installed versions: npm `12.0.2`, pi-subagents `0.76.1`, Bridge `0.5.5`, Pi `1.0.4`. The test-only factory seam verifies pi-subagents `0.76.1` before importing its private source modules. `npm ci` reported one high-severity audit finding; it was not triaged or changed.

## Parent-verified baseline

The unchanged baseline ran in the separate `test/native-runtime-baseline` checkout; logs are under its `.pi/native-runtime-baseline/`. `npm test` passed (591 Vitest and 140 node tests); `npm run test:runtime-smoke`, `npm run check`, and `npm run pack:dry` passed. After the review fixes, the parent also ran the full suite and existing runtime smoke in the implementation worktree; see Parent verification below. The pre-change source/test sizes recorded in this worktree were `src/bridge.ts` 790 lines, `src/task-projection.ts` 582 lines, `test/bridge.test.ts` 835 lines, and `test/autonomous-runtime-smoke.mjs` 592 lines.

## Characterization added

- `test/native-runtime-contract.test.ts`: `fixture setup restores process state and disposes partial native registrations`; `released public RPC characterizes rejection, stop parity, ownership, and missing proof`.
- `test/runtime-boundaries.test.ts`: `native boundary guard rejects private native imports and accepts public subpaths`.
- `test/native-recovery-smoke.mjs`: `released public RPC launches direct worker/reviewer leaves and preserves exact run proof identity`. It uses the existing deterministic scripted-session fixture and the real detached runner; its test-only private imports are version-bound in `test/fixtures/native-runtime-host.ts`.

The probes exercise public RPC request/reply envelopes, direct worker and reviewer launches, run/proof identity, pre-dispatch `async:false` rejection with zero child side effects, stop-session ownership, and refusal to seal a paused run without process proof. The setup regression injects a failure after RPC registration and verifies environment/home restoration, listener disposal, and factory reset.

## Observed limits

- **U1, reproduced only on seeded status fixtures:** RPC `stop` returns `invalid_state` for `queued` and `paused`; the existing tool route accepts queued stop, and for paused runs persists the stop request but refuses to seal without exact terminal proof. The test is a route characterization, not proof from queued/paused live detached children or target-contract success. Sources: `node_modules/pi-subagents/src/extension/rpc.js:441-548`; `node_modules/pi-subagents/src/runs/foreground/async-stop-action.js:121-185`.
- **U2, unverified:** the smoke drops the spawn reply, replaces the RPC runtime in the same OS process, and observes the run by an event-derived native run ID. A status lookup using the raw RPC request UUID fails even though the reviewer side effect occurred. This is not a process-restart test and does not rule out the existing `rpc-spawn-<requestId>` alias candidate passed to the executor (`node_modules/pi-subagents/src/extension/rpc.js:343-347`). Do not treat the not-found response as non-start proof. No mandatory upstream gap is concluded. Public RPC docs: `node_modules/pi-subagents/docs/extension-api.md:96-127`; RPC status source: `node_modules/pi-subagents/src/extension/rpc.js:582-610`.
- **U3, partial:** the paused fixture proves refusal when terminal proof is absent. No parent SIGKILL/runner-survival test was run. The published observability contract says proof is observed only after the live parent observes runner close and any session lease is free; missing observation remains unknown (`node_modules/pi-subagents/docs/observability.md:249-255`).
- **U4, partial:** direct RPC receipts report requested context, timeout, tool budget and launch digest; the real scripted leaf records its worker/reviewer cwd and separate runner PID. The direct leaf accepts an extra `executionLifetime` input but the scripted runtime records no effective lifetime value. This does not establish control enforcement. Public docs list `timeoutMs`, `toolTimeoutMs`, and `toolBudget` (`node_modules/pi-subagents/docs/tool-reference.md:97-100`), but output schema, output binding, actual timeout/tool-limit enforcement, and turn-limit behavior remain unverified. Do not infer enforcement from echoed request/receipt fields.

## Commands and results

- `npm exec --yes --package=npm@12.0.2 -- npm ci` — passed; this worktree installed its own dependencies.
- `npm exec --yes --package=npm@12.0.2 -- npm --version` — passed; `12.0.2`.
- `node -p "JSON.stringify({piSubagents:require('./node_modules/pi-subagents/package.json').version, bridge:require('./node_modules/@alexeiled/pi-subagents-bridge/package.json').version, pi:require('./node_modules/@earendil-works/pi-coding-agent/package.json').version})"` — passed; `0.76.1`, `0.5.5`, `1.0.4`.
- `npm exec -- vitest run test/native-runtime-contract.test.ts test/runtime-boundaries.test.ts` — passed; 2 files, 3 tests.
- `node --test test/native-recovery-smoke.mjs` — initially passed 1 test. After the parent cleanup fix it passed 3 tests, including two direct leaf launches with exact observed proof identities and two failure-cleanup contract cases.
- `npm run check` — passed after fixing the new fixture typing. It emitted four non-failing informational suggestions in untouched `src/registry-lock.ts`, `test/index.test.ts`, and `test/review-backend.test.ts`.
- `git diff --check` — passed (no tracked diff); see handoff for final untracked-file inventory.

The first check run before the bounded recovery failed on the new fixture's TypeScript issues; those diagnostics were corrected and the final `npm run check` passed. The parent subsequently ran `npm test` and `npm run test:runtime-smoke` here after the review fixes. `npm run pack:dry` has only the unchanged separate-checkout baseline result so far.

## Parent verification after review

The parent reproduced a native module-cache leak: following failed setup in sandbox A, a second host in sandbox B still used A's cached async/results roots. Root-isolation assertions failed before the fix. The setup-failure probe now runs in a fresh Node process with a minimal environment, leaving the main test's native module imports isolated to its own sandbox. Its regression checks both async/results roots.

A second red test showed that the import guard missed side-effect imports and require calls. The scanner now covers those literal forms as well as named and dynamic imports. This remains a literal-import guard, not whole-program data-flow analysis.

Smoke failure cleanup now attempts bounded stop and proof observation only for known fixture run IDs. Stop delivery alone leaves the run unresolved; already-proven runners are never signalled again. Failed sandboxes stay retained. The fixture's dispose method is not retirement evidence.

Parent commands after these fixes:

- Focused Vitest probes — 2 files, 3 tests passed; both root-leak and scanner regressions failed before their fixes.
- `node --test test/native-recovery-smoke.mjs` — 3 tests passed.
- `npm run check` — passed, with the same four informational baseline suggestions.
- `npm test` — 594 Vitest and 140 node tests passed; complete log: `.pi/native-runtime-parent/npm-test.log`.
- `npm run test:runtime-smoke` — 2 tests passed; complete log: `.pi/native-runtime-parent/runtime-smoke.log`.

These checks accept only the current partial characterization, not Task 1 or an upstream fix.

## Remaining Task 1 work

Still required: test the exact request/alias candidate through a real host restart; exercise queued/paused stop parity against real native states; run the parent-death fault barrier; verify direct-leaf control enforcement (including structured output and actual timeout/turn limits); exercise a fresh Pi normal-loader host; and complete the S01–S56 scenario mapping. No new upstream API is justified by these partial probes. Continue the approved Task 1 probes before deciding whether a minimal native bugfix is required. Kernel implementation and cutover remain blocked by incomplete contract evidence; actual upstream edits/publication need separate operator approval.
