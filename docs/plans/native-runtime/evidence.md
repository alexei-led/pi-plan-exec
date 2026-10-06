# Native runtime contract evidence

## Scope and state

This is a partial Task 1 characterization. Production plan-exec dispatch, `src/` and package manifests are unchanged. Three evidence checkpoints are checked in the plan, but Task 1 is incomplete and no U1–U4 cutover claim is made. Separately authorized local upstream candidates and their validation are recorded below.

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

## Upstream fixes (PR open, unreleased)

The operator first approved local fixes, then requested one combined PR.
Published [pi-subagents PR #2717](https://github.com/nicobailon/pi-subagents/pull/2717)
from `alexei-led:fix/rpc-async-recovery`, head
`2328b1d22f047fa281f7ce30668f684166f43084`. The PR was verified open with CI
in progress. No merge, tag, release or global package upgrade was performed. The refreshed upstream base
was `5da808168c097ea0d56616644773efe0f6f87938`; no open PR already covered the
two fixes when checked.

Separate pi-subagents branches:

- `fix/rpc-stop-parity`, commit `37601c5a`: reuse the tool's existing stop
  delivery and proof-backed paused sealing policy in RPC. Keep the successful
  `stopping` acknowledgement separate from lifecycle/retirement proof.
- `fix/rpc-direct-correlation`, commit `00147dba`: retain the existing
  tool-call ID through direct async launch, runner status rewrites and terminal
  result. Reuse the existing indexed alias resolver and existing structured
  runId/toolCallId fields. No new RPC method, scan, journal or idempotency claim.

Independent read-only reviews found no confirmed code defects in the inspected
seams. The parent checked complete diffs and added the public contract wording.
The stop review did not locate this downstream evidence file in the upstream
checkout; its code review and the parent's reproduction cover different evidence.

Combined branch `integration/native-rpc-fixes` contains cherry-picks
`089b8ce3` and `2328b1d2`. Component and integration worktrees were clean
after their commits. They remain separate from both repositories' main checkouts.

Validation on the combined tree:

- `npm run typecheck` passed.
- First `npm run test:all` stopped in unit tests: 3,813 passed, 11 failed,
  17 skipped. Failures included macOS socket-path length, noncanonical
  /var versus /private/var paths, path truncation and a short fixture deadline.
- With `TMPDIR=/private/tmp` and `--test-concurrency=4`, all 99 cases in the
  initially failing groups passed unchanged. No assertions were disabled.
- The complete unit suite under those settings had 3,823 passed, one failed
  and 17 skipped. The remaining `global-npm-root` timeout test attempted to
  read its PID file after its 500ms deadline had expired before file creation.
  Its isolated seven-test file then passed. That concurrent run was not clean.
  The complete unit suite was subsequently run with the same canonical temp
  root and `--test-concurrency=1`: 3,824 passed, zero failed, 17 skipped.
  No source, assertions or skip rules were changed to obtain this result.
- The complete integration suite under the same canonical temp/concurrency
  settings passed: 1,168 passed, zero failed, seven skipped.
- Integration fixtures still logged the existing missing
  `(deps.parentWake ?? deps.pi).sendMessage` callback warning. No unrelated
  notification implementation change was made.
- `npm run build:pkg` and local tarball creation passed. The tarball retains
  the package's 0.76.1 version string but is an unreleased development artifact,
  not evidence that published 0.76.1 contains these fixes.
- Extension API documentation links and Git whitespace checks passed.
- The baseline npm audit warning remains untriaged and unchanged.

Exact combined-tree commands and logs are under the upstream integration
worktree's `tmp/native-rpc-integration/`: `typecheck.log`, `test-all.log`,
`environment-repro.log`, `unit-canonical.log`, `global-npm-repro.log`,
`unit-serial.log`, `integration-canonical.log`, `build-package.log` and `pack.json`.
Unit/integration retries used the repository's existing Node test loaders and
complete file inventories, with only TMPDIR and test concurrency changed.

Published-runtime cutover remains blocked. These local candidates do not
authorize relaxing unknown-launch fences or pinning an unreleased build as
released compatibility.

## Merge coordination with force-stop / 1.8.0

Both parent sessions confirmed this order and ownership:

1. The `feat/exec-force-stop-ux` lane owns its feature PR integration and the
   operator-authorized 1.8.0 tag/release. This migration lane does not merge to
   pi-plan-exec main, tag, or bump its version.
2. Force-stop lands first after that lane's final review and CI. Its owner sends
   the final PR and immutable merged main SHA.
3. This lane merges that exact SHA into `plan/native-runtime-safety-kernel`
   without rewriting history, refreshes the migration design against the new
   contract, and reruns combined focused checks before production work.
4. A future migration-to-main merge needs renewed coordination. Task 1 remains
   partial and upstream PR #2717 is not a released runtime prerequisite yet.

Early conflict check: the common base is `757b6a3`. A read-only
`git merge-tree --write-tree b77674b 4bb0a6e` produced a clean merge tree.
The migration branch changes six plan/evidence/native-test files; the force-stop
branch changes twenty files, with no path overlap. This is not a real merge or
a final compatibility claim. The force-stop lane was still applying review
fixes in registry/controller/force-stop tests, so repeat the check against its
final reviewed SHA.

Semantic requirements to preserve after refresh:

- Terminal operator `abandoned` is a durable management decision, not proof of
  worker retirement; no automatic restore, resume or default UI resurrection.
- Ordinary CAS writes cannot revive an abandoned run. Native replay/dispatch
  must recheck stop and execution generations after asynchronous admission.
- Preserve unknown active and failed operation identity plus every quarantined
  target. All abandoned checkouts stay reserved until controller-lock quiescence
  and cleanup eligibility are proven.
- Sync the backup/final abandonment marker before cleanup or provider calls.
  Flush the final archive inside the removal lock before deleting active state.
- Cancellation remains exact-operation best effort. Delivery, abandonment and
  process-retirement proof stay separate; missing evidence never frees a writer.
- Older registry cleanup must not operate on new abandoned record shapes.

Before claiming combined compatibility, run the native contract/smoke checks
together with `test/force-stop.test.ts`, controller, registry, lifecycle,
isolation, run-view/runtime-integration and the separate node:test index suite.
Do not modify the other lane's worktree or treat its in-progress release commit
as the agreed integration target.

## Remaining Task 1 work

Still required: exercise queued/paused stop parity against real native states; run the parent-death fault barrier; verify direct-leaf control enforcement (including structured output and actual timeout/turn limits); exercise a fresh Pi normal-loader host; and complete the S01–S56 scenario mapping. U1/U2 are published together in upstream PR #2717, but are not merged or released. A supported released native contract remains a cutover prerequisite. No upstream release or global install was performed. A separate operator-owned force-stop/command-UX lane is preparing pi-plan-exec 1.8.0; refresh this plan against its merged SHA and preserve its abandoned-run reservation/no-autorestore contract before Tasks 2–5.
