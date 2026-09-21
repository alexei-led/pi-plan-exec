# Autonomous plan execution

<!-- markdownlint-disable MD013 -->

Status: implemented and verified locally; final cumulative confirmation pending

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

These milestones explain the implementation and validation sequence. Current results and remaining work are recorded below.

- Baseline `0f184ec`: clean isolated worktree; the original checkout and its untracked `.revmux/` were preserved. Node 24.15.0 / npm 12.0.2, locked installation, typecheck, lint, 287 tests and package validation passed before implementation.
- Source audit verified native pi-subagents 0.70.1 (`1ac7b5e`), Bridge 0.3.0 (`cfa60b6`) and Fusion 0.9.0 (`077c85c`), rather than assuming the historical installed versions. Missing runtime contracts required linked source PRs.
- Process-group observations could not prove retirement of escaped descendants. Real Darwin probes verified resource-coalition membership across double-fork, reparenting and setsid. The implementation requires matching host/boot/binding and authoritative coalition retirement; label disappearance or zero-task snapshots are insufficient. Unsupported hosts remain fenced. See [runtime contracts](../runtime-contracts.md).
- Runtime ownership now covers local checks, preparation, promotion, archive, workers and selected review paths. Caller, native and kernel identities remain distinct. Public source pins and the project-local npm Git policy make installation reproducible without changing global packages or configuration.
- Fault tests exposed and corrected candidate-checkout cache pollution, Git environment leakage, decorated review-output parsing, late cancellation races and legacy fixture assumptions. Native unbounded execution also suppresses inherited tool deadlines; explicitly selected command budgets remain separate.
- Actual installed-runtime smoke exercises controller, Bridge/native RPC, owned execution, Git commits, checks, required review, promotion and archive. Model turns are scripted. Packed-consumer checks and saved-session tests additionally exercise shipped helper paths and the installed SDK.
- Review `01` reported 10 major and 8 minor findings. Full non-degraded rounds `02-after-fix`, `03-final` and `04-final` subsequently reported 8 major/2 minor, 6 major, and 3 major/1 minor respectively. Confirmed correctness findings were fixed with regressions; the unrelated minor duplication of an immutable JSON primitive was retained.
- Integrated passing checkpoints progressed through 364, 365, 382, 462, 485 and 491 tests. These earlier results do not certify later edits; the current verification checkpoint is authoritative.

## Review corrections

Revmux round `02-after-fix` reviewed the full cumulative scope with four of four sources and no degradation. Exit 1 reported eight major and two minor findings, with no critical findings. The following corrections require confirmation in the final round:

| Finding | Correction and regression evidence |
| --- | --- |
| `adversarial-1` | Saved-session handoff waits for durable lane creation; source polling survives creation retries and stop fences. Real Git plus installed SDK session fork regression passes. |
| `adversarial-2` | Registry reserves current, output, preparation and retained task/recovery checkouts on both sides of admission. All 43 registry tests pass. |
| `adversarial-3` | Git object paths and status comparisons use the checkout root while workers keep the requested nested cwd. Nested acceptance/archive, independent lanes and `diff.relative` regressions pass. |
| `adversarial-4` | Native nested delegation parses the actual JSON ownership marker and verifies its full binding and kernel membership. Real foreground and async nested launches pass. |
| `adversarial-5` | Audited native pre-dispatch rejection produces durable no-start evidence. Main obtains a correlated cancellation fence and schedules a backed-off retry; it never substitutes this for process-exit proof. Actual controller/Bridge/native smoke confirms zero model sessions for the rejected launch. |
| `adversarial-6` | A plan-drift pause retains proven terminal evidence and moves the task to retry state atomically; repair and resume do not lose ownership history or partial work. |
| `adversarial-7` | Revmux findings may omit a suggested fix. Missing suggestions are explicitly unavailable; blocking severity and other report validation remain strict. |
| `docs+tests-1` | Explicit same-machine recovery can rebind settled and between-step leases after safe local verification, preserving operation and stop state. Actual live PID and CAS races remain fenced. |

Related foreign-host guidance was corrected. The minor duplication of the immutable JSON insertion primitive is retained to avoid an unrelated durability refactor. The Linux CI fixture correction uses the existing idempotent test executor inside three fault-injection wrappers; all real kernel boundary tests remain intact.

## Acceptance traceability

Round `03-final` completed with two of two sources and no degradation, but reported six further major findings. The plan remains active. Their integrated gate passed 485 tests and actual runtime smoke. Follow-through regressions cover crash-safe approved-plan publication and initially untracked plans before another full gate and confirmation review.

| Finding | Correction and regression evidence |
| --- | --- |
| `adversarial-1` | Explicit pause starts cancellation recovery even for an orphaned run selected from an unrelated cwd. The command-level regression retires the old operation without another worker. |
| `adversarial-2` | Explicit approval persists the plan snapshot, refreshes dependency edges, and prevents acceptance before newly added dependencies. Fresh lanes combine approved structure with accepted baseline checkbox facts. |
| `adversarial-6` | A durable generation fence closes incomplete local journals before a successor can start. Independent-process races cover late old intent publication and stale callers; an empty successor batch cannot bypass retirement. |
| `bugs+impl-1` | Read-only source plans do not reserve an entire source checkout. Actual output, preparation and retained writer lanes remain exclusive. |
| `adversarial-3` | Fusion persists replayable preflight intent before asynchronous admission work; restart hydrates and retries the same request, while cancellation still wins. |
| `adversarial-4` | Native dispatch arbitration distinguishes proven early rejection from uncertain launch. Independent-process crash fixtures cover bare claims, prepared operations, dispatch gates and live owners; actual Bridge no-start evidence launches no SDK session. |

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

## Verification checkpoint

- Main through `93d378315ab714403b3cbc5214a6b11f2c7e0fbf`: `npm run test:all` passed lint, TypeScript, all 514 tests (zero failures or skips), and package validation. Fresh Linux CI will verify the pushed revision. A partial-JSON race in the test-only controller-state fixture was fixed with atomic publication before the successful complete rerun.
- Installed-runtime smoke: passed real controller, Bridge/native RPC, no-start recovery with zero model sessions, owned workers/checks, required review, promotion and archive. Model turns are scripted.
- Saved-session handoff: real Git preparation and the installed SDK session fork preserve cwd, parent history and stop fences. SDK source inspection locates missing-cwd validation before session teardown.
- Plan publication: actual SIGKILL and injected ENOSPC preserve the original plan. Tracked and untracked initial plans, lost publication replies, proven failure and repeated approval recover automatically under one operation identity; large content stays outside command arguments.
- Native `0fde758ad54a245935b432e14447c02b03f2b052`: 3339 unit / 1091 integration passed, 14/7 skipped; typecheck, build, package and focused lint pass. Inherited legacy lint diagnostics are unchanged.
- Bridge `1ef889db7ac6a6fa67618a711fbb60b9eb161f9d`: 72 tests, exact native boundary including missing-exit-receipt expiry and fresh-client lookup/cancellation, typecheck, lint, package and remote CI pass.
- Fusion `a80ac608b2af5d357a59a96a6f78ea44b78e40fb`: 255 unit / 125 integration / one E2E, typecheck, lint, package and remote CI pass.
- Revmux dependency `988904f30da351e76c29d5779c6833a6bf890b51`: formatting, build, race-enabled tests, lint and actual CLI lifetime/held-pipe smoke pass on Darwin. Linux tests crosscompile and the Windows package builds. Upstream Ubuntu CI awaits maintainer approval and has executed no jobs; no Linux runtime result is claimed.
- Development review: rounds `02-after-fix`, `03-final` and `04-final` were complete and non-degraded; the corrections above need final cumulative confirmation.

Round `04-final` reviewed the full cumulative main diff through `f6acd95`, native `e5f66f9`, Bridge `5719a27`, Fusion `eb8ab54` and Revmux `398d8f1`. It completed with two of two sources, no degradation, three major findings and one minor finding. Corrections now provide safe controller-lease retirement during Pi session replacement, consistent acceptance facts during plan adoption/publication, native bounded expiry with proven retirement but no exit receipt, and Fusion cancellation precedence.

Initial publication and ordinary untracked-plan recovery now use the same owned atomic publisher as explicit plan adoption. One shared rule preserves trusted initial checkbox facts before the first accepted task commit, then uses accepted-commit facts. Independent reviews confirmed this correction and the session-handoff fixes after additional regressions for transient restore reads, late handoff cleanup, tracked initial plan edits and nested working directories. Both bounded reviews reported no remaining confirmed major or critical defects. Current dependency pins are installed and match the package and installed lockfiles.

Round `05-final` reviewed through main `7fa6469`, native `798b70d`, Bridge `c7ab396`, Fusion `5b41a65` and Revmux `398d8f1`. It completed with two of two sources, no degradation, two major findings and one minor finding. The main correction tracks pending command mutations and allocated run IDs across session replacement, including the publication-before-return boundary. Read-only and UI promises do not hold retirement open; queued resume, rebind and skip cannot clear a newer stop generation. All 255 focused lifecycle tests pass, and independent bounded review reports no remaining major or critical defects. Fusion now atomically records panel intent for direct explicit-lifetime tool starts. Revmux observes direct-child exit before pipe EOF without reaping away its signal identity, retires the group and drains output. Neither correction adds a worker deadline. Dependency revisions and their verification results are recorded above.

Round `06-final` reviewed through main `b456dce`, native `798b70d`, Bridge `c7ab396`, Fusion `a29934f` and Revmux `988904f`. It completed with two of two sources, no degradation and three major findings. Main cold-client cancellation and owner-bound lookup now use v2 independently of capability-cache state; regressions reproduced the v1 failure, and the actual Bridge/native boundary confirms fresh clients recover and cancel the same worker without negotiation or another spawn. Native recovery descriptors and history retain ownership; actual ordinary-resume tests reproduce the former legacy-runner launch and now refuse owned or unknown revival before another lease/runner. Fusion shared admission serializes distinct run IDs across processes with recoverable immutable admission and terminal records. Independent-process barriers, publication crashes, loser retry and targeted cancellation pass. All corrected dependency pins have passed their local gates and bounded independent reviews.

Strict ownership currently requires supported macOS GUI launchd and compiler prerequisites. Strict Fusion early-agreement mode is explicitly refused. Source installation uses the documented project-local Git dependency policy. No release, global installation, persistent daemon or merge is included.

## Next step

Push the verified revision, verify main CI, and run full cumulative confirmation `07-final`. Keep all PRs draft and this plan unarchived until that review passes. Preserve the explicit limitations that upstream Revmux Linux CI is waiting for maintainer approval and mixed/unknown legacy Fusion writers require reconciliation; process-group observations cannot be promoted to owned-tree proof.
