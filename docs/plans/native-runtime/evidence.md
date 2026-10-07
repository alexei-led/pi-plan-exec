# Native runtime verification evidence

## Current candidate and authority

This supersedes the earlier partial-characterization narrative (retained in Git
history). The candidate now uses unmodified released `pi-subagents@0.76.1` through
one keyed public workflow. Production Bridge/pi-tasks transport/dependencies are
removed; the readonly legacy snapshot reader remains. Pi is `1.0.4`, Node
`24.15.0`, npm `12.0.2`; package version remains `1.8.0`. No upstream patch,
global/live executor upgrade, paid API, push, release or PR dispatch is part of
this verification.

The reviewed implementation checkpoint is `c6d3d231a54c18c47d1a8c70ce47290e436e4a4b`.
Its recorded full gate was **725 Vitest + 143 node:test = 868**, not the historical
591/594/626 counts. The final verification slice adds the rollback regression,
actual parent-death barrier and expanded deterministic packed-consumer probes.
That prior full unit run was **728 Vitest + 143 node:test = 871**, all passing.
The remaining-contracts slice starts from parent commit
`1440897de7e6ee212d557f22d23de415ff19d23f`, preserving its real-controller S23
probe and corrected scenario IDs. Existing gate commands now include 6 recovery,
4 parent-death/barrier tests and 15 packed modes; no new CI command is needed.
The settled remaining-contracts tree passed its single broad `test:all` run:
**729 Vitest + 143 node:test = 872**, plus 3 runtime, 6 recovery,
4 parent-death/barrier and 1 packed-consumer test (15 modes), all passing with
zero skips. Check/TypeScript passed with seven informational diagnostics;
pack:dry contains 41 files. The authoritative **remaining-contracts.json** handoff
and external bundle manifest record the final commit, exact logs and SHA-256
hashes. Focused failures and test-fixture corrections are retained separately;
no production source change was needed. Independent review of this new slice and
parent-owned final scenario/checkbox acceptance remain outstanding.
The four production findings were accepted by both independent rechecks.
The scoped D1–D9 architecture sweep found no blocking defect (one low-severity
RPC-plumbing duplication note remains). Final scenario acceptance is still
partial: passing local gates do not waive the explicitly unrun cases below.

## Missing-skill admission follow-up

This bounded follow-up starts from `dcc1ede19c6e001017bdb21da90c9902ec544eba`.
The required missing-skill refusal was observed red before production changes.
The application gate and explicitly approved fixed-owned-role discovery exception
are described below and in `docs/runtime-contracts.md`. Normal-loader scenarios
now number 18. One settled-tree broad gate passed: **750 Vitest + 143 node:test =
893**, plus 3 runtime, 6 recovery, 4 parent-death/barrier and 1 packed-consumer test
(18 modes), zero failures/skips. Check/TypeScript passed with seven informational
diagnostics; pack:dry contains 41 files. The **missing-skill-admission.json**
handoff and external actual-diff bundle record red/green logs and the exact commit.
Independent review of this new production admission change remains required;
plan markers and exact scenario IDs remain parent-owned and unchanged.

## Reproduce and inspect results

From this worktree (all runtime fixtures isolate HOME, registry, sessions, Git
repositories and deterministic local models):

```bash
npm exec --yes --package=npm@12.0.2 -- npm run test:all
npm exec --yes --package=npm@12.0.2 -- npm run test:native-contracts
actionlint .github/workflows/ci.yml
zizmor --offline .github/workflows/ci.yml
git diff --check
```

`test:all` includes check, the full Vitest and node:test suites, runtime smoke,
native recovery, real parent-death, packed consumer and pack:dry. The focused
contract command is a reusable subset, not extra duplicated scenarios. The
external bundle includes the actual full-candidate and follow-up diffs produced
with `--no-ext-diff --no-textconv`, final gate logs and clean-index proof.

**Linux: NOT RUN; separate acceptance waived by the operator.** No Docker daemon is available and no VM/service or
remote workaround was provisioned. `.github/workflows/ci.yml` now wires four
bounded Ubuntu native jobs (contracts/runtime/recovery/packed) with pinned
Node/npm, full-history checkout for the frozen regression, pipeline failure
propagation and retained logs/fixture diagnostics. Successful actionlint/zizmor
is configuration evidence only, not CI execution. Cross-platform confidence and
live-model reliability are not newly established.

## New observed host facts and limitations

- **S23:** SIGKILL is delivered to the known spawned parent ChildProcess after a
  child-written launch barrier. The same child PID/session heartbeat advances
  after parent death. A fresh host runs the real PlanExecController tick path, acquires the
  management lease, polls the original operation and emits no replacement
  dispatch; one side effect is recorded. Native parent-observed retirement is
  missing, so the operation remains bound/reserved. OS exit is recorded for the
  exact fixture child; it is not substituted for native retirement proof.
- **S08/S09/S11:** a filesystem-only interposer stops after actual `run.json`
  rename at the prepared and dispatch-claimed barriers. The fixture-owned parent
  is then SIGKILLed. A fresh real controller launches prepared intent once; it
  never replays the claimed-but-unemitted request. For S11 the real successful
  reply precedes an actual permission-denied binding rename (`chmod 0555`,
  `EACCES`), then parent death. After restoring permissions, a fresh controller
  recovers the exact original root with zero new spawns and one side effect.
  These are process-crash/publication probes, not physical power-loss tests.
- **S25:** the real local model calls `contact_supervisor`; the fixture replaces
  the Pi parent **while the question is still unanswered** (no tool result or
  side effect). Restoring the actual saved session lets the supported public
  `subagent_supervisor` reply find the original request. The reply reaches the
  same child/session and produces one commit, with no replacement. User pause
  wins. `/subagents-detach` still reports **No active foreground run found** for
  this already-async path. After parent replacement, child completion without
  original-parent retirement observation keeps controller state bound; no
  proof-backed controller acceptance is fabricated.
- **S28:** an 8000ms bound expires while the real local-model request is held.
  Both workflow and child publish timeout failures; the live parent publishes
  exact observed runner-instance close proof. This is enforcement evidence, not
  a captured launch option. Controller budget-growth tests remain separately
  labelled C.
- **S33/S34 application admission:** the packed missing-skill test first failed
  on real model execution. The native adapter now validates its saved fresh child
  through the lazy public preflight API before dispatch CAS. Missing selected
  skill, missing agent and denied lazy read remain `prepared`, with actionable
  refusal and zero native spawns/model calls. A valid selected skill executes
  under an enforced `scoped` policy using a non-parent worker model; required
  review uses `inherit` and still completes. A physically absent optional peer
  permits normal-loader startup and the existing zero-attempt runtime prerequisite.
  Readonly tool refusal and structured_output-only settlement remain covered.
- **Owned-role discovery exception:** the first guarded valid-skill run exposed
  the public API's inability to discover runtime-registered `plan-exec-reviewer`.
  With supervisor approval, only our successfully registered, undisposed, exact
  readonly reviewer/stats role (`skills: []`, `inheritSkills: false`, no model
  override) can pass the plain unknown-agent result. Its registration is checked
  again after the await and before emit. Configured collision/invalid definition,
  any other missing agent and every other preflight failure refuse. Native still
  enforces this role's model/tools/schema: preflight does not see or validate its
  definition. The exception uses the existing registration lifecycle, not agent
  files, private discovery, a policy framework or a user toggle. Upstream's raw
  missing-skill warning behavior is distinct from application admission.
- **S42/S45:** one isolated host loads byte-checked frozen 1.8.0 controller,
  registry and BridgeClient source from `bc5fb6e`, plus the actual published
  `@alexeiled/pi-subagents-bridge@0.5.5` package. Its real historical workflow
  holds an active child and registry lease. A second, simultaneous new host
  invokes the real new controller start/resume paths; both refuse competing
  ownership with unchanged old record bytes and zero dispatches. After deliberate
  old-controller quiescence, Bridge unsubscribe and lease release, the original
  native parent observes exact workflow/child retirement. A consistent SQLite
  backup is imported by a fresh new controller: same operation/digest/params,
  readonly snapshot bytes, accepted original candidate, one side effect and
  zero root replay. Only disposable journals/packages/repositories are touched.
- **S43/S44:** existing SQLite tests hold a real exclusive transaction and test
  committed versus uncommitted WAL data. Existing abandonment fault tests place
  a file at `.abandoned` (backup failure) and a directory at archived `run.json`
  (final rename failure), preserving management state and active reservations.
  A new real `EACCES` import-publication test restores directory permissions and
  retries the same operation without modifying snapshot bytes, claiming a lease
  or issuing RPC. The separate CAS-race tests remain labelled C, not process
  crashes. None of these asserts physical power-loss/fsync durability.
- **S53 correction, approved by supervisor:** frozen 1.8.0 does **not** reject
  native-format schema-1 records. The test byte-compares extracted registry
  source to `bc5fb6ef800b6e88f3edeef542869bbd84a9ed3a`, invokes that exact code,
  demonstrates reservation refusal separately from parse acceptance, and then
  demonstrates actual unsafe old cleanup of terminal native artifacts and,
  separately, corrupt ownership. No schema change conceals this result.
  `src/rollback-preflight.mjs --registry /absolute/directory` is readonly and
  blocks all retained native records/history/artifacts, malformed/unreadable
  data, symlinks and inspection limits. Quiesce writers first. Direct old-version
  execution bypasses the supported preflight and remains unsafe.
- **S54:** a separately installed tarball executor (hashed tarball + complete
  `src` fingerprint) runs against a different target Git repository with the
  actual pinned old dependencies. The native worker removes both from that
  target only. The same unchanged executor completes checks, required typed
  review, the removal commit and final archive commit. Neither old package is
  resolvable/present in the final target or executor package root.

Unknown proof deliberately retains fixture artifacts/reservations; a delivered
stop, fixture disposal, process-not-found result or child-success prose never
manufactures retirement. Baseline high-severity dependency advisory remains
unfixed; no unrelated audit upgrade was performed.

## Exact S01–S56 scenario map

P = pure/table; C = controller/client with real temp registry/Git and controlled
external boundary; H = actual released Pi/public RPC/native runner with local
model; X = separate processes/fault barriers. PASS is scoped to the named tests
and stated layers, not every conceivable timing or all platforms. Historical
Bridge/Fusion words in old test titles generally name preserved controlled
boundaries. S42/S45 additionally load actual old code/package in an isolated
fixture; this is not a restored production Bridge launcher. Template titles are the exact source
names of parameterized tests. Packed entries additionally identify their mode.
The table explicitly leaves genuine host-level gaps/unsupported guarantees open.

| ID | Scenario from approved plan | Local result / actual layer | Concrete test(s) | Scope / unresolved limitation |
| --- | --- | --- | --- | --- |
| S01 | Plan in new worktree, in place, explicit existing worktree, nested cwd | PASS C/H | `test/controller.test.ts` — **existing linked worktree execution keeps its branch and plan**<br>`test/controller.test.ts` — **in-place execution on the default branch keeps that branch**<br>`test/autonomous-controller.test.ts` — **nested execution keeps the worker cwd with plan in ${planDirectory}**<br>`test/git.test.ts` — **plans execution worktree paths without running Git before durable intent exists**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | C covers worktree/nested variants; H packed `plan` uses in-place target. |
| S02 | Legacy sequential dependencies and explicit independent tasks | PASS C | `test/autonomous-controller.test.ts` — **nested independent task lane preserves the cwd and excludes partial work**<br>`test/autonomous-controller.test.ts` — **external prerequisite A preserves its lane while B completes and C waits until automatic recovery** | Real temp Git lanes; unknown original writer is not reclassified dead. |
| S03 | Untracked/tracked plan, approved structural change, dirty partial lane | PASS C | `test/autonomous-controller.test.ts` — **initial untracked plan publication recovers a partial write with its original authorized checkbox facts**<br>`test/autonomous-controller.test.ts` — **explicit approval must match the current plan snapshot**<br>`test/controller.test.ts` — **plan structure drift pauses for review and resumes after repair**<br>`test/autonomous-controller.test.ts` — **nested independent task lane preserves the cwd and excludes partial work** | Tracked/untracked plan publication, explicit approval and partial-lane preservation; controlled filesystem faults, not physical power loss. |
| S04 | `/goal` intermediate answer, done claim, failing checks | PASS C/H | `test/autonomous-goal.test.ts` — **a goal continues after an intermediate answer and completes when checks pass**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/autonomous-goal.test.ts` — **a goal that claims done with failing checks continues instead of completing** | H packed `goal`; durable checks and review/archive remain mandatory. |
| S05 | Goal stall, turn budget, blocker, deleted/skipped tests | PASS C | `test/autonomous-goal.test.ts` — **a goal that claims done with failing checks continues instead of completing**<br>`test/autonomous-goal.test.ts` — **goal completion pauses when the diff deletes tests**<br>`test/autonomous-goal.test.ts` — **three turns without progress pause the goal and launch nothing further**<br>`test/autonomous-goal.test.ts` — **a goal paused for its turn budget grants more turns on explicit resume**<br>`test/autonomous-goal.test.ts` — **a failed native child cannot complete a goal by printing GOAL_DONE** | False completion, test deletion, no-progress/turn budgets and explicit resume are controller probes. |
| S06 | Native worker, fixer, reviewer, optional stats | PASS C/H | `test/native-activation.test.ts` — **production native ${mode} completes detached worker and required readonly reviewer**<br>`test/native-runtime.test.ts` — **prepare records unsupported limits honestly and freezes configured agent/model into awaited child**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Real worker/fix/review/stats dispatch and normal-loader effective tool/schema controls. Frozen requested model/cwd are also checked at the adapter boundary; unsupported controls stay explicit. |
| S07 | Concurrent starts/resumes through path aliases | PASS C/X | `test/registry-lock.test.ts` — **two crash recoverers admit only one run while the first pauses before publication**<br>`test/registry-lock.test.ts` — **cross-process compare-and-set applies exactly one shared revision**<br>`test/registry.test.ts` — **concurrent starts through different path aliases admit exactly one run**<br>`test/controller.test.ts` — **same-session concurrent resumes launch one operation** | Kernel lock cross-process admission plus lease/CAS races. |
| S08 | Crash before preparation / prepared before dispatch claim | PASS C/H/X | `test/native-parent-death-smoke.mjs` — **S08 fresh controller recovers the real prepared filesystem barrier without duplicate launch** | Actual atomic prepared publication, fixture-owned parent SIGKILL, fresh real controller: zero origin spawns, one authorized recovery launch and one effect. |
| S09 | Crash after dispatch claim before event emit | PASS C/H/X | `test/native-parent-death-smoke.mjs` — **S09 fresh controller recovers the real dispatch filesystem barrier without duplicate launch** | Actual dispatch-claim publication before bus emit, fixture-owned parent SIGKILL, fresh real controller: zero original/recovery spawns, zero effects and dispatching uncertainty retained. |
| S10 | Worker launched, reply dropped | PASS C/H/X | `test/native-runtime.test.ts` — **correlated completion retains binding after lost reply without replay or late abandoned writes**<br>`test/native-recovery-smoke.mjs` — **selected keyed workflow recovers exact request correlation across fresh OS hosts without redispatch**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Packed `plan` drops actual spawn reply; fresh-process keyed workflow probe observes one effect. |
| S11 | Reply received, persistence fails, then restart | PASS C/H/X | `test/native-parent-death-smoke.mjs` — **S11 fresh controller recovers the real binding filesystem barrier without duplicate launch** | Successful real reply followed by actual EACCES binding rename, then parent SIGKILL. Permissions restored; fresh real controller binds the exact original root, no replay, one effect. |
| S12 | Completion arrives before reply / duplicate or late events | PASS C/H | `test/native-runtime.test.ts` — **correlated completion retains binding after lost reply without replay or late abandoned writes**<br>`test/native-runtime.test.ts` — **late response binds after stop without overwriting stop intent; queued rejection is retryable**<br>`test/native-runtime.test.ts` — **correlated completion retains binding after lost reply without replay or late abandoned writes**<br>`test/native-recovery-smoke.mjs` — **selected keyed workflow recovers exact request correlation across fresh OS hosts without redispatch**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Exact correlation and late cancellation/abandonment facts are covered; real lost replies complement controlled early/late delivery. |
| S13 | Native pre-dispatch invalid-params rejection vs runtime failure | PASS C/H | `test/native-runtime.test.ts` — **no-child failed workflow can retire but never supply task success**<br>`test/native-runtime-contract.test.ts` — **released public RPC characterizes rejection, stop parity, ownership, and missing proof**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | No-child failure is not success; real missing configured agent refuses before model work. |
| S14 | Reused operation UUID with different params/session/generation | PASS P/C | `test/native-runtime.test.ts` — **registry rejects changed native request/digest and ownership**<br>`test/native-runtime.test.ts` — **native request digest binds controller task, review iteration and candidate before dispatch** | Immutable request, domain identity and ownership refusal; no UUID reuse with modified intent. |
| S15 | Extension reload, session fork/switch, process restart | PASS C/H/X | `test/index.test.ts` — **pending start retires its late allocation at ${phase} across session replacement**<br>`test/index.test.ts` — **a queued resume from another directory cannot override a replacement session's pause**<br>`test/native-runtime.test.ts` — **disposal settles pending RPC without permitting replay and removes listeners**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/controller.test.ts` — **resume consumes a settled detached stats child without launching a replacement**<br>`test/index.test.ts` — **generic paused operation guidance does not invent a supervisor request**<br>`test/index.test.ts` — **user-pause intent precedes generic recovery advice: ${error}**<br>`test/native-runtime.test.ts` — **correlated completion retains binding after lost reply without replay or late abandoned writes**<br>`test/native-recovery-smoke.mjs` — **selected keyed workflow recovers exact request correlation across fresh OS hosts without redispatch**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Session replacement/disposal at controller boundaries, real host restart and packed reload. Pending supervisor question after parent replacement remains an S25 gap. |
| S16 | Long quiet tool / stale lastUpdate / no activity event | PASS C | `test/autonomous-controller.test.ts` — **diagnostic capability does not trigger guidance or cancellation for a silent healthy tool**<br>`test/autonomous-controller.test.ts` — **status uncertainty beyond diagnostic burst preserves one writer and automatic wake**<br>`test/autonomous-controller.test.ts` — **advisory observations cannot become verified progress or retirement** | Healthy silence is not death; diagnostic budget alone cannot stop or replace writer. |
| S17 | Native extension unavailable at startup or during status | PASS C | `test/autonomous-controller.test.ts` — **unavailable runtime preflight is an explicit prerequisite and does not consume a worker attempt**<br>`test/autonomous-controller.test.ts` — **structured tool diagnosis preserves the session and schedules probes without unsupported repair**<br>`test/autonomous-controller.test.ts` — **doctor preserves the same launch identity when an empty lookup races a late spawn** | Capability/prerequisite failures keep identity without silent repair, replay or unsupported guidance. |
| S18 | Pause, ordinary stop or permanent force-stop before dispatch | PASS C | `test/native-runtime.test.ts` — **stop before emit retires locally without launch; foreign control and abandoned writes denied**<br>`test/controller.test.ts` — **force stop wins while native readiness is pending without dispatch**<br>`test/native-runtime.test.ts` — **abandoned stop refusal stays pending, foreign control refuses, and prepared operations never emit** | Authorization checked before emitting the public request. |
| S19 | Stop/force-stop races spawn, capability lookup or late success | PASS C | `test/autonomous-controller.test.ts` — **late successful worker after stop cannot accept its candidate**<br>`test/controller.test.ts` — **force stop fences a pending archive observation and holds the checkout until tick retirement**<br>`test/index.test.ts` — **force stop refreshes a foreign observer and suppresses late completion (stale=${staleCompletion})**<br>`test/native-runtime.test.ts` — **cancellation recovery binds a lost launch but cannot consume a successful review or revive the run**<br>`test/native-runtime.test.ts` — **abandoned lost spawn resolves its exact alias and stops without ordinary binding writes**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Late success/stop race cannot accept candidate or revive final management state. Packed lost-reply force-stop targets the exact alias-resolved root. |
| S20 | Stop delivery timeout / invalid-state / lost ack / repeated stop | PASS C | `test/autonomous-controller.test.ts` — **pending native cancellation errors survive observations and restart until delivered**<br>`test/autonomous-controller.test.ts` — **pause cancellation reply loss retries the same fence without claiming worker exit**<br>`test/native-runtime.test.ts` — **native stop refuses mismatched ${wrong} delivery and retries only the same bound run**<br>`test/native-runtime.test.ts` — **native stop refuses mismatched ${wrong} delivery and retries only the same bound run** | Persisted stop intent retries exact bound identity; a lost acknowledgement is not death. |
| S21 | Running, queued, paused, supervisor-wait child stops | FULFILLED H; SELECTED-ROUTE LIMIT | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/native-runtime-contract.test.ts` — **released public RPC characterizes rejection, stop parity, ownership, and missing proof**<br>`test/autonomous-controller.test.ts` — **pending native cancellation errors survive observations and restart until delivered** | Actual running and supervisor-wait selected roots receive exact public stop acknowledgement and stop without work acceptance. Public interrupt explicitly refuses async workflow pause; supervisor wait remains running. Selected root initializes running, not queued. Generic persisted queued/paused compatibility responses are separately seeded C, never mislabeled live selected states; see reachability audit below. |
| S22 | Result says complete/failed/stopped without terminal proof | PASS P/C/H | `test/execution-contract.test.ts` — **process terminal proof accepts only complete observed upstream receipts**<br>`test/native-runtime.test.ts` — **wrong root, child identity and malformed published proof cannot retire ownership**<br>`test/native-recovery-smoke.mjs` — **failure cleanup leaves unproven runners unresolved after stop delivery**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Exact public proof only; packed `stop` and parent-death preserve uncertainty. |
| S23 | Parent killed before child close; orphan later exits | PASS H/X SAFE UNCERTAINTY | `test/native-parent-death-smoke.mjs` — **S23 SIGKILL after native launch barrier leaves one surviving child and no recovery redispatch** | Actual parent SIGKILL, same live child heartbeat, release, and fresh-process PlanExecController.tick (three ticks/status requests). New controller owns the lease, retains exact original operation/digest/root, sees one side effect and emits zero spawns. Missing proof leaves it bound/reserved. |
| S24 | Proof wrong run/runner/caller; malformed/missing/private candidate only | PASS C | `test/native-runtime.test.ts` — **abandoned exact alias ${outcome} remains unknown with no stop or replay**<br>`test/native-runtime.test.ts` — **imported alias ${outcome} cannot establish a legacy binding**<br>`test/native-runtime.test.ts` — **malformed replies and unknown lookups never authorize a second spawn**<br>`test/execution-contract.test.ts` — **process terminal proof accepts only complete observed upstream receipts**<br>`test/native-runtime.test.ts` — **wrong root, child identity and malformed published proof cannot retire ownership**<br>`test/native-recovery-smoke.mjs` — **failure cleanup leaves unproven runners unresolved after stop delivery**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Wrong root/child/correlation and malformed published proof are rejected; unknown is not non-start. |
| S25 | Observed pause vs supervisor question vs user pause | PASS C/H PENDING-QUESTION RECOVERY; RETIREMENT LIMIT | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/controller.test.ts` — **resume consumes a settled detached stats child without launching a replacement**<br>`test/index.test.ts` — **generic paused operation guidance does not invent a supervisor request**<br>`test/index.test.ts` — **user-pause intent precedes generic recovery advice: ${error}** | Packed supervisor replaces the parent while contact_supervisor is unanswered. Public reply after saved-session reload reaches the same original child/session; one commit/no replacement; user pause wins. Async foreground-detach route remains refused and post-reload retirement remains unproven. |
| S26 | New session takes plan lease but not native control ownership | FULFILLED H/X | `test/native-parent-death-smoke.mjs` — **S26 fresh foreign native host can take the plan lease but cannot control the original child** | After killing only the fixture-owned original parent, a fresh foreign native session acquires the plan lease and observes the original root. Adapter spawn/stop refuse with zero control emissions; direct public stop returns not_found in active session. Original child settles once; native authority unchanged and absent retirement proof stays fenced. |
| S27 | Foreign host, same-machine assertion, reused PID, stale lease | PASS P/C | `test/registry.test.ts` — **a dead local pid frees the lease without waiting out the heartbeat**<br>`test/registry.test.ts` — **matching session text does not authorize takeover from a live remote owner**<br>`test/index.test.ts` — **--same-machine verifies local proof before taking a foreign lease**<br>`test/native-runtime.test.ts` — **native session authority is separate from the controller UUID and immutable** | Lease recovery and immutable native authority are distinct. No fabricated foreign-host takeover. |
| S28 | Bounded expiry, default native deadline, unbounded request | PASS C/H | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/autonomous-controller.test.ts` — **confirmed bounded expiry grows later budgets while a lost reply preserves the exact request**<br>`test/autonomous-controller.test.ts` — **bounded compatibility stops growing at the supported timer maximum without ending recovery**<br>`test/autonomous-controller.test.ts` — **ordinary tool timeout text cannot grow a bounded session budget**<br>`test/autonomous-controller.test.ts` — **silent unbounded workers never acquire a synthetic execution budget**<br>`test/native-runtime.test.ts` — **prepare records unsupported limits honestly and freezes configured agent/model into awaited child**<br>`test/lifecycle.test.ts` — **legacy unknown operation lifetime is not synthesized from a changed frozen base** | Packed `deadline`: blocked real local-model request, actual root and child 8000ms expiry, exact observed runner-instance close proof. Budget growth/cap are C tests, not inferred from runtime prose. Omitted root deadlines retain native child defaults; unsupported turn/unbounded promises are not advertised. |
| S29 | Model/auth/provider failure and explicit one-attempt override | FULFILLED C/H | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/autonomous-controller.test.ts` — **native provider failure holds only its task and explicit recovery uses one new model without changing config**<br>`test/autonomous-controller.test.ts` — **native provider hold permits independent work but model recovery cannot redirect its live writer**<br>`test/autonomous-controller.test.ts` — **stop generation winning provider recovery CAS cannot launch or retain an override for another task**<br>`test/autonomous-controller.test.ts` — **two independent provider failures retain separate proof and recover B then A without model leakage** | Deterministic local 401 and 404 prove failure capture, no acceptance or repeated bad-model launch after backoff, exact retired-attempt eligibility and one NEW authorized override. Plan and goal (--model current) complete with unchanged frozen models and no reviewer override leak. Two independent failures retain their own proof; recover B then A, no replay. No paid credentials used. |
| S30 | Credentials/permission/executable/runtime prerequisite | PASS C | `test/autonomous-controller.test.ts` — **unavailable runtime preflight is an explicit prerequisite and does not consume a worker attempt**<br>`test/autonomous-controller.test.ts` — **structured tool diagnosis preserves the session and schedules probes without unsupported repair**<br>`test/autonomous-controller.test.ts` — **doctor preserves the same launch identity when an empty lookup races a late spawn**<br>`test/autonomous-controller.test.ts` — **nested independent task lane preserves the cwd and excludes partial work**<br>`test/autonomous-controller.test.ts` — **external prerequisite A preserves its lane while B completes and C waits until automatic recovery** | Capability/prerequisite failures keep identity without silent repair, replay or unsupported guidance. Independent B progresses while external prerequisite A remains safely reserved. |
| S31 | Typed review clean/blocking/minor/malformed/wrong candidate | PASS P/C/H | `test/review.test.ts` — **native reports bind clean, blocking and minor findings to the candidate commit**<br>`test/review.test.ts` — **native reports reject wrong commits, malformed findings and contradictory fields**<br>`test/autonomous-controller.test.ts` — **minor-only required review records advisory findings without an endless fixer**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Packed plan/goal/findings/wrong-commit/malformed cases; minor terminal behavior is C. Schema acceptance still binds exact Git candidate. |
| S32 | Missing/truncated output, deleted temporary result, retained archive | PASS P/H | `test/artifact.test.ts` — **native bound files never infer fallback output for missing, truncated or excessive reports**<br>`test/artifact.test.ts` — **recovers a settled detached workflow after its result was archived**<br>`test/native-runtime.test.ts` — **native result requires consistent bound JSON: ${scenario}**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/native-runtime.test.ts` — **native result capture EACCES preserves the operation and prevents acceptance** | Packed missing bound file fails acceptance; artifact tests exercise truncated/deleted/archived evidence. Contradictory parsed JSON is never masked by envelope. |
| S33 | Output schema/tool ceiling conflict, missing agent/skill | PASS C/H APPLICATION ADMISSION | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/native-runtime.test.ts` — **public admission ${reason} preserves prepared intent without dispatch or retirement**<br>`test/native-runtime.test.ts` — **owned no-skills reviewer admission ${state} never creates a generic runtime-agent bypass**<br>`test/native-runtime.test.ts` — **async admission rechecks ${race} before claiming dispatch**<br>`test/native-runtime.test.ts` — **owned reviewer disposal after dispatch claim still prevents the synchronous spawn emit** | Packed missing-skill/missing-agent/lazy-skill refuse before any spawn/model work; valid selected skill and scoped/inherited models execute with required review. Owned runtime-role discovery exception is registration-scoped and no-skills only; configured collision refuses. Validation never supplies retirement/non-start authority or mutates dispatched requests. |
| S34 | Native controls and unsupported legacy knobs | PASS C/H; HONEST LIMIT | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/native-runtime.test.ts` — **prepare records unsupported limits honestly and freezes configured agent/model into awaited child** | Actual readonly/schema/model behavior and 8s expiry, not only request echoes. maxTurns unsupported; native child defaults prevent an end-to-end-unbounded claim; tool filtering is not an OS sandbox. |
| S35 | Local required check/bootstrap interrupted or orphaned | PASS C/X | `test/local-operation.test.ts` — **controller death leaves one command that a new controller adopts**<br>`test/local-operation.test.ts` — **batch monitor death cancels surviving descendants before a fresh retry**<br>`test/local-operation.test.ts` — **stop retires the owned process group and fences later commands**<br>`test/autonomous-controller.test.ts` — **bootstrap changes identity only after proven failure and does not consume task attempts** | Existing owned-process implementation unchanged; real local monitor/controller-death and cancellation probes. |
| S36 | Dirty/untracked candidate, wrong ancestry, changed branch | PASS C | `test/autonomous-controller.test.ts` — **untracked source cannot be smuggled into an accepted candidate**<br>`test/autonomous-controller.test.ts` — **candidate verification failure is recoverable and never accepts checkbox-only work**<br>`test/controller.test.ts` — **explicit recovery can adopt the verified current execution branch**<br>`test/controller.test.ts` — **branch adoption rejects a run with an active child** | Real Git checks reject dirty/checkbox-only candidates and require explicit branch adoption. |
| S37 | Promotion/archive crash, ignored files, output branch changed | PASS C/X/H | `test/owned-git.test.ts` — **owned post-merge survives controller death and promotes the same accepted candidate**<br>`test/autonomous-controller.test.ts` — **accepted internal-lane work fast-forwards the original output branch without erasing dirty files**<br>`test/controller.test.ts` — **archive recovery completes after a committed plan move without committing again**<br>`test/controller.test.ts` — **archive retry preserves a partially staged move and unrelated changes**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Owned Git survives parent death; archive recovery preserves user changes; packed cutover reaches actual archive commit. |
| S38 | Optional stats failure / required review failure / explicit waiver | PASS C | `test/autonomous-controller.test.ts` — **optional statistics failure needs exit proof but cannot block mandatory completion afterward**<br>`test/autonomous-controller.test.ts` — **required review cannot be waived by explicit skip**<br>`test/controller.test.ts` — **a force-skipped stage makes terminal completion honest** | Stats degrade only after proof; required review cannot be waived; legacy explicit skip preserves findings. |
| S39 | Explicit Fusion/Revmux, unavailable provider, fallback policy | PASS C/X | `test/controller.test.ts` — **Fusion replay preserves the operation identity without unsafe fallback**<br>`test/review-backend.test.ts` — **a reviewer without explicit execution-lifetime support is rejected before launching**<br>`test/review-backend.test.ts` — **controlled Revmux review survives client restart and replays exactly one operation**<br>`test/autonomous-controller.test.ts` — **unknown review lookup does not replay or launch a configured fallback** | Explicit adapters retain their existing capability/owned-command contracts; no installed external-provider/live-model compatibility claim. |
| S40 | Status/ui on-off/clear, legacy hide-show and no-session host | PASS P/C/H | `test/pi-rpc-smoke.test.ts` — **real Pi RPC registers exec and renders isolated status without model dispatch**<br>`test/index.test.ts` — **display controls persist independently of stopped run state**<br>`test/index.test.ts` — **force stop stays dismissed through late updates, branch navigation, and a fresh session**<br>`test/index.test.ts` — **unpolled ${owner} run stays an amber snapshot on startup and explicit show** | Real no-session status host; display state is separate from lease/management and force-stop reservations. |
| S41 | Fleet failure, stale update, terminal retention, bg_wait | PASS C/H | `test/runtime-integration.test.ts` — **Fleet admission failure cannot hide active background work or leak completion**<br>`test/runtime-integration.test.ts` — **late running snapshots cannot re-add terminal work to the provider**<br>`test/runtime-integration.test.ts` — **terminal Fleet retention is bounded without dropping active work**<br>`test/ui-controller-integration.test.ts` — **background recovery keeps ticking through UI failure and pending Fleet publication**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Fleet failure/stale-generation behavior is controlled C; packed real loader sees one parent provider and inert children. |
| S42 | Legacy terminal/paused/active/failed/quarantined/abandoned records | PASS P/C/H/X | `test/legacy-import.test.ts` — **legacy snapshot import preserves original intent, cancellation and read-only source bytes**<br>`test/native-runtime.test.ts` — **imported dispatch alias resolves read-only and controller CAS binds original intent**<br>`test/native-runtime.test.ts` — **known legacy retirement without retained result state is diagnosed, not accepted or relaunched**<br>`test/index.test.ts` — **legacy terminal history is visible without rewriting registry or task files**<br>`test/force-stop.test.ts` — **ordinary cleanup enforces the final abandonment archive after an interrupted force-stop**<br>`test/native-recovery-smoke.mjs` — **S42/S45 real old Bridge workflow excludes a new controller and imports exact settlement after quiescence**<br>`test/legacy-import.test.ts` — **repeated legacy import preserves ${slot}, cancellation and quarantined inventory without dispatch** | Real frozen old controller/Bridge package, actual historical workflow and isolated SQLite journal. After explicit quiescence and exact native proof, readonly import preserves original ID/digest/params and accepts the old candidate once; no root replay. Existing terminal/abandonment cases remain covered. |
| S43 | Missing/busy/corrupt/schema-unknown legacy SQLite/WAL | PASS C | `test/legacy-operation.test.ts` — **legacy-operation reports exclusive lock unavailable within bounded wait**<br>`test/legacy-operation.test.ts` — **legacy-operation reads committed WAL rows and does not observe uncommitted updates**<br>`test/legacy-operation.test.ts` — **legacy-operation refuses schema ${version} without migration**<br>`test/legacy-operation.test.ts` — **legacy-operation does not initialize an existing empty file** | Disposable SQLite fixtures only; pinned schema 7 readonly access and real lock/WAL cases. |
| S44 | Migration or abandonment interrupted around backup/marker/archive writes | PASS C (REAL FS/SQLITE BOUNDARIES) | `test/force-stop.test.ts` — **backup failure leaves management state unchanged**<br>`test/force-stop.test.ts` — **failed final backup never deletes the abandoned active record**<br>`test/force-stop.test.ts` — **ordinary cleanup enforces the final abandonment archive after an interrupted force-stop**<br>`test/legacy-import.test.ts` — **fresh CAS import preserves newer stop intent instead of overwriting a concurrent cancellation**<br>`test/legacy-import.test.ts` — **invalid import preserves a preexisting legitimate lease byte for byte**<br>`test/legacy-import.test.ts` — **legacy import publication EACCES preserves registry and SQLite bytes and retries the same identity** | Real .abandoned path collision prevents backup; archived run.json directory causes final-rename failure. Actual permission-denied import publication preserves registry/snapshot bytes, no lease or dispatch, same-identity retry after permission repair. CAS races are controlled C; no power-loss claim. |
| S45 | Old and new runtime simultaneously present | PASS H/X | `test/registry.test.ts` — **unreadable ownership records fail closed during exclusive creation**<br>`test/registry-lock.test.ts` — **two crash recoverers admit only one run while the first pauses before publication**<br>`test/rollback-preflight.test.ts` — **S53 frozen 1.8.0 accepts native records, guards reservations, but old cleanup deletes native history and unreadable ownership**<br>`test/native-recovery-smoke.mjs` — **S42/S45 real old Bridge workflow excludes a new controller and imports exact settlement after quiescence** | Actual old and new hosts overlap while the old workflow child and lease own the checkout. New controller start and resume refuse; old record unchanged; zero competing spawns. After deliberate quiescence, exact old settlement imports without replay. Direct old-version rollback is still unsafe per S53. |
| S46 | Cleanup races resume/force-stop, controller tick or late result | PASS C/X | `test/registry.test.ts` — **remove decides refusal under the lock, not before it**<br>`test/registry.test.ts` — **corrupt run cleanup preserves the independent local ownership fence**<br>`test/force-stop.test.ts` — **force abandonment revokes the current controller even while its tick lock is held**<br>`test/controller.test.ts` — **force stop fences a pending archive observation and holds the checkout until tick retirement**<br>`test/registry-lock.test.ts` — **removing a run preserves the lock inodes seen by waiting writers** | Removal/refusal under lock and final archive preserve independent ownership; stale views cannot revive abandonment. |
| S47 | Explicit isolated recovery of unknown native/legacy operation | PASS C | `test/isolation.test.ts` — **explicit isolation preserves native uncertainty and creates one independent same-run writer**<br>`test/isolation.test.ts` — **force abandonment preserves isolated recovery lineage and every quarantined reservation**<br>`test/isolation.test.ts` — **restart after cloned checkout reuses the same target and rejects old-generation state** | Separate real repository and generation fences; old execution remains quarantined/unknown. |
| S48 | Removed packages absent / installed but unused | PASS H | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover**<br>`test/pack.test.ts` — **package manifest ships only plan-exec resources, needs no runtime dependency, and requires native peers without removed packages** | Packed absent dependencies; `cutover` begins with real old packages installed in target but unused by separately installed executor, then removes them. Foreign task/projection sentinels unchanged throughout. |
| S49 | Public RPC boundaries malformed or request IDs mismatched | PASS P/C/H | `test/native-runtime.test.ts` — **malformed replies and unknown lookups never authorize a second spawn**<br>`test/native-runtime.test.ts` — **disposal settles pending RPC without permitting replay and removes listeners**<br>`test/native-runtime-contract.test.ts` — **released public RPC characterizes rejection, stop parity, ownership, and missing proof**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Malformed/foreign replies and disposal tested against fake boundary; pinned public RPC real-route characterization plus normal loader. |
| S50 | Native process-proof containment limits | PASS P/H/X; LIMITED CONTAINMENT | `test/execution-contract.test.ts` — **process terminal proof accepts only complete observed upstream receipts**<br>`test/native-runtime.test.ts` — **actual async child classification requires its exact nonempty proof roster**<br>`test/native-recovery-smoke.mjs` — **released public RPC launches direct worker/reviewer leaves and preserves exact run proof identity**<br>`test/local-operation.test.ts` — **a restarted stop discovers and retires local descendants after both monitors die** | Native exact writer/runner proof, not arbitrary escaped-descendant containment. Existing local owned-process backend remains separate. |
| S51 | Safe retry after terminal failure | PASS C/H | `test/native-runtime.test.ts` — **registry rejects changed native request/digest and ownership**<br>`test/autonomous-controller.test.ts` — **cumulative native usage is counted once across repeated status polls**<br>`test/autonomous-controller.test.ts` — **final checks get a fresh persisted identity after proven nonzero exit**<br>`test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | C frozen request/digest and usage accounting; packed `findings` has distinct initial/fix/review operation directories and re-review. |
| S52 | Native artifacts contain foreign paths/oversized payload | PASS P/C | `test/git.test.ts` — **accepts a symlink alias of a registered worktree with a newline in its path**<br>`test/native-runtime.test.ts` — **native cwd is the canonical authorized execution target, including nested lanes**<br>`test/native-runtime.test.ts` — **caller-bound output rejects symlinks before any dispatch**<br>`test/native-runtime.test.ts` — **prepare refuses an aliased output parent without creating files outside the run**<br>`test/artifact.test.ts` — **native bound files never infer fallback output for missing, truncated or excessive reports** | Canonical aliases are separate from output-source symlinks. No filename-based output identity. Bound report-size/truncation refusal complements path checks. |
| S53 | New-format record encountered by old registry | PASS CORRECTED NEGATIVE REGRESSION; OLD REJECTION DISPROVEN | `test/rollback-preflight.test.ts` — **S53 frozen 1.8.0 accepts native records, guards reservations, but old cleanup deletes native history and unreadable ownership**<br>`test/rollback-preflight.test.ts` — **rollback preflight refuses non-directory roots, symlinks and unreadable inspection without writes**<br>`test/rollback-preflight.test.ts` — **rollback preflight refuses a non-regular JSON source without opening it** | Frozen bc5fb6e source accepts native schema-1 record, refuses competing owner/active removal, but deletes terminal native history and corrupt ownership. New readonly explicit-directory preflight blocks native records/history/artifacts and incomplete inspection; direct old execution bypasses it and is unsafe. |
| S54 | New controller's dependency removed before final archive | PASS H | `test/packed-consumer-smoke.mjs` — **packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover** | Packed `cutover`: executor tarball and full src fingerprint independently pinned; target starts with actual old packages; real native worker uninstalls both and commits lock/manifest; same unchanged executor reviews, checks and commits archive. |
| S55 | Completion/cancellation retention through later writes and legacy migration | PASS C | `test/registry.test.ts` — **final status ${status} keeps its retirement time across later writes**<br>`test/registry.test.ts` — **recoverable or unfinished status ${status} does not acquire a retirement stamp**<br>`test/registry.test.ts` — **a rejected terminal write does not stamp retirement**<br>`test/index.test.ts` — **metadata updates cannot postpone cleanup of a legacy ${status} run**<br>`test/index.test.ts` — **retention is measured from when a run finished, not from its last write**<br>`test/controller.test.ts` — **archive retires the run record with a persisted retiredAt** | Actual retirement/retention regressions, not package setup checks. Legacy final metadata writes preserve the original cleanup age. |
| S56 | Concurrent write rejects a stage-transition CAS | PASS C | `test/controller.test.ts` — **metadata contention cannot log an unapplied stage transition** | A legitimate concurrent metadata write rejects the first transition CAS; no rejected-transition log, then exactly one successful transition log and no extra launch. |

## Parent verification correction

The first verification table retained test names but mismatched several scenario
IDs. This table now includes the exact scenario text from the approved plan.
In particular, S55 is retirement retention and S56 is rejected-transition CAS,
not installation or CI checks. Plan headings and requirements were not rewritten.

The S23 recheck correctly found that adapter-only polling did not exercise
controller recovery. A failing assertion first reproduced the missing controller
execution; the revised fixture runs three real controller ticks in the fresh
process, verifies native status requests and the new lease PID, and preserves
the original operation/digest/root with zero new launches. The focused
`npm run test:parent-death` passed on Darwin after this test-only correction.
The production runtime is unchanged from the full passing gate.

## Acceptance status

The unchecked plan markers are parent-owned, not a count of unimplemented work.
The reconciliation below replaces the obsolete “eight remain” coverage claim.
Locally executable implementation/host checks are fulfilled by named evidence;
selected-runtime states that cannot be requested are classified precisely, not
fabricated. Separate Linux acceptance is **waived, not passed**. Final independent
review of the parent result-capture delta and this closure delta, and the parent's
checkbox reconciliation, are the remaining release gates. This child has no
publication, version-bump, main/global or live-state authority.

The corrected S53 requirement records observed old-format acceptance and unsafe
cleanup, rather than the disproved old-parser rejection assumption. The earlier
Task 2 direct-async wording is interpreted under the later approved single-keyed-
workflow execution contract, not as permission for a second direct-leaf backend.

Parent measured production-source delta against released 1.8.0: 4086 lines
added, 2586 removed (net +1500). This migration removes two runtime
packages but does not reduce this repository's source line count. The scoped
architecture review accepted the one-ledger design and retained a nonblocking
note about duplicated RPC plumbing.

Parent checks: focused controller SIGKILL regression and npm run check passed.
README/evidence relative-link check passed (13 links); prose lint reported 44
advisory findings. No diagrams changed. Checking the frozen plan additionally
reports its historical src/task-projection.ts link, whose target was deliberately
deleted by this migration. Plan structure was not edited to conceal that history.

## Final admission recheck

The independent admission review found that the fixed-role discovery exception
could emit a workflow even when allowedAgents excluded the reviewer. Parent
reproduced four failing checks, then added an exact allowed-agent check to the
existing disposal-aware callback. It re-reads the current ceiling before admission
and at the existing post-await/pre-emit checkpoints. No private native API is used.
Six regression cases cover absent/empty/allow/deny/lookalike lists and a ceiling
narrowed during admission. All 80 adapter/registration tests passed. The real
packed agent-ceiling scenario now records prepared state, zero spawns and zero
model calls; the allowed schema-ceiling scenario still completes. npm run check
passed. The independent recheck and exact-head broad gate subsequently passed at 9f4b55b; see the post-fix closure below.

The operator waived a separate Linux verification gate and authorized preparing a
release after final review and evidence reconciliation. This is not a Linux pass.
The existing tag-driven publisher remains authoritative; its automatic checks
are not bypassed. No global package or live registry upgrade is authorized.

## Result-capture and repeated-import closure

The final broad gate at 9f4b55b passed on Darwin: 756 Vitest plus 143 node:test
(899), runtime 3, recovery 6, crash/barriers 4 and packed consumer 1 (19 modes),
with zero failures/skips. The independent allowed-agent recheck resolved the
last admission warning and found no new defect in that delta.

A real EACCES probe at controller-result publication exposed a diagnostic gap:
the outer tick catch used its pre-observation CAS snapshot, so the error was
not retained. The localized capture catch now reloads, checks the same operation/
status/generations, and records a retryable observation failure. It still cannot
accept output before durable capture or dispatch a replacement. The test verifies
the error, no acceptance, and same-identity capture after permission restoration.
Repeated active/failed legacy imports also preserve cancellation error/intent,
original request/digest, quarantine inventory and SQLite bytes without dispatch.
Four affected suites passed (221 tests), and check/TypeScript passed. Final
independent review and broad post-fix validation remain required before release.


## Closure host evidence and the scoped S29 correction

Closure starts from parent `d713e521ba5ad0bce2b30c8da889efaae8245eb4` and preserves
its capture-EACCES and repeated-import fixes. The review bundle includes a separate
`parent-result-capture.diff` from `9f4b55b` to `d713e52`, not only this worker's delta.

**S21 reachability, released 0.76.1:** the selected async scripted-workflow root
is published as `running` (`subagent-executor.js` workflow status initialization,
near line 4924); it has no queued-root transition. Its public `interrupt` route
explicitly returns **Interrupt is unsupported for async workflow …; use stop
instead** (near line 848), reproduced against an actual model-held workflow.
An actual `contact_supervisor` wait also leaves this selected root `running`,
with an async main child; public stop acknowledges that exact root and it becomes
`stopped`. The root's `paused` error branch requires a detached-child workflow
continuation, not the selected held async child (catch near lines 5765–5769).
No direct-leaf, foreground-detach backend or synthetic status was introduced to
manufacture a live queued/paused root. Existing seeded compatibility tests still
prove invalid-state refusal and pending-intent preservation for historical states;
they are C route characterization, not live X crashes. Parent-loss controller
callbacks remain unavailable and retirement may remain unproven.

**S26:** the foreign-host test performs real plan-lease takeover after parent
SIGKILL while retaining the original native owner. It checks both adapter refusal
and actual public RPC current-session refusal, plus one original side effect,
zero replacement and no PID-derived retirement.

**S29:** local HTTP 401/404 first reproduced a real gap: a retired failed native
task remained running/retry_wait, while CLI `--model` required overall failed
status; it retried the frozen bad model. Supervisor approved the localized fix.
Confirmed retired provider failures now hold the affected task as an existing
provider prerequisite without blocking ready independent tasks. Explicit resume
uses current retired failure identity, proof and generations, not overall status
alone. Plan and goal probes recover through a new operation with the selected
one-attempt model (`current` covered), keeping config and old request immutable.
Healthy/in-flight/unknown/stale/abandoned authority refuses; stop-winning CAS does
not dispatch. The snapshot field described in runtime contracts is one bounded
retired operation per affected task in the same registry, not another ledger.
The two-failure regression proves B's failure cannot erase A's proof or authorize
its override: both stay held, then B and A recover independently, four distinct
launch IDs and exactly their intended model sequence.

## D8 state-to-test reconciliation

All storage paths below are disposable fixtures. “Fulfilled” includes safe refusal
where the published contract supplies no stronger authority. Import itself never
dispatches, and SQLite/publication errors are not called physical power loss.

| Exact D8 state | Concrete evidence and actual assertion | Classification |
| --- | --- | --- |
| Completed/cancelled run, no active operation | `test/index.test.ts` — **legacy terminal history is visible without rewriting registry or task files**; **metadata updates cannot postpone cleanup of a legacy ${status} run**; `test/registry.test.ts` — **legacy session attribution is validated and read-only, including terminal history**. Byte-identical history/display; retention anchored to prior retirement/update. | Fulfilled C |
| Operator-abandoned run or final archive | `test/force-stop.test.ts` — **force abandonment ends management without inventing retirement or freeing an unknown checkout**; **ordinary cleanup enforces the final abandonment archive after an interrupted force-stop**; `test/isolation.test.ts` — **force abandonment preserves isolated recovery lineage and every quarantined reservation**. No restore, ordinary CAS revival or premature checkout release. | Fulfilled C |
| Paused run, no unresolved operation | `test/index.test.ts` — **display controls persist independently of stopped run state**; `test/autonomous-goal.test.ts` — **a goal resumes after a pause and completes**; `test/controller.test.ts` — **paused runs retain a terminal child until resume applies its completion**. Pause remains user-owned; explicit resume is separate from readonly view/observation. | Fulfilled C |
| Active bound single/workflow with valid artifacts | `test/legacy-import.test.ts` — **repeated legacy import preserves ${slot}, cancellation and quarantined inventory without dispatch**; `test/native-runtime.test.ts` — **legacy observation and same-session stop retain the original digest without dispatch**; `test/native-recovery-smoke.mjs` — **S42/S45 real old Bridge workflow excludes a new controller and imports exact settlement after quiescence**. Exact old mapping, original params/digest, no root replay. | Fulfilled C/H/X |
| Bound terminal result | Same S42/S45 real host test: exact old retirement and result accept one candidate with one effect/no replay. `test/native-runtime.test.ts` — **known legacy retirement without retained result state is diagnosed, not accepted or relaunched**; **native result capture EACCES preserves the operation and prevents acceptance**. Missing capture/evidence never authorizes success. | Fulfilled C/H/X |
| Stop requested, not delivered | `test/legacy-operation.test.ts` — **legacy-operation preserves cancellation intent and ${stopReceiptState} delivery separately**; repeated-import slot test above preserves cancellationDeliveryError, stopRequested and original bytes; `test/native-runtime.test.ts` — **readonly imported alias can receive same-session stop but never foreign control or ordinary writes**. Pending intent survives; receipt is not retirement. | Fulfilled C |
| Correlated non-start rejection | `test/legacy-operation.test.ts` — **legacy-operation preserves validated rejection evidence without interpreting retirement**; **legacy-operation rejects malformed rejection ${JSON.stringify(patch)}**; `test/legacy-import.test.ts` — **repeated legacy rejection import preserves an original launch fence without manufacturing dispatch authority**. Original trusted fence retained; raw imported receipt does not invent a new fence/exit. Later fresh-attempt policy remains separate from readonly import. | Fulfilled C; absent corroborating authority safely fenced |
| Dispatching/unknown, no exact mapping | `test/legacy-operation.test.ts` — **legacy-operation preserves ${binding} mapping without claiming non-start**; **legacy-operation missing database and row are not absence or replay proof**; `test/controller.test.ts` — **controller never replays a historical operation merely because its old lookup is absent**. Unknown identity stays reserved. | Fulfilled C, published no-absence limitation |
| Mapping disagrees with run/digest/session | `test/legacy-operation.test.ts` — **legacy-operation rejects wrong ${field}**; `test/legacy-import.test.ts` — **legacy ${scenario} snapshot cannot change operation identity or authorize dispatch**; `test/native-runtime.test.ts` — **imported alias ${outcome} cannot establish a legacy binding**; readonly imported same/foreign-session stop test above. No import overwrite or foreign control. | Fulfilled C |
| Missing/locked/corrupt/unsupported journal | `test/legacy-operation.test.ts` — **legacy-operation reports exclusive lock unavailable within bounded wait**; **legacy-operation reads committed WAL rows and does not observe uncommitted updates**; **legacy-operation refuses schema ${version} without migration**; **legacy-operation does not initialize an existing empty file**. Real SQLite locks/WAL, unchanged old bytes, no empty replacement. | Fulfilled C |
| Foreign live owner or ambiguous host | `test/legacy-import.test.ts` — **abandonment, foreign lease and changed cancellation generation win over import**; S42/S45 live dual-host refusal; S26 fresh foreign session test above; `test/index.test.ts` — **--same-machine verifies local proof before taking a foreign lease**. Lease eligibility never grants foreign native control. | Fulfilled C/H/X |
| Quarantined generation | Repeated active/failed slot import above byte-compares inventory and retains stop/digest; `test/native-runtime.test.ts` — **late imported alias observation cannot bind across ${race}**; `test/isolation.test.ts` — **restart after cloned checkout reuses the same target and rejects old-generation state**. Old observation cannot advance new generation or release old reservation. | Fulfilled C |

Shared publication evidence is intentional reuse: S08/S09/S11 physically kill
fixture-owned parents at the same `RunRegistry` atomic `run.json` rename boundary
used by import. `legacy import publication EACCES preserves registry and SQLite
bytes and retries the same identity` directly covers import failure/repair, no
lease/RPC and unchanged snapshot. Abandonment tests put an ordinary file at
`.abandoned` and a directory at archived `run.json`, provoking real filesystem
errors and proving backup/final-archive ordering without deletion. S42/S45 uses a
real consistent SQLite backup after explicit old-controller quiescence. CAS race
mocks remain C; no duplicate test or fake SIGKILL label is substituted for these
shared boundaries.

## Eight unchecked checklist lines: evidence reconciliation

Markers remain unchanged for the parent. “Fulfilled” is a recommendation from
concrete local evidence, not independent-review acceptance.

| Plan line / exact item starting text | Evidence | Disposition |
| --- | --- | --- |
| 696 — Add deterministic barriers for prepared intent, dispatch claim, native launch, reply delivery, binding persistence, result capture and acceptance | S08/S09/S11 real publication/kill barriers; S10 dropped actual reply; parent S23 real-controller recovery; parent capture EACCES test; **correlated completion retains binding after lost reply without replay or late abandoned writes**; **candidate verification failure is recoverable and never accepts checkbox-only work**. Acceptance is a C verification boundary, not a claimed physical crash. | Fulfilled C/H/X |
| 697 — Characterize native status/correlation after reload and process restart | Fresh keyed-workflow host recovery, S25 parent replacement while question pending, new S26 foreign takeover/refusal and preserved S23 orphan/proof uncertainty. | Fulfilled; published control/proof limitations safely fenced |
| 743 — Add restart/race cases with real registry locks and separate host processes | **two crash recoverers admit only one run while the first pauses before publication**, **cross-process compare-and-set applies exactly one shared revision**, real S08/S09/S11/S23/S26 hosts, late-import generation races and force-stop races. | Fulfilled; controlled late-event/CAS races labelled C |
| 793 — Exercise S01–S41, S51 and S54–S56 through the native test composition | Exact scenario table names controller/Git/goal/independent-lane tests and normal-loader plan/goal/fix/provider probes; source-named S55 retirement and S56 rejected-transition-CAS tests remain correctly mapped. Launch/effect/commit counts asserted. | Fulfilled composition; S21 reachability classification above |
| 848 — Implement idempotent fixture migration for every D8 row | Complete D8 table above; parent repeated active/failed imports preserve quarantine/cancellation; real old workflow settles once through readonly snapshot import; original rejection fence preserved without synthesis. | Fulfilled C/H/X |
| 849 — Add crash barriers around snapshot/import/atomic record replacement | Consistent SQLite backup/WAL/locks, direct import EACCES and shared registry rename/SIGKILL barriers; failed backup/archive filesystem probes; mismatch/schema refusal. | Fulfilled via shared writer plus direct import cases; no power-loss claim |
| 898 — Close the S01–S56 mapping with exact tests/results | All 56 scenario columns preserved, named tests verified; S21/S26/S29 residual local host cases resolved/classified. Separate Linux validation explicitly waived, not passed; automatic checks intact. | Fulfilled local evidence, Linux waiver recorded |
| 905 — Resolve independent review findings … scoped architecture re-review of D1–D9 | Parent D1–D9 sweep found no blocker; low-priority RPC duplication deliberately untouched. Prior admission recheck clean. Parent d713e52 result-capture and this approved S29 correction are in the final actual-diff bundle. | Final independent review and parent marker reconciliation remain required; child cannot self-accept or release |

## Final local closure gate results

The single final broad `test:all` run passed **764 Vitest + 143 node:test = 907**,
3 runtime, 6 recovery and 5 parent-death/barrier tests. It then failed in the
expanded packed suite: `supervisor-stop` left a fixture observer request file,
so the following S25 case read that stale observation before its own model call.
This was not a production failure. Only that fixture observation file is now
cleared between supervisor scenarios. The affected full packed gate subsequently
passed all **24 modes**, including S21, plan/goal HTTP
401/404 recovery, pending-question S25, and pinned-executor S54. Check/TypeScript
and pack:dry then passed (41 files; ten informational diagnostics). No complete
pipeline rerun was done for this fixture-only repair or subsequent prose.

Thus the final evidence is **composite green affected checks**, not a claim that
the failed monolithic invocation passed. Failed logs, retained fixtures and the
final packed/check/pack logs are included in `acceptance-closure.json`'s external
bundle. The non-Linux local assertions in the eight-item reconciliation have no
remaining unexecuted requirement; S21's selected-route limits are documented
above. Independent review of the parent delta plus the approved S29 correction,
and parent-owned marker/release reconciliation, are still required. Linux remains
waived, not passed. No child release, version bump, push or main/global/live
mutation was performed.

## Post-pause recovery recheck

The final bounded review of9cf009e accepted the capture-error and repeated-import
checks but found one blocker: an ordinary pause invalidated already-retired
provider evidence by requiring equal stop generations. The evidence predicate
now rejects future stop generations, not historical ones. Explicit resume still
checks its current stop generation under the existing lock/CAS path; the saved
failure/request/proof is not rewritten.

The existing concurrent-stop test first reproduced the rejected later resume.
It now verifies that the racing stop wins, then a separate explicit resume emits
exactly one new attempt at the current stop generation, with unchanged failure
evidence and config. Future-generation, active/unknown, stale execution and
cross-task refusal tests remain. Four focused provider tests plus check passed.
The actual packed HTTP401 plan now pauses before explicit --model recovery and
completes; HTTP404 direct recovery and goal HTTP401/current-model recovery also
pass. Volatile observation timestamps are not treated as immutable proof.
Independent recheck remains the final blocker before parent checklist closure
and version/release preparation.

## Final parent acceptance — 2026-10-07

Accepted implementation head: 4e97b3a151256036585564ef59173afafdc13f4a.
All 48 checklist items are closed under the approved released-runtime contract
and explicit Linux waiver. The eight-line reconciliation and D8 table above
provide the coverage basis; shared writer tests are reused, not relabeled as
additional physical crashes. S53 records the disproved old-parser assumption
and the tested hard rollback preflight instead of claiming old code rejects
native schema-1 records. Plan text/headings remain unchanged.

The final deep bounded review accepted capture-error handling, repeated legacy
import and host closure, identifying only post-pause provider recovery as a
blocker. Its follow-up at4e97b3a marks that blocker RESOLVED and reports no
concrete nearby regression. The allowed-agents and earlier native recovery/
artifact findings were already independently resolved. Architecture D1–D9 has
no blocking finding; the nonblocking RPC-plumbing duplication is not expanded
into a release refactor.

Validation is composite and traceable: 764 Vitest plus 143 node:test (907) and
the runtime/recovery/crash gates passed in the broad closure run; the fixture
observer-file repair passed the full24-mode packed suite and check/pack. The
subsequent one-comparison pause correction passed four affected provider cases,
real packed plan401-after-pause, plan404 and goal401 recovery, and check. No
clean monolithic rerun after that correction is claimed. Linux was waived by
the operator, not passed. Ordinary release-workflow checks remain enabled.

Release preparation may now proceed separately. No publication, tag, live data
migration or global installation occurred as part of this acceptance.
