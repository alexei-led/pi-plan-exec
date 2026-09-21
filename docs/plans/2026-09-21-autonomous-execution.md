# Autonomous plan execution

<!-- markdownlint-disable MD013 -->

Status: implementation and integration checks complete; cumulative review in progress

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
- [x] Implement explicit lifetime propagation, effective capability, durable launch reconciliation, cancellation fences and truthful child exit in dependency source worktrees where needed.
- [x] Pin reproducible dependency commits and prepare linked dependency PRs.
- [x] Test actual adapter boundaries, lost replies, restart, stop races and absence of hidden elapsed timers.

## Task 2: Automatic controller recovery

dependsOn: [1]

- [x] Separate ordinary tick from explicit resume/adopt.
- [x] Persist retry/probe scheduling and stop precedence; remove terminal attempt, task-count and transient status caps.
- [x] Validate single-task continuation, four-plus status failures, unknown ownership and restart.

## Task 3: Task scheduling and safe acceptance

dependsOn: [2]

- [x] Parse and validate explicit dependencies, preserving legacy sequential semantics.
- [x] Persist task states, attempt history, accepted baseline, candidate verification and fair ready/retry selection.
- [x] Preserve failed partial lanes; bootstrap clean replacement lanes as a separately recoverable operation.
- [x] Verify A blocked → independent B completes → C waits for A, partial-work isolation and retry integration.
- [x] Verify 51-plus tasks, crash around acceptance, dependency errors and no permanent recovery parking.

## Task 4: Required review

dependsOn: [2]

- [x] Default to one required subagent reviewer under a shared backend contract.
- [x] Add explicit Revmux/Fusion selection and fallback policy with ownership fencing.
- [x] Validate malformed review recovery, persistent blocking findings and reviewed commit identity.

## Task 5: Recovery visibility and restart

dependsOn: [3, 4]

- [x] Restore authorized unfinished operations automatically without stealing a live owner.
- [x] Extend native status/widget with task counts, wait reasons, verified activity, next action, attempts and available usage.
- [x] Isolate UI/pi-tasks failures and optional reporting from execution.
- [x] Validate all 19 acceptance scenarios from the approved design using deterministic fault injection plus an integration smoke test.

## Task 6: Verification and delivery

dependsOn: [5]

- [x] Run project checks (`npm run check`, `npm test`, `npm run lint`, `npm run pack:dry`) and dependency checks.
- [ ] Run independent Revmux review of the full cumulative diff from the recorded baseline; fix confirmed critical/major findings and verify fixes.
- [x] Record manual/E2E evidence and remaining limitations.
- [ ] Commit logical changes, push the new branch, and create a new PR with linked dependencies.
- [ ] Only after every required gate passes, archive this plan under `docs/plans/completed/` and mark the PR ready.

## Historical checkpoints

These record intermediate findings. The final verification and next-step section below supersedes their earlier blocker and pending-work statements.

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
- Main draft PR: [pi-plan-exec #8](https://github.com/alexei-led/pi-plan-exec/pull/8). Revmux dependency draft: [revmux #35](https://github.com/umputun/revmux/pull/35). No PR is ready and no plan archival is authorized by these checkpoints.
- Dependency pins: native `7a9f03a97c19468f92a9ec78551955da9ef580a7` ([PR 2376](https://github.com/nicobailon/pi-subagents/pull/2376)); Bridge `544f911571ec4552dcc71d5ce548175f1ad7f612` ([PR 2](https://github.com/alexei-led/pi-subagents-bridge/pull/2)); Fusion `766f8bc3c2d39a8e440c11d6e806bd8a45a54887` ([PR 12](https://github.com/alexei-led/pi-fusion/pull/12)). Main package and lockfile use immutable Git refs and Pi SDK 0.86.1.
- Native final checks: 3287 unit tests passed / 12 skipped; 1067 integration tests passed / 7 skipped; typecheck and package build passed. New lint diagnostics are zero; existing legacy lint diagnostics remain and are not reported as a clean global lint run.
- Bridge final checks: 61 tests, typecheck, lint, pack, actual native boundary smoke, actionlint, zizmor and remote CI passed. Fusion final checks: 233 unit + 90 integration + 1 E2E, typecheck, lint and pack passed.
- Main cold-cache `npm ci --ignore-scripts` passed with npm 12.0.2 and project-scoped `allow-git=root`. CI explicitly selects npm 12.0.2 because npm 11.12.1 rejects normalized direct Git refs under this policy. Global npm configuration is unchanged.
- Real Pi RPC smoke passed on the pinned SDK: extension loading, `/exec` and `/goal` registration, isolated `/exec status`, and no model dispatch. This does not imply a successful strict worker execution; admission is correctly blocked by unsupported containment.
- Integrated main gate after fixes: `npm run test:all` passed lint, typecheck, all **364 tests** (zero failures/skips), and package validation (27 shipped files). The earlier 65 failures were resolved; they are retained above as checkpoint history, not current failures.
- CI syntax/security checks: actionlint passed; zizmor offline mode reported no findings. The complete cumulative Revmux review is the next delivery gate.
- Final pre-review follow-up: repeated blocking findings retain a durable pending fix and capped backoff; commit churn does not reset their fingerprint. The restart/backoff regression passed. The fresh complete main gate now passes **365/365 tests**, lint, typecheck and package validation.
- Initial cumulative Revmux review: `comprehensive`, main `0f184ec..76de0c2` plus all four dependency baselines; 4/4 sources reported, no degradation. It confirmed 10 major and 8 minor findings (no critical); two additional findings were classified immaterial. Confirmed fixes are in progress and require a fresh integrated gate and confirming review.
- Fixes cover durable review-start replay and never-started cancellation, exact Git status/progress paths, candidate retry identity, accepted checkboxes, optional advisory review, original output-branch promotion, valid skip/hostname guidance, and documentation. Unbounded status no longer invents a deadline from turn counts.
- Fusion follow-up pin `5275cfd08464132daf84e5c616aa2f925d01ce62` adds atomic dispatch-versus-cancel admission and explicit replay-safe absence. Its 236 unit + 94 integration + 1 E2E, lint/typecheck/pack and remote CI pass. The runtime containment blocker is unchanged.
- Post-review integrated gate: `npm run test:all` passed lint, typecheck, **382/382 tests** (zero failures/skips), and package validation. Confirming cumulative review is still pending; subsequent runtime changes require another complete gate.
- Containment feasibility on the current macOS host: temporary launchd jobs received distinct resource coalitions; double-forked, reparented `setsid` descendants retained membership. Generation-qualified signaling rejected a stale identity and terminated the correct child. A launchd label disappeared before its descendant exited, so label absence is explicitly insufficient. Previously observed coalitions retired after cleanup. All probe jobs/processes were removed; no permanent service or global installation was created.
- The feasibility result establishes an implementation path, not production support. The kernel backend must bind durable admission to host/boot and a known coalition, prevent execution before registration, and require authoritative retirement rather than a zero-task snapshot. Unsupported APIs, unknown records and ownership ambiguity remain fenced. See the [pinned XNU retirement implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/coalition.c#L2241).
- Active ownership: native containment module/tests have one owner; existing native runtime integration/exports have another. Main local-operation files and controller retry identity have separate owners. No production kernel backend is claimed complete at this checkpoint.
- Kernel implementation checkpoint: a real workload launched through the durable gate, returned exit zero and reached kernel-confirmed coalition retirement. Natural workload completion waits for detached descendants; it does not kill them and report success. Independent review found a bootstrap-publication crash window that could prevent replay; same-label replay under immutable admission is being validated, along with bounded control deadlines and cancellation reconciliation after supervisor loss.
- Integration checkpoint: Bridge uses the direct owned single-agent route; Fusion uses an owned structured parallel graph and an owned single judge. Strict early-agreement profiles are rejected before dispatch until the structured runtime supports that policy. Main local checks use an authored executable module, and the shared launcher becomes an exact production dependency rather than an optional development-only import. New dependency commits and lockfile installation are pending; the earlier 382-test result does not validate these changes.
- Identity contract: the public caller, native operation and kernel launch have separate IDs and digests. Providers validate each durable mapping before attesting an outer caller binding. Kernel observation, admission identity and retirement proof must agree within the kernel namespace; unrelated layer digests must never be equated.
- Remaining acceptance gaps identified by read-only audit: explicit `waiting_external` assignment and automatic fair wake; adaptive persisted bounded-session budgets; durable phase/tool diagnosis and evidence-based recovery; fresh 51-task and UI-failure integration coverage. Some checks run during concurrent edits failed and must be rerun after the dependency boundary is installed. No current all-green integrated result is claimed.
- Work resumed after a temporary agent usage-limit interruption. Edits remain in their assigned worktrees; required final review, clean commits and delivery are still pending.
- Revmux dependency now points to commit `398d8f11c13737cb26354fa963e0b347abcc916d` in the existing draft PR. It adds supported `--execution-lifetime=unbounded|bounded` selection and capability advertisement. Unbounded mode suppresses both executor watchdogs and rejects conflicting finite timeout flags. Formatting, build, race-enabled tests, lint and actual CLI lifetime smoke passed. Its internal process proof remains explicitly group-scoped; full tree proof comes from the external owned runtime.
- Main package dry-run passed after replacing the local worker with an authored `.mjs` executable: 27 shipped files. A real packed-consumer execution check is still required after the new native dependency revision is available.
- Installed-package validation subsequently passed: 15 local executor tests without a source override, ordinary TypeScript check, and an isolated packed consumer with one actual execution across concurrent calls and replay. npm 12 needs consumer-scoped `allow-git=all` for the temporary transitive Git dependency; no global npm setting was changed.
- First composed runtime smoke exposed two integration defects: native compiler cache files polluted the candidate checkout, and review extraction consumed a decorated summary instead of the actual single reviewer output. Both were fixed at their producing/consuming boundaries. The smoke now passes against native `8c4b12cf762cc59c5eca008cf1d00787744dd920` and Bridge `1a00aa2b02cd967675697944976e2d144feb6ef0`, with a real controller, RPC, owned processes, Git commit, local checks, required review, fast-forward promotion and archive. Model turns are scripted. Worker and check scopes retired, both repository and lane stayed free of unexpected files. Rerun after the remaining Git ownership changes.
- Fusion commit `07f327d2df4d72feddc8fa5a08de74391773c8c9` freezes and enforces review `cwd` and `reviewedCommit` through panel, judge and restart. The real public `executePublic` path was tested with distinct repositories; all three child processes used the candidate checkout. Its 250 unit, 105 integration and one E2E tests, lint, typecheck, package validation, actual push hook and remote CI passed. Earlier internal-executor-only evidence does not certify the public parallel route.
- Restart reconciliation now preserves operation IDs and candidate/result identity. Replay-safe absence is distinct from exit or never-started proof. Native global operation anchors preserve the original scope even if Pi restarts in a different worktree. Explicit pause is being completed as a resumable cancellation fence, including a control-only path that does not wait behind a pending launch or diagnostic request.
- Structured phase/tool diagnostics preserve real event evidence. A stable, operation-bound diagnostic action can queue at most one follow-up after a confirmed tool error; queued guidance is not proof of repair. Silence and CPU/I/O never establish a fault. Optional UI projection coalesces one in-flight update and one latest snapshot rather than retaining an unbounded queue.
- Remaining ownership correction: controller-created worktrees, output promotion and archive Git mutations need durable owned execution before adoption of visible directories or HEAD changes. Initial run intent must precede worktree creation. Real hook/parent-death regressions are required. Git repository-routing environment variables must not escape from a parent hook into another lane; main and native launch boundaries are being hardened, preserving identity and authentication settings.
- Remaining lifetime correction: native upstream has separate inherited per-tool defaults. Explicit unbounded mode must suppress these as well as session deadlines; only an explicitly selected command budget may remain finite. Test an actual open tool across the virtual thirty-minute boundary. In bounded compatibility mode, growth requires verified useful activity near expiry; unknown or stale activity instead schedules a changed recovery approach without rewarding a suspected stall.

## Acceptance traceability

The scenario numbers below refer to section 13 of the approved autonomous execution design. Test presence is not a passing result; the final verification checkpoint must record the completed suites.

| Scenario | Regression evidence |
| --- | --- |
| 1. External prerequisite A, independent B, dependent C | `test/autonomous-controller.test.ts`: external prerequisite and isolated lane recovery |
| 2. Repeated status failures | Autonomous controller status uncertainty beyond the diagnostic burst; legacy controller status-error recovery |
| 3. Lost spawn, delayed start, cancellation and restart | Controller lost-reply/stop races; Bridge actual native-boundary suite; native delayed-admission tests |
| 4. Live worker after control timeout | Autonomous controller wrapper failure without exit evidence and ownership fencing |
| 5. Effective no-deadline and explicit compatibility mode | Native actual executor/tool virtual-time tests; Fusion panel/panelist/judge lifetime propagation; main silent-worker and adaptive bounded-budget tests |
| 6. More than fifty tasks and unlimited retries | Autonomous controller accepts fifty-one distinct Git commits; scheduler attempt-cap regression |
| 7. Partial work isolation and conflict recovery | Autonomous controller A/B/C lane test, accepted-baseline retry and output-promotion tests |
| 8. Persisted automatic diagnosis and recovery | Controller status, phase/tool diagnosis, restart and changed-strategy tests; `test/diagnostics.test.ts` |
| 9. All work blocked with an automatic wake | Controller two-independent-prerequisite regression preserves evidence, avoids pre-due launches and retries automatically under deterministic time |
| 10. Dependency validation and truthful completion | `test/plan.test.ts` dependency cases; committed-checkbox acceptance tests |
| 11. Repeated findings and commit churn | Autonomous controller repeated blocker, unchanged finding and minor-advisory tests |
| 12. Malformed review and safe fallback | Autonomous controller repeated malformed review and unknown-backend lookup tests; `test/review-backend.test.ts` |
| 13. Stop outranks late success and retry | Controller stop/pause races; local operation cancellation, active-index and restart tests |
| 14. Crash around acceptance | Autonomous controller same-candidate recovery and accepted-task replay tests |
| 15. UI and task projection cannot block recovery | `test/ui-controller-integration.test.ts` pending projection and throwing UI during live recovery; optional projection tests |
| 16. Reload, live leases and unavailable Fusion operations | UI startup restoration, registry ownership, controller and review-backend restart tests |
| 17. Stats and archive recovery | Controller optional statistics, owned archive and repeated archive failure tests |
| 18. Lifetime and digest survive adoption | Bridge, lifecycle and review-adapter binding/lifetime tests; actual installed-runtime smoke |
| 19. Evidence-based diagnosis and unbounded stop | Diagnostic evidence tests, bound tool follow-up deduplication, real detached-descendant retirement and monitor-death tests |

## Next step

Final integration checkpoint: durable Git mutations, private local-operation cancellation indexing, Git environment isolation, unbounded tool handling, and activity-qualified bounded recovery are implemented. Restarted pause/cancel retains the worktree fence until matching full-tree retirement or never-started proof. Focused cancellation/restart tests and the installed runtime smoke passed. The smoke exercises real controller, Bridge/native RPC, owned processes, Git changes, required local checks, single-subagent review, promotion and archive; only model turns are scripted.

Current pinned revisions: native `778d7aeac0c6a8056f316f2e2a38381570c7bcae`, Bridge `fbd2a53199f37cd68eb5c2b9db1482246979ffa5`, Fusion `07f327d2df4d72feddc8fa5a08de74391773c8c9`. Revmux CLI dependency remains `398d8f11c13737cb26354fa963e0b347abcc916d`. Final native full suites passed: 3325 unit passed/14 skipped and 1080 integration passed/7 skipped. The latest revision fixes a demonstrated observation race: exit metadata must be reread after the kernel confirms retirement. Its deterministic regressions fail on the old source and pass after the fix; 21 boundary tests and 18 actual-host/package tests also passed. Inherited legacy lint diagnostics are unchanged and new modules pass lint. Bridge has 72 passing tests; repeat its actual native boundary on the final pin. Fusion has 250 unit, 105 integration and one E2E passing tests plus passing CI. Revmux formatting, build, race-enabled tests and lint passed.

The earlier main full suite exposed stale unit fixtures. The updated goal/package/registry tests passed, the registry ownership-corruption regression passed, and all 60 autonomous controller tests now pass with a portable idempotent test executor. The legacy controller suite also passes all 94 tests after explicit operation bindings and durable archive-phase expectations were corrected; its former deferred-result hangs now fail promptly when a fixture cannot reach the expected boundary. Production ownership remains covered by actual kernel tests and the installed-runtime smoke, which passed again on the final pins. The exact final Bridge/native boundary also passed, including delayed launch, lost reply, restart, tool-guidance deduplication, detached descendants and root termination. Main typecheck, lint and package validation passed individually; the combined full main suite is running after legacy controller fixture corrections.

Final main gate passed: `npm run test:all` completed lint, TypeScript, all 444 tests (zero failed or skipped), and package validation. The installed-runtime smoke also passed on the final pins. All four dependency feature worktrees are clean, committed and pushed.

Commit the main implementation and review the complete cumulative change with Revmux (the new kernel/runtime surface requires the comprehensive profile). Fix confirmed critical/major defects, verify the fixes and publish the remaining commits. Keep all PRs draft and this plan unarchived until the review passes; process-group observations cannot be promoted to owned-tree proof.
