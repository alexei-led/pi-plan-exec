# Autonomous plan execution

Status: implementation in progress; strict runtime ownership is blocked

Baseline: `0f184ec80754683772b081ef41e6a22a6b8fdb27` (`origin/main`).

## Accepted design

Keep the durable controller inside Pi, with one writer and `run.json` as the authority. Task failures and transport uncertainty must not stop the controller. Recoverable work always has an automatic next action, with bounded exponential backoff and fair scheduling. Explicit user pause/cancel takes precedence over late replies. No daemon or separate dashboard is included.

Healthy workers default to an explicit unbounded execution lifetime throughout Bridge, pi-subagents and selected Fusion paths. Control RPCs remain bounded. Unknown launch outcomes retain the same durable operation identity; wrapper completion and cancel acknowledgement do not prove child exit. Unsupported runtime capabilities must be reported honestly before dispatch. Bounded renewable execution is a separately selected compatibility policy.

Dependencies refer to earlier tasks; omitted metadata retains legacy sequential ordering and `dependsOn: []` explicitly declares independence. Accept a concrete commit only after child exit, baseline ancestry, clean worktree, required checks and committed task checkboxes are verified. Preserve partial work after failed attempts. Independent work starts from the last accepted baseline in a prepared lane, never from unaccepted edits.

Review is enabled and required by default, using one subagent. Revmux and Fusion are explicit backends under the same lifecycle/result contract; fallback defaults to none. Malformed output and blocking findings cannot satisfy review. Native status/widget and optional pi-tasks are projections and cannot gate controller recovery.

## Task 1: Runtime contracts

dependsOn: []

- [x] Inspect current repository and create an isolated feature worktree; preserve the original checkout.
- [x] Install locked dependencies and record fresh baseline checks.
- [x] Verify current dependency source versions and exact runtime APIs.
- [ ] Implement explicit lifetime propagation, effective capability, durable launch reconciliation, cancellation fences and truthful child exit in dependency source worktrees where needed.
- [x] Pin reproducible dependency commits and prepare linked dependency PRs.
- [ ] Test actual adapter boundaries, lost replies, restart, stop races and absence of hidden elapsed timers.

## Task 2: Automatic controller recovery

dependsOn: [1]

- [ ] Separate ordinary tick from explicit resume/adopt.
- [ ] Persist retry/probe scheduling and stop precedence; remove terminal attempt, task-count and transient status caps.
- [ ] Validate single-task continuation, four-plus status failures, unknown ownership and restart.

## Task 3: Task scheduling and safe acceptance

dependsOn: [2]

- [x] Parse and validate explicit dependencies, preserving legacy sequential semantics.
- [ ] Persist task states, attempt history, accepted baseline, candidate verification and fair ready/retry selection.
- [ ] Preserve failed partial lanes; bootstrap clean replacement lanes as a separately recoverable operation.
- [ ] Verify A blocked → independent B completes → C waits for A, partial-work isolation and retry integration.
- [ ] Verify 51-plus tasks, crash around acceptance, dependency errors and no permanent recovery parking.

## Task 4: Required review

dependsOn: [2]

- [ ] Default to one required subagent reviewer under a shared backend contract.
- [ ] Add explicit Revmux/Fusion selection and fallback policy with ownership fencing.
- [ ] Validate malformed review recovery, persistent blocking findings and reviewed commit identity.

## Task 5: Recovery visibility and restart

dependsOn: [3, 4]

- [ ] Restore authorized unfinished operations automatically without stealing a live owner.
- [ ] Extend native status/widget with task counts, wait reasons, verified activity, next action, attempts and available usage.
- [ ] Isolate UI/pi-tasks failures and optional reporting from execution.
- [ ] Validate all 19 acceptance scenarios from the approved design using deterministic fault injection plus an integration smoke test.

## Task 6: Verification and delivery

dependsOn: [5]

- [ ] Run project checks (`npm run check`, `npm test`, `npm run lint`, `npm run pack:dry`) and dependency checks.
- [ ] Run independent Revmux review of the full cumulative diff from the recorded baseline; fix confirmed critical/major findings and verify fixes.
- [ ] Record manual/E2E evidence and remaining limitations.
- [ ] Commit logical changes, push the new branch, and create a new PR with linked dependencies.
- [ ] Only after every required gate passes, archive this plan under `docs/plans/completed/` and mark the PR ready.

## Checkpoints

- Research: accepted design and summary read. Current main and origin main both resolve to the recorded baseline. Original untracked `.revmux/` preserved.
- Baseline: Node 24.15.0 / npm 12.0.2; `npm ci`, typecheck, lint, all 287 tests and package validation passed. These results precede implementation.
- Runtime audit: current upstream pi-subagents 0.70.1 (`1ac7b5e`), Bridge 0.3.0 (`cfa60b6`), Fusion 0.9.0 (`077c85c`). Source worktrees are implementing explicit lifetime and durable native launch identity; the old locked 0.60.0 is not proof of the target contract.
- Parser/config/registry checkpoint: 57 focused tests passed, including explicit independence, malformed dependencies, frozen lifetime selection and conservative ownership across stale heartbeats.
- One writer per source area: controller/scheduler/lanes; adapter contracts; native UI/projection; parser/types/config/registry. Dependency repositories have separate worktrees and owners.
- Product Revmux backend needs truthful descendant-exit evidence; upstream process-group cancellation alone is insufficient. A dependency patch is investigating an explicitly scoped proof. This remains a delivery gate, not a claimed supported guarantee.
- Controller checkpoint: nine focused real-Git tests passed, covering 51 accepted commits, six status failures, lost spawn reply and restart deduplication, unknown child exit, late success after stop, preserved partial A with independent B, repeated malformed review and rejection of uncommitted checkbox completion. Further integration changes require rerunning these checks.
- UI/projection checkpoint: thirteen focused tests passed; native widget and explicit dependency projection are implemented. Parser/config/registry checkpoint now has sixty passing focused tests.
- Ownership follow-up: local verification/bootstrap commands need durable identity and reconciliation across Pi process death. An ephemeral per-command runner is being implemented; this is not a new always-running service.
- Native workflow completion must attest closed dispatch plus strict proofs from all detached children. The workflow lives inside Pi, so pretending its host process exited is forbidden.
- Revmux dependency commit `5fbd8a6670d1102d613561a504bec66b3258a97d` demonstrates scoped process-group proof and the escaped-descendant limitation. The main adapter rejects that scope. It cannot yet satisfy the full owned-tree guarantee and must not be represented as a successful supported review.
- Independent review reproduced the same escaped-descendant gap in local checks and the native runtime process-group tracker. Production admission must require explicit owned-tree containment; group-only observations are diagnostic. Local nonempty check/bootstrap batches are refused before launch. See [runtime contracts](../runtime-contracts.md).
- Independent review also identified artifact-only recovery bypass, candidate-controlled check discovery, a cancellation-journal crash window and cross-session stop routing. Fixes are being tested, not assumed complete.
- First integrated main test run: 350 tests, 285 passed and 65 failed. Failures are in legacy controller and UI expectations after ownership/acceptance changes; owners are updating fixtures and investigating real regressions. Typecheck and npm package validation passed at this checkpoint. A fresh final run is still mandatory.
- Main draft PR: https://github.com/alexei-led/pi-plan-exec/pull/8. Revmux dependency draft: https://github.com/umputun/revmux/pull/35. No PR is ready and no plan archival is authorized by these checkpoints.
- Dependency pins: native `7a9f03a97c19468f92a9ec78551955da9ef580a7` ([PR 2376](https://github.com/nicobailon/pi-subagents/pull/2376)); Bridge `544f911571ec4552dcc71d5ce548175f1ad7f612` ([PR 2](https://github.com/alexei-led/pi-subagents-bridge/pull/2)); Fusion `766f8bc3c2d39a8e440c11d6e806bd8a45a54887` ([PR 12](https://github.com/alexei-led/pi-fusion/pull/12)). Main package and lockfile use immutable Git refs and Pi SDK 0.86.1.
- Native final checks: 3287 unit tests passed / 12 skipped; 1067 integration tests passed / 7 skipped; typecheck and package build passed. New lint diagnostics are zero; existing legacy lint diagnostics remain and are not reported as a clean global lint run.
- Bridge final checks: 61 tests, typecheck, lint, pack, actual native boundary smoke, actionlint, zizmor and remote CI passed. Fusion final checks: 233 unit + 90 integration + 1 E2E, typecheck, lint and pack passed.
- Main cold-cache `npm ci --ignore-scripts` passed with npm 12.0.2 and project-scoped `allow-git=root`. CI explicitly selects npm 12.0.2 because npm 11.12.1 rejects normalized direct Git refs under this policy. Global npm configuration is unchanged.
- Real Pi RPC smoke passed on the pinned SDK: extension loading, `/exec` and `/goal` registration, isolated `/exec status`, and no model dispatch. This does not imply a successful strict worker execution; admission is correctly blocked by unsupported containment.
- Integrated main gate after fixes: `npm run test:all` passed lint, typecheck, all **364 tests** (zero failures/skips), and package validation (27 shipped files). The earlier 65 failures were resolved; they are retained above as checkpoint history, not current failures.
- CI syntax/security checks: actionlint passed; zizmor offline mode reported no findings. The complete cumulative Revmux review is the next delivery gate.
- Final pre-review follow-up: repeated blocking findings retain a durable pending fix and capped backoff; commit churn does not reset their fingerprint. The restart/backoff regression passed. The fresh complete main gate now passes **365/365 tests**, lint, typecheck and package validation.

## Next step

Review the complete cumulative change with Revmux and fix confirmed critical/major defects. Keep all PRs draft and this plan unarchived. Completing the original target then requires a real owned-process-tree containment backend for native workers, Revmux and local check/bootstrap commands; process-group observations cannot be promoted to that guarantee.
