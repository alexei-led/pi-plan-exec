# pi-plan-exec

Run a checked Markdown plan—or pursue a goal—with isolated work, required review,
verified commits and deliberate recovery.

A worker saying “done” is not completion. Plan-exec verifies committed checkboxes,
frozen repository checks, clean Git state and commit-bound review before accepting
work. One registry owns dispatch, leases and checkout reservations.

## Requirements

- Pi **1.5.0+ in the tested 1.x range**, Node **>=22.19.0**, and Git.
- Unmodified **pi-subagents 0.84.x**; development/consumer baseline **0.84.0**.
- Darwin or Linux with `/usr/bin/clang` or `/usr/bin/cc`. Kernel registry locks
  compile a small Node-API binding; there is no unsafe stale-lock fallback.

Install the packages independently:

```bash
pi install -l npm:pi-subagents@0.84.0
pi install -l npm:@alexeiled/pi-plan-exec@2.3.0
```

Restart Pi after package upgrades. Use `/reload` only for local source/config
changes. Bridge, pi-tasks and cc-thingz are not dependencies.

The SDK and TUI stay host-provided peers, never private runtime copies. Optional
Fusion 0.12.x and Revmux are explicit review selections, but released versions do
not establish the strict lifecycle contract this executor needs. Default review
is one required readonly `plan-exec-reviewer`, with no implicit fallback.

Read the installed [runtime contracts](skills/exec-plan/references/runtime-contracts.md)
for ownership, output, limits and historical recovery.

## Start a plan

Store a plan inside the Git repository:

```markdown
# Add greeting

### Task 1: Implement the greeting

- [ ] Add the greeting and its behavior test.
- [ ] Run the relevant checks.

### Task 2: Document it

- [ ] Update the user guide.
- [ ] Verify the documented example.
```

In Pi:

```text
/exec docs/plans/greeting.md
```

Choose **Worktree (isolated)** unless you deliberately want in-place work.
The interactive preview shows the target branch/directory, models, review,
bootstrap/check argv and requested limits before allocation. A worktree is not a
sandbox: repository commands run with your permissions.

Bare `/exec` opens the plan picker. To use an existing registered checkout:

```text
/exec --worktree "/absolute/existing-worktree" docs/plans/greeting.md
```

Continue in the execution session/worktree after handoff. Do not launch another
worker against the same target.

## Start a goal

```text
/goal Fix the failing parser tests --check "npm test"
```

A goal works in place on the current branch, requires a clean tree and at least
one check, and commits its work. It does not need a plan file. The controller
continues authorized turns, reassesses unchanged tracked state, and pauses for
an explicit goal blocker, observed prerequisite, provider failure or turn budget.

Only a successful turn with verified committed work can complete the goal.
Deleting tests or adding supported disabled-test declarations triggers a
heuristic completion guard; checks and review remain necessary. Ordinary
application APIs such as `query.skip()` are not test-disable declarations.

## Controls

| Command | Result |
| --- | --- |
| `/exec status [full-run-id]` | Read-only diagnosis, paths, checks, ownership and one safe next action |
| `/exec inspect [full-run-id]` | Native keyboard-driven overview, tasks, checks/review, evidence and exact-ID actions |
| `/exec pause [full-run-id]` | Preserve work and pause resumably; track cleanup until exit |
| `/exec resume [full-run-id]` | Recover the same run, consume saved output or authorize a safe new attempt |
| `/exec cancel [full-run-id]` | Final cancellation and immediate display dismissal; saved work stays |
| `/exec hide` | Toggle display only; preserve pinning and dismissals |
| `/exec help` | Basic controls; `help advanced` includes exceptional recovery |

The same controls work under `/goal`, including `inspect` and advanced resume
flags. Prefer full IDs when several runs exist. A pinned eligible goal is not
silently replaced by whichever run updated last; ambiguity requires selection.

Escape closes an inspector/dialog. It does not cancel durable work.

### Display truth

The strip shows state, identity, accepted count and current action. Wide views
stay compact; narrow views drop the bar before losing state/action. Colors and
text carry the same meaning:

- Green: locally observed work or verified completion—not proof of useful worker progress.
- Amber: snapshot, blocker, uncertainty, retry or stopping.
- Red: failed.
- Muted: explicit user pause.

A live view needs a matching local lease and a recent successful observation.
A pending poll ages into **Snapshot**. Paused cleanup remains active background
work until retirement. Native activity is explicitly reported/advisory, never
verified acceptance.

Routine tool/turn updates stay in the live view. Notifications mark meaningful
transitions, blockers, recovery and terminal outcomes. Requested and reported
models are separate; native-reported child usage does not establish provider billing.
Native completion notifications can start parent model turns; their usage is
separate. Let the controller manage its checkout, not the notification response.

## Configuration and limits

Settings are read from `.pi/plan-exec.json` and frozen when a run starts:

```json
{
  "requiredChecks": [["npm", "test"]],
  "reviewBackend": "subagent",
  "reviewRequired": true,
  "reviewFallback": [],
  "executionLifetime": { "mode": "bounded", "timeoutMs": 1800000 }
}
```

Without explicit checks/bootstrap, supported repository files supply defaults.
The preview shows command argument arrays, not shell expansions.

Important limits:

- Default lifetime is **unbounded requested**, not end-to-end unbounded: native
  single-agent/config defaults still apply, normally 30 minutes.
- Native RPC does **not** enforce requested worker/reviewer/statistics maxTurns.
- Goal `maxTaskIterations` is an implementation-turn budget, not a plan retry cap.
- `taskRetries`, `reviewIterations` and `fusionIterations` are deprecated
  diagnostic settings, not enforced retry limits.
- Automatic plan recovery can continue with backoff; use pause/cancel to stop it.
- Local checks/bootstrap use an unbounded user-stoppable owned process group.
  Native runner proof and escaped-descendant limitations remain explicit.

See the [full guide](https://github.com/alexei-led/pi-plan-exec/blob/v2.3.0/docs/guide.md).

## Recovery and upgrades

New operations are **direct native singles (adapter v2)**, not one-child script
workflows. They avoid native workflow auto-resume without editing global settings.
Saved request IDs and exact native aliases recover lost replies; unknown ownership
never authorizes replay or a second writer.

Before upgrading from workflow-based releases, quiesce old controllers/workers
with their original runtime and back up retained evidence. Unresolved historical
v1 workflows are not silently converted or continued in place. A retired
failed/stopped root alone does not establish absence of a successor. Their original
requests and checkout reservations remain; read the
[recovery reference](skills/exec-plan/references/recovery.md).

Provider recovery can use one explicit replacement model:

```text
/exec resume <full-run-id> --model current
```

It requires proven retirement and does not change frozen configuration or later
operations. Permission/configuration failures are not reasons to switch models.

Force-stop (`cancel <id> --force`) is irreversible management abandonment—not
worker-exit proof. Unknown ownership stays reserved. Cleanup deletes eligible
registry entries, never worktrees/branches. Neither action is successful completion.

Do not downgrade over native records/artifacts. Use the
[read-only rollback preflight](https://github.com/alexei-led/pi-plan-exec/blob/v2.3.0/DEVELOPMENT.md#rollback-preflight);
never delete evidence merely to make it pass.

## More

- [Runtime contracts](skills/exec-plan/references/runtime-contracts.md)
- [Guide](https://github.com/alexei-led/pi-plan-exec/blob/v2.3.0/docs/guide.md)
- [Architecture](https://github.com/alexei-led/pi-plan-exec/blob/v2.3.0/docs/architecture.md)
- [Development and release](https://github.com/alexei-led/pi-plan-exec/blob/v2.3.0/DEVELOPMENT.md)
- [UI validation evidence](https://github.com/alexei-led/pi-plan-exec/blob/v2.3.0/docs/ui-validation.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE)
