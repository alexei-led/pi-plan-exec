# Guide

Use this reference to write plans, configure checks/review and control a run.
The [installed runtime contracts](../skills/exec-plan/references/runtime-contracts.md)
own safety guarantees and supported protocol limits; this guide owns commands
and configuration.

## Requirements and installation

Use Pi 1.5.0, pi-subagents 0.84.0 and this package as independent Pi packages.
Runtime requires Node >=22.19.0, Git, Darwin/Linux and the platform C compiler
for kernel registry locks. No Bridge, pi-tasks or cc-thingz installation is needed.

```bash
pi install -l npm:pi-subagents@0.84.0
pi install -l npm:@alexeiled/pi-plan-exec@2.3.0
```

Before upgrading, quiesce old controllers/workers with their original runtime,
back up evidence and restart all owning Pi sessions. Do not hot-reload a mixed
dependency stack. Unresolved historical workflow operations retain their original
identity and reservation; the new adapter does not silently continue them.

## Executable-plan format

Keep the plan inside its Git repository. Every task section needs a title and
a concrete verifiable checkbox:

```markdown
# Deliver a small change

### Task 1: Implement it
dependsOn: []

- [ ] Add the behavior and its regression test.
- [ ] Run the focused checks.

### Task 2: Document it
dependsOn: [1]

- [ ] Update the guide and verify the example.
```

Canonical Task/Iteration numbering starts at 1 and is consecutive. Lightweight
P0/Phase/Step/T001 headings are normalized to document order. Checkbox markers
accept -, *, + or ordered-list prefixes and [ ], [x], [X]. Fenced examples are
ignored. Dependencies are parsed from explicit JSON arrays of earlier task IDs;
tables/prose do not declare dependencies.

Omitted dependsOn retains legacy sequential order. dependsOn: [] is independent.
Independent tasks can progress while another waits, but there is one authorized
writer per target. Accepted tasks are not re-opened by an unchecked prerequisite.

After a run starts, change checkbox markers only. Headings, labels, dependencies,
item text/count and order are frozen. A structural change pauses for explicit
review before resume.

## Start and select a target

```text
/exec docs/plans/change.md
/exec
/exec --worktree "/absolute/existing-worktree" docs/plans/change.md
```

Bare /exec picks a Markdown plan under docs/plans, excluding completed.
Prefer Worktree (isolated). In-place execution uses the current branch.
An explicit --worktree uses that registered checkout and skips the isolation
picker; its plan path is relative to that checkout.

Interactive Pi previews the target, branch, models, review and command argv
before allocation. Cancelling that preview starts nothing. The preview is a
current configuration snapshot; start freezes its effective settings.

Worktree sessions hand off to the execution checkout through Pi's replacement
context. Recovery follow-ups dispatch as commands, not model input. Continue
there; another source-checkout worker is not a substitute for resume.

## Goals

```text
/goal Fix the parser failures --check "npm test"
/goal status <full-run-id>
/goal inspect <full-run-id>
```

Goals work in place with a clean tree and at least one required check. Each
implementation turn inspects current state, makes useful progress, verifies and
commits it. No plan file/DAG is required.

--check is repeatable and splits its value into argv on whitespace. It is not
a shell parser. Put complex argument arrays in configuration rather than hiding
pipes/expansions inside a check.

The controller continues intermediate turns within the authorized budget.
Unchanged HEAD/check fingerprints trigger reassessment, not invented proof of
no useful investigation. TASK_FAILED means an assignment failed; GOAL_BLOCKED
with an exact reason/next step means the goal needs external intervention.
Observed prerequisite evidence and confirmed provider failures retain their
specific recovery guard.

GOAL_DONE cannot pass a failed native child or failed checks. The completion
guard catches deleted tests and supported JS disabled-test declarations; it is
a heuristic, not universal anti-test-weakening verification. Application APIs
such as query.skip()/query.only() and documentation mentions are not disabled tests.
Required review/checks remain independent.

## Configuration

Use repository .pi/plan-exec.json. Unknown keys and malformed values fail.
Configuration is frozen into each run; editing the file does not redirect an
existing operation. A model recovery override applies to one replacement only.

```json
{
  "requiredChecks": [["npm", "test"]],
  "bootstrapCommands": [["npm", "ci"]],
  "reviewEnabled": true,
  "reviewRequired": true,
  "reviewBackend": "subagent",
  "reviewFallback": [],
  "statsEnabled": false,
  "workerAgent": "worker",
  "reviewerAgent": "plan-exec-reviewer",
  "executionLifetime": { "mode": "bounded", "timeoutMs": 1800000 },
  "maxTaskIterations": 50
}
```

| Setting | Meaning |
| --- | --- |
| requiredChecks | Nonempty argv arrays. Empty/omitted permits repository detection. |
| bootstrapCommands | Plan bootstrap argv; empty/omitted detects supported lockfiles. |
| executionLifetime | unbounded requested by default, or bounded with positive timeoutMs. Native child defaults still apply. |
| workerAgent / reviewerAgent / statsAgent | Frozen selectors; default worker and readonly plan-exec-reviewer. |
| workerModel / reviewerModel / statsModel | Optional frozen native model selectors. No silent fallback. |
| workerMaxTurns / reviewerMaxTurns / statsMaxTurns | Requested diagnostics; native RPC does not enforce them. |
| maxTaskIterations | Goal implementation-turn budget; not an ordinary plan retry cap. |
| retryDelayMs | Positive automatic recovery/backoff base. |
| reviewEnabled / reviewRequired | Required review cannot be disabled. Default both true. |
| reviewBackend / reviewFallback | Explicit provider policy; default subagent and no fallback. |
| finalizeEnabled | Does not waive mandatory final verification. |
| statsEnabled | Optional statistics stage, off by default. |
| taskRetries / reviewIterations / fusionIterations | Deprecated diagnostic settings, not scheduling caps. |

Supported default bootstrap detection includes npm/pnpm/yarn/uv lockfiles.
Default checks select supported Makefile targets or package scripts. Review
the preview and configure explicit argv when repository defaults are unsuitable.
These commands can execute repository code with your OS permissions.

Local bootstrap/checks are unbounded but user-stoppable owned process groups.
A bounded native lifetime does not bound local commands. Native timeout text,
silence or a stop receipt is not retirement or permission to launch again.

## Status, inspector and display

```text
/exec status
/exec status <full-run-id>
/exec inspect [full-run-id]
/exec hide
/exec ui off
/exec ui on
/exec show [full-run-id]
/exec clear [full-run-id]
```

Status is observational: no dispatch, lease takeover or execution mutation.
The inspector selects one exact run and offers overview, tasks, checks/review,
ownership evidence and eligible actions. Native keybindings/selection apply.
Escape closes it. Actions revalidate current state; an old menu is not authority.

Both exec and goal controls use the selected eligible identity or require a
choice when ambiguous. A destructive command does not pick a newer run silently.
Use explicit full IDs across reloads or when several targets exist.

Hide toggles visibility only and preserves pinning/dismissals. ui off is
idempotent. Clear dismisses a view without cancelling work; show restores it.
Cancelled/abandoned runs cannot be restored as active display.

The strip counts accepted tasks, not raw worker claims. Review/final checks
remain gates after implementation progress. Narrow layouts drop decoration
before state/source/action; long detail belongs in the inspector/status.

Green requires current local observation or completion. In-flight snapshots,
uncertainty/stopping and prerequisites are amber; failed is red; user pause is
muted. The 15-second local-observation freshness limit does not prove model
progress. Native activity/actual-model telemetry is advisory.

## Pause, resume, cancel

```text
/exec pause <full-run-id>
/exec resume <full-run-id>
/exec cancel <full-run-id>
/goal pause <full-run-id>
/goal resume <full-run-id> --model current
/goal cancel <full-run-id>
```

Pause is resumable and preserves work. Cleanup remains tracked until exit.
Resume consumes/reconciles the same operation before authorizing another attempt.
Ordinary no-progress plan retries retain their lane and use backoff; there is no
global terminal retry cap. External prerequisites still need real resolution.

Cancel is final, hides the run immediately and preserves work/evidence.
Cancellation delivery is not retirement; wait for cancelled before claiming
cleanup finished. stop is a compatibility alias for cancel in both commands.

Requested and reported models differ. Status labels native-reported usage;
billing basis can be unavailable. Missing telemetry is not zero usage.

### Exceptional recovery

Start with status, retain the full ID and follow its one safe next action.
Do not manually resume a managed child through subagent.

```text
/exec resume <id> --model current
/exec resume <id> --same-machine
/exec resume <id> --retry-task
/exec resume <id> --adopt-current-branch
/exec recover-isolated <id> /absolute/new-checkout
/exec recover-isolated <id> /absolute/new-checkout --apply
/exec resume <id> --legacy-journal /absolute/offline.sqlite
```

Model override requires a current retired failed attempt and never changes later
operations. --same-machine is a factual hostname assertion, not worker-exit
evidence. Retry/branch adoption retain confirmation/ownership guards.

Isolated recovery requires explicit local-files-only scope. It quarantines the
old target/identity and leaves the new checkout paused; it does not prove the
old worker exited or copy arbitrary partial/ignored user content.

Legacy SQLite import is lazy, explicit, consistent/offline and read-only.
Known native IDs need no journal. No live journal is discovered or mutated.
Original identity, generations and abandonment remain authoritative.

```text
/exec cancel <id> --force
/exec cleanup
/exec cleanup --apply
/exec skip <id> --reason "why this optional stage is waived"
```

Force-stop is irreversible abandonment of management, not proof of exit.
Unknown ownership keeps its reservation; worktrees/branches/provider data stay.
Cleanup previews first and removes only eligible registry entries after retention,
never a live run or checkout. Failed records remain recoverable unless explicitly
included. Skip requires a human and cannot waive implementation, required review,
final verification or archive. A waiver ends as completed_with_findings.

Read [recovery](../skills/exec-plan/references/recovery.md) before controlling an
uncertain historical run. Never erase evidence to permit downgrade or restart.

## Review and acceptance

Default review is one readonly namespaced runtime role with commit-bound JSON.
Missing reports, schema errors, wrong commits and contradictory output cannot
pass. CRITICAL/MAJOR findings require fixes; MINOR-only advice may remain recorded.
Review fixes use fresh managed leaves and must be reviewed at their new commit.

New native requests are direct singles, excluded from workflow auto-resume.
Their UUID/digest/cwd/output are persisted before dispatch. Lost replies use
exact aliases; missing correlation never proves non-start. The final emission
and stop intent share a record fence. Required native proof is separate from
Git acceptance.

Optional Fusion/Revmux remain explicit and capability-gated. A version upgrade
or ordinary panel pass does not establish strict lifetime/ownership support.
No fallback may start over uncertain prior ownership.

For implementation boundaries see [architecture](architecture.md); for measured
real-session evidence see [UI validation](ui-validation.md).
