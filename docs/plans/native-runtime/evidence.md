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
- `test/native-recovery-smoke.mjs`: `released public status correlation after a fresh OS host process`; `released public RPC launches direct worker/reviewer leaves and preserves exact run proof identity`. It uses the existing deterministic scripted-session fixture and the real detached runner; its test-only private imports are version-bound in `test/fixtures/native-runtime-host.ts`.

The probes exercise public RPC request/reply envelopes, direct worker and reviewer launches, run/proof identity, pre-dispatch `async:false` rejection with zero child side effects, stop-session ownership, and refusal to seal a paused run without process proof. The setup regression injects a failure after RPC registration and verifies environment/home restoration, listener disposal, and factory reset.

## Observed limits

- **U1, reproduced only on seeded status fixtures:** RPC `stop` returns `invalid_state` for `queued` and `paused`; the existing tool route accepts queued stop, and for paused runs persists the stop request but refuses to seal without exact terminal proof. The test is a route characterization, not proof from queued/paused live detached children or target-contract success. Sources: `node_modules/pi-subagents/src/extension/rpc.js:441-548`; `node_modules/pi-subagents/src/runs/foreground/async-stop-action.js:121-185`.
- **U2, confirmed limitation in pi-subagents 0.76.1 public status after a real host-process restart:** a fresh Node host dropped the direct worker spawn reply, waited for exact observed runner proof, and persisted only the originating session/request IDs plus separate test-harness ground truth. A second Node host used the same isolated HOME/temp roots/session and reattached without reinitializing Git. For request `ec88942a-bb36-41a2-9387-86a18f33b32f`, both the raw ID and `rpc-spawn-ec88942a-bb36-41a2-9387-86a18f33b32f` returned `success:false`, `error.code: execution_failed`; each message ended `Async run not found. Provide id or dir.` (raw target: `Status target: run ec88942a-bb36-41a2-9387-86a18f33b32f`; alias target: `Status target: run rpc-spawn-ec88942a-bb36-41a2-9387-86a18f33b32f`; both also included `Spawn budget: unlimited` and `Active async capacity: 0/unlimited used`). The separate native status artifact for run `a326cc44-8b4c-4f65-976d-58a6f3237508` had matching session `native-u2-65fce788-4998-457a-be37-9ee47add3165`, `state: complete`, `toolCallId: null`, and `processTerminal: { state: observed, runId: a326cc44-8b4c-4f65-976d-58a6f3237508, runnerProcessInstanceId: f9e77d46-12cd-41e0-8368-fd48c01ee71f }`. Untargeted/Fleet public status replies had no structured identity fields. Exact native run-ID status still returned that proof; host PIDs `57832` and `58383` differed; the worker side-effect count remained one. These RPC not-found messages are not non-start proof. Sources: `node_modules/pi-subagents/src/extension/rpc.js:343-347,582-610`; `node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:3033,6997-7000`; `node_modules/pi-subagents/src/runs/background/run-id-resolver.js:42-58,130-146`; public contract `node_modules/pi-subagents/docs/extension-api.md:96-127` and `node_modules/pi-subagents/docs/observability.md:229-255`. Candidate for parent/upstream decision: preserve the existing RPC request/tool-call identity with the direct async run and expose exact session-scoped structured correlation; keep ambiguous, stale, and not-found outcomes non-authoritative. No upstream code/API was changed.
- **U3, partial:** the paused fixture proves refusal when terminal proof is absent. No parent SIGKILL/runner-survival test was run. The published observability contract says proof is observed only after the live parent observes runner close and any session lease is free; missing observation remains unknown (`node_modules/pi-subagents/docs/observability.md:249-255`).
- **U4, partial:** direct RPC receipts report requested context, timeout, tool budget and launch digest; the real scripted leaf records its worker/reviewer cwd and separate runner PID. The direct leaf accepts an extra `executionLifetime` input but the scripted runtime records no effective lifetime value. This does not establish control enforcement. Public docs list `timeoutMs`, `toolTimeoutMs`, and `toolBudget` (`node_modules/pi-subagents/docs/tool-reference.md:97-100`), but output schema, output binding, actual timeout/tool-limit enforcement, and turn-limit behavior remain unverified. Do not infer enforcement from echoed request/receipt fields.

## Commands and results

- `npm exec --yes --package=npm@12.0.2 -- npm ci` — passed; this worktree installed its own dependencies.
- `npm exec --yes --package=npm@12.0.2 -- npm --version` — passed; `12.0.2`.
- `node -p "JSON.stringify({piSubagents:require('./node_modules/pi-subagents/package.json').version, bridge:require('./node_modules/@alexeiled/pi-subagents-bridge/package.json').version, pi:require('./node_modules/@earendil-works/pi-coding-agent/package.json').version})"` — passed; `0.76.1`, `0.5.5`, `1.0.4`.
- `npm exec -- vitest run test/native-runtime-contract.test.ts test/runtime-boundaries.test.ts` — passed; 2 files, 3 tests.
- `node --test test/native-recovery-smoke.mjs` — passed 4 tests. The new U2 case uses two fresh Node host processes; both ID queries fail while exact native-run status returns observed proof and the side-effect count remains one.
- `npm run check` — passed after fixing the new fixture typing. It emitted four non-failing informational suggestions in untouched `src/registry-lock.ts`, `test/index.test.ts`, and `test/review-backend.test.ts`.
- `git diff --check` — passed for the tracked U2 delta. No source changes outside the declared test/evidence scope.

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

After the U2 delta, the writer reran the focused Vitest probes, native smoke (4 tests) and check successfully. The parent independently reran the native smoke: 4 tests passed, with the same missing direct-RPC correlation and a single worker side effect across two fresh hosts. Full output, including exact request/run/process identities: `.pi/native-runtime-parent/u2-smoke.log`. The full suite was not repeated after this delta; its 594/140 result above applies to the preceding checkpoint.

These checks accept only the current partial characterization, not Task 1 or an upstream fix.

## Remaining Task 1 work

Still required: exercise queued/paused stop parity against real native states; run the parent-death fault barrier; verify direct-leaf control enforcement (including structured output and actual timeout/turn limits); exercise a fresh Pi normal-loader host; and complete the S01–S56 scenario mapping. U2 is a confirmed release prerequisite for cutover, not permission to implement the kernel. Parent must decide whether to pursue the minimal upstream correlation fix; no upstream source, issue, PR, or publication was touched.
