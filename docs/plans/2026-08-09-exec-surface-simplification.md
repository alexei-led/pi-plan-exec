# Simplifying the `/exec` surface

Status: findings and recommendations. Written 2026-08-09, after Tasks 1-9 of
`20260809-run-liveness-and-cleanup.md` added three more subcommands to an already large
surface.

## What exists today

12 subcommands, 8 flags, 20 recovery classifications, 9 run statuses, 6 interactive
prompts.

| Subcommand     | Flags                                               | What it means                                                 |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `/exec [plan]` | —                                                   | start a plan, or open the picker                              |
| `start [plan]` | —                                                   | **identical code path to bare `/exec`** (`src/index.ts:1315`) |
| `setup`        | —                                                   | print required packages                                       |
| `runs`         | `--all`                                             | list runs                                                     |
| `status [id]`  | —                                                   | detail for one run                                            |
| `doctor`       | `--reconcile`                                       | diagnose every in-flight run; reset abandoned ones            |
| `cleanup [id]` | `--apply`, `--include-failed`                       | delete registry entries                                       |
| `pause [id]`   | —                                                   | stop after the active child finishes                          |
| `resume [id]`  | `--model`, `--adopt-current-branch`, `--retry-task` | continue or recover                                           |
| `adopt [id]`   | —                                                   | claim a run owned by another session                          |
| `skip <id>`    | `--reason`                                          | waive a blocked review/finalize/stats stage                   |
| `cancel [id]`  | —                                                   | stop for good, keep the worktree                              |

The load is not 12. It is the cross product: **which of 20 classifications am I in, and
which of 12 commands with which of 8 flags does that imply.** `/exec status` prints the
answer, but the user must still know to run `status` first, and must trust it.

## Findings

### F1 — `start` is dead weight

```ts
const planPath =
  subcommand === EXEC_ACTION.START
    ? rest.join(" ") || (await selectPlan(ctx))
    : args || (await selectPlan(ctx));
```

Same branch, same picker, same everything. Two names for one behavior is the cheapest
possible thing to delete.

### F2 — `runs`, `status`, and `doctor` are one question at three zoom levels

- `runs` — all runs, one line each
- `status <id>` — one run, full detail
- `doctor` — all runs, with liveness evidence and a next command each

A user asking any of these is asking "what is going on". Three names for one question
forces a choice before the information that would inform the choice.

`doctor` is the worst offender: it is new, and its whole output is what `runs` should have
printed. `--all` is a zoom control on the same question.

### F3 — `adopt` is `resume` with a foreign lease

`isActionAllowed` (`src/index.ts`) separates them on state the tool already knows:

```ts
if (action === EXEC_ACTION.ADOPT)
  return !isTerminal(run.status) && run.lease?.sessionId !== sessionId;
```

The user must inspect the lease to pick the verb. The tool just read the lease. Since
Task 2, it can also prove the owner is dead. Making the human branch on a fact the
machine already has is backwards.

### F4 — `doctor --reconcile` then `resume` is one intent split in two

Reconcile converts a provably abandoned run into a recoverable `failed`. The only reason
to do that is so `resume` works. Two commands, in a fixed order, for one intent — and the
user must learn a word (`reconcile`) that names an implementation step, not a goal.

### F5 — `--adopt-current-branch` and `--retry-task` are flags that already require a prompt

Both already call `ctx.ui.confirm` and both throw without an interactive session. So the
flag does not avoid the prompt; it only pre-announces it. The user has to know the flag
exists to reach a dialog that would have explained itself.

### F6 — Three destructive verbs with no shared shape

`pause`, `cancel`, and `skip` are all "intervene in a running thing", with different
names, different arguments, and different reversibility. `skip` additionally demands a
full run ID and a reason. That friction is correct — it is a waiver — but it is
undiscoverable: nothing tells you `skip` exists at the moment it becomes the answer.

### F7 — The classification vocabulary leaks implementation words

`preserved unknown operation`, `force-skip reconciliation pending`,
`execution-branch mismatch`. These describe controller internals. A reader has to model
the controller to act. The classification should name the user's situation.

## Recommendation

**Principle: the user states intent, the tool derives state.** Every place the user must
branch on something the tool already knows is a place to fold.

### Proposed surface — 5 verbs

| Command             | Absorbs                                                                 | Behavior                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/exec [plan]`      | `start`                                                                 | No plan and one candidate: run it. Several: pick one. A run is already active here: say so and point at `resume`.                                           |
| `/exec status [id]` | `runs`, `doctor`, `--all`, `setup`                                      | No id: every run grouped by what it needs, each with one next command. With id: full detail. Missing packages appear here, not behind a separate verb.      |
| `/exec resume [id]` | `adopt`, `doctor --reconcile`, `--retry-task`, `--adopt-current-branch` | Continue from any state. Foreign dead lease: take it. Provably abandoned: reconcile, then continue. Retry or branch adoption: ask at the moment it matters. |
| `/exec stop [id]`   | `pause`, `cancel`                                                       | Ask: pause (resumable) or cancel (final, worktree kept). One word to remember, the distinction explained where it is made.                                  |
| `/exec cleanup`     | unchanged                                                               | Preview by default, `--apply` to delete registry entries.                                                                                                   |

Plus `/exec help`. `skip` stays as an expert escape hatch — see the caveat below.

Flags drop from 8 to 2 in normal use: `--apply` and `--model`.

### Why this helps a reader who struggles

- **One question, one verb.** "What is going on" is always `status`. There is no prior
  choice to get wrong.
- **One recovery verb.** Every stuck state answers `resume`. The user never has to know
  whether the situation is called adoption, reconciliation, or retry.
- **Decisions arrive with their context.** A confirm dialog at the moment of the choice
  explains the tradeoff. A flag requires knowing the tradeoff in advance.
- **Fewer words that name internals.** Rewrite the 20 classifications in terms of what
  the user does next, and collapse ones that share a next command.

## Two caveats that constrain this

### C1 — Agents cannot answer prompts

`skills/exec-plan/SKILL.md` is read by an agent, and the plan-exec worker subagents run
with no human. Folding flags into confirmations makes those paths unusable
non-interactively — the code already throws `"Force-skip requires interactive
confirmation."`

**Therefore: keep every flag as a non-interactive equivalent, but remove it from the
primary help.** Interactive is the default and the documented path; the flag is the
scripted escape hatch, documented once in the skill rather than in `/exec help`. This is
the difference between simplifying the surface and removing capability.

### C2 — Do not fold `skip`

It waives a stage and records a permanent waiver. Its friction — full run ID, mandatory
reason, interactive confirm — is a feature. Fold it and someone waives a review by
accident.

The fix for `skip` is discoverability, not simplification: when a stage is blocked,
`status` should print the exact `skip` command with the run ID already filled in. It
stays hard to run by accident and easy to run on purpose.

## Suggested order

1. Delete `start`. One line, zero risk, immediate.
2. Fold `runs` and `doctor` into `status`. Keep them as hidden aliases for one release so
   nothing breaks mid-run.
3. Fold `adopt` and `doctor --reconcile` into `resume`.
4. Add `stop`; keep `pause` and `cancel` as hidden aliases.
5. Rewrite the 20 classifications around next actions and collapse duplicates.
6. Rewrite `/exec help` to show 5 verbs, and move flags to the skill.

Steps 1-2 remove most of the felt complexity. Step 5 is the largest real win for a reader
who struggles, and the most work.

## What not to do

- Do not remove capability to reach a smaller number. Every fold above keeps the
  behavior and moves the choice to where the tool can make it or explain it.
- Do not fold `cleanup` into `status`. Reading and deleting must stay separate verbs.
- Do not auto-resume on session start. Task 8 settled this: a silent relaunch can
  double-write a worktree. Startup prints one line and stops.
