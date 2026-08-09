import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunRegistry } from "../src/registry.js";
import {
  abandonedRunsNotice,
  abandonmentProbe,
  chooseStopOutcome,
  execCleanup,
  execDoctor,
  execHelp,
  execSetup,
  isRemovableRun,
  parseCleanupArguments,
  parseDoctorArguments,
  sweepAbandonment,
  type EvidenceProbe,
  execRead,
  execStatus,
  formatRunStatus,
  getExecArgumentCompletions,
  hasBridgeOperationMethod,
  hasBridgeWorkflowScriptSpawnCapability,
  isActionAllowed,
  isRecoverableFailure,
  isStageWaiverAvailable,
  missingRuntimeTools,
  needsPlanStructureReview,
  parseResumeArguments,
  parseResumeOptions,
  parseSkipReason,
  parseStatusArguments,
  reconcileForResume,
  runActionFor,
  settledRunLines,
  resumeResultMessage,
  prioritizeRunCandidates,
  recoveryGuidance,
  reviewedPlanHashForResume,
} from "../src/index.js";
import {
  EXEC_ACTION,
  EXEC_ALIAS_ACTIONS,
  type PlanExecRun,
} from "../src/types.js";

const config = {
  taskRetries: 1,
  maxTaskIterations: 50,
  reviewIterations: 5,
  fusionIterations: 10,
  finalizeEnabled: true,
  workerAgent: "worker",
  workerMaxTurns: 50,
  reviewerAgent: "reviewer",
  reviewerMaxTurns: 30,
  statsAgent: "reviewer",
  statsMaxTurns: 30,
};

function run(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    repositoryRoot: "/repo",
    planPath: "/repo/docs/plans/example.md",
    planHash: "hash",
    worktreeCwd: "/repo",
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    skippedStages: [],
    branchRebindings: [],
    progressPath: "/repo/.ralphex/progress.txt",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
    },
    config,
    createdAt: 1,
    updatedAt: Date.now(),
    unresolvedFindings: [],
    ...overrides,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PAST_RETENTION = Date.now() - 8 * DAY_MS;
const INSIDE_RETENTION = Date.now() - 6 * DAY_MS;

/** A terminal run with no tracked operation, the shape cleanup considers. */
function retiredRun(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  const retired = run({
    status: "completed",
    stage: "complete",
    updatedAt: PAST_RETENTION,
    ...overrides,
  });
  delete retired.activeOperation;
  return retired;
}

/** Every registry test writes into its own temp directory, never ~/.pi. */
async function seedDirectory(
  runs: PlanExecRun[],
): Promise<{ registry: RunRegistry; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-cleanup-"));
  for (const seed of runs) {
    await mkdir(join(directory, seed.id), { recursive: true });
    await writeFile(
      join(directory, seed.id, "run.json"),
      `${JSON.stringify(seed)}\n`,
      "utf8",
    );
  }
  return { registry: new RunRegistry(directory), directory };
}

async function seedRegistry(runs: PlanExecRun[]): Promise<RunRegistry> {
  return (await seedDirectory(runs)).registry;
}

/** Raw bytes per run directory, so "wrote nothing" can be asserted literally. */
async function snapshotRuns(
  directory: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(directory))
    snapshot[entry] = await readFile(
      join(directory, entry, "run.json"),
      "utf8",
    );
  return snapshot;
}

const DEAD_LEASE = {
  sessionId: "session-gone",
  pid: process.pid,
  heartbeatAt: Date.now() - 10 * 60_000,
  hostname: hostname(),
};

const LIVE_LEASE = {
  sessionId: "session-live",
  pid: process.pid,
  heartbeatAt: Date.now(),
  hostname: hostname(),
};

const MISSING_ASYNC_DIR = join(
  tmpdir(),
  "pi-plan-exec-async-that-never-existed",
);

/** A run whose worker is provably gone: dead lease, operation directory absent. */
function abandonedRun(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return run({
    lease: DEAD_LEASE,
    taskAttempts: { "1": 2 },
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      taskId: 1,
      asyncDir: MISSING_ASYNC_DIR,
    },
    ...overrides,
  });
}

test("bridge runtime compatibility requires recovery and workflow spawn capabilities", () => {
  assert.equal(
    hasBridgeOperationMethod({ methods: ["ping", "operation"] }),
    true,
  );
  assert.equal(hasBridgeOperationMethod({ methods: ["ping", "spawn"] }), false);
  assert.equal(hasBridgeOperationMethod({ methods: "operation" }), false);
  assert.equal(hasBridgeOperationMethod(undefined), false);

  assert.equal(
    hasBridgeWorkflowScriptSpawnCapability({
      capabilities: { workflowScriptSpawn: true },
    }),
    true,
  );
  assert.equal(
    hasBridgeWorkflowScriptSpawnCapability({
      capabilities: { workflowScriptSpawn: false },
    }),
    false,
  );
  assert.equal(hasBridgeWorkflowScriptSpawnCapability(undefined), false);
});

test("exec command completions explain the command family", () => {
  const items = getExecArgumentCompletions("st");
  assert.deepEqual(
    items?.map((item) => item.value),
    ["status", "stop"],
  );
  assert.match(items?.[0]?.description ?? "", /every run and what it needs/);
  const allItems = getExecArgumentCompletions("") ?? [];
  assert.match(allItems.map((item) => item.value).join(" "), /setup/);
  assert.match(
    allItems.find((item) => item.value === "resume")?.description ?? "",
    /Continue the current run safely/,
  );
  assert.match(
    allItems.find((item) => item.value === "skip")?.description ?? "",
    /Force-skip/,
  );
});

test("runtime prerequisite check identifies missing provider extensions", () => {
  assert.deepEqual(missingRuntimeTools(["TaskCreate"]), ["pi-subagents"]);
  assert.deepEqual(missingRuntimeTools(["subagent", "TaskCreate"]), []);
});

test("help and setup explain the installed command surface", () => {
  assert.match(execHelp(), /\/exec status \[run-id\]/);
  assert.match(execHelp(), /Continue a stuck run/);
  assert.match(execHelp(), /\/exec skip <full-run-id> --reason <text>/);
  assert.match(execHelp(), /--model current\|provider\/model/);
  assert.match(execHelp(), /completed_with_findings/);
  assert.match(execHelp(), /\/exec cleanup \[full-run-id\]/);
  assert.match(execHelp(), /registry entries only/);
  assert.match(execHelp(), /\/skill:exec-plan/);
  assert.match(execHelp(), /\/exec status \[run-id\] \[--all\]/);
  for (const alias of EXEC_ALIAS_ACTIONS)
    assert.doesNotMatch(execHelp(), new RegExp(`/exec ${alias}`), alias);
  assert.match(
    execSetup(),
    /pi install npm:@alexeiled\/pi-subagents-bridge@>=0\.2\.2/,
  );
  assert.match(execSetup(), /pi install npm:@alexeiled\/pi-fusion/);
  assert.match(execSetup(), /pi install npm:@alexeiled\/pi-plan-exec/);
});

test("setup install commands carry no caret version pin", () => {
  assert.doesNotMatch(execSetup(), /@\^/);
  assert.match(execSetup(), /^pi install npm:pi-subagents$/m);
});

test("cancel cannot bypass a pending force-skip", () => {
  const pending = run({
    status: "skip_pending",
    stage: "comprehensive_review",
    pendingStageSkip: {
      stage: "comprehensive_review",
      reason: "operator waiver",
      requestedAt: 1,
      requestedBy: "session-1",
    },
  });

  assert.equal(isActionAllowed("cancel", pending, "session-1"), false);
  assert.equal(isActionAllowed("resume", pending, "session-1"), false);
  assert.equal(isActionAllowed("skip", pending, "session-1"), true);
});

test("resume accepts options without an explicit run ID", () => {
  assert.deepEqual(parseResumeArguments(["--retry-task"]), {
    selector: undefined,
    adoptCurrentBranch: false,
    retryTask: true,
    model: undefined,
  });
  assert.deepEqual(
    parseResumeArguments([
      "run-id",
      "--adopt-current-branch",
      "--retry-task",
      "--model",
      "current",
    ]),
    {
      selector: "run-id",
      adoptCurrentBranch: true,
      retryTask: true,
      model: "current",
    },
  );
});

test("resume branch-adoption and recovery-model options are explicit", () => {
  assert.deepEqual(parseResumeOptions([]), {
    adoptCurrentBranch: false,
    retryTask: false,
    model: undefined,
  });
  assert.deepEqual(parseResumeOptions(["--adopt-current-branch"]), {
    adoptCurrentBranch: true,
    retryTask: false,
    model: undefined,
  });
  assert.deepEqual(parseResumeOptions(["--retry-task"]), {
    adoptCurrentBranch: false,
    retryTask: true,
    model: undefined,
  });
  assert.deepEqual(
    parseResumeOptions([
      "--adopt-current-branch",
      "--retry-task",
      "--model",
      "anthropic-work/claude-sonnet-4-6",
    ]),
    {
      adoptCurrentBranch: true,
      retryTask: true,
      model: "anthropic-work/claude-sonnet-4-6",
    },
  );
  assert.throws(() => parseResumeOptions(["--model"]), /Usage/);
  assert.throws(() => parseResumeOptions(["--force"]), /Usage/);

  const running = run({ status: "running" });
  delete running.activeOperation;
  assert.equal(isActionAllowed("resume", running, "session-1"), true);
  assert.equal(isActionAllowed("resume", running, "session-1", true), true);
  const failed = run({ status: "failed" });
  delete failed.activeOperation;
  assert.equal(isActionAllowed("resume", failed, "session-1", true), true);
  const busy = run({
    status: "running",
    activeOperation: {
      operationId: "live-review",
      service: "bridge",
      kind: "review",
      externalRunId: "live-run",
    },
  });
  assert.equal(isActionAllowed("resume", busy, "session-1", true), false);
});

test("force-skip reason parsing requires the explicit option and text", () => {
  assert.equal(
    parseSkipReason(["--reason", "review", "loop", "is", "stuck"]),
    "review loop is stuck",
  );
  assert.throws(() => parseSkipReason([]), /Usage/);
  assert.throws(() => parseSkipReason(["--reason"]), /Usage/);
  assert.throws(() => parseSkipReason(["because"]), /Usage/);
});

test("failed and cancellation-pending runs are eligible for recovery", () => {
  assert.equal(
    isRecoverableFailure(
      run({
        status: "failed",
        error: "Plan task structure changed outside checkbox completion.",
      }),
    ),
    true,
  );
  assert.equal(
    needsPlanStructureReview(
      run({
        status: "paused",
        error: "Plan task structure changed outside checkbox completion.",
      }),
    ),
    true,
  );
  const exhaustedWorker = run({
    status: "failed",
    error: "Worker run-2 ended as failed and left task 1 checkboxes unchecked.",
  });
  delete exhaustedWorker.activeOperation;
  assert.equal(isRecoverableFailure(exhaustedWorker), true);
  const crashedWorker = run({
    status: "failed",
    error: "worker crashed",
  });
  delete crashedWorker.activeOperation;
  assert.equal(isRecoverableFailure(crashedWorker), true);
  assert.equal(
    isRecoverableFailure(
      run({
        status: "failed",
        error: "worker crashed",
        activeOperation: {
          operationId: "still-running",
          service: "bridge",
          kind: "review",
        },
      }),
    ),
    true,
  );
  assert.equal(isRecoverableFailure(run({ status: "cancel_pending" })), true);
});

test("run status classifies recovery and gives one safe next action", () => {
  const active = formatRunStatus(
    run({
      status: "running",
      activeOperation: {
        operationId: "active-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
      },
    }),
  );
  // No reported signal is not health. This assertion is the regression guard
  // for the original bug: the old text said the operation was healthy here,
  // which read identically for a live worker and a dead one.
  assert.match(
    active,
    /recovery: running, but nothing proves the worker is alive/,
  );
  assert.match(active, /next safe action: Wait and use \/exec status/);
  assert.match(active, /Do not resume/);
  assert.doesNotMatch(active, /reported activity/);

  // A trustworthy activity value still earns the alive reading. Without this
  // pair the status text would be honest but undiscriminating, which is its own
  // failure.
  const signalled = formatRunStatus(
    run({
      status: "running",
      activeOperation: {
        operationId: "active-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      },
    }),
  );
  assert.match(
    signalled,
    /recovery: running, and the worker reported activity/,
  );

  const failedRun = run({
    status: "failed",
    error: "worker crashed before launch",
  });
  delete failedRun.activeOperation;
  const failed = formatRunStatus(failedRun);
  assert.match(failed, /recovery: stopped, and you can continue it/);
  assert.match(failed, /resume .* retries the same stage/);

  const blockedRun = run({
    status: "failed",
    taskAttempts: { "1": 2 },
    error: "Task 1 exhausted its retry limit. Provider billing unavailable.",
  });
  delete blockedRun.activeOperation;
  const blocked = formatRunStatus(blockedRun);
  assert.match(
    blocked,
    /recovery: a task is blocked by something outside this run/,
  );
  // The flag left the guidance with the help text; interactive resume asks.
  assert.match(blocked, /interactive \/exec resume .*asks before retrying/);
  assert.doesNotMatch(blocked, /--retry-task/);
  assert.match(blocked, /Implementation work cannot be waived/);

  const modelFailureRun = run({
    status: "failed",
    error:
      "Worker failed because the model/provider is unusable: Invalid call_id: maximum length 64.",
    failedOperation: {
      operationId: "failed-model-operation",
      service: "bridge",
      kind: "implementation",
      externalRunId: "failed-model-run",
      taskId: 1,
      terminalError:
        "Codex error: [string_above_max_length] Invalid call_id: maximum length 64.",
    },
  });
  delete modelFailureRun.activeOperation;
  const modelFailure = formatRunStatus(modelFailureRun);
  assert.match(
    modelFailure,
    /recovery: stopped because the model or provider could not be used/,
  );
  assert.match(
    modelFailure,
    /Run \/exec resume .*model this Pi session is signed in to/,
  );
  assert.match(modelFailure, /failed-model-run/);
  assert.match(modelFailure, /string_above_max_length/);

  const unknown = formatRunStatus(
    run({
      status: "failed",
      error: "Bridge operation lookup is unresolved",
      activeOperation: {
        operationId: "unknown-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
      },
    }),
  );
  assert.match(unknown, /recovery: cannot check on the worker right now/);
  assert.match(unknown, /the tool never learned its name/);
  assert.match(unknown, /Do not start another worker/);

  const pausedRun = run({ status: "paused", stage: "comprehensive_review" });
  delete pausedRun.activeOperation;
  const paused = formatRunStatus(pausedRun);
  assert.match(paused, /recovery: paused, waiting for you to continue it/);
  assert.match(paused, /resume .* applies the paused stage/);

  const cancellingRun = run({ status: "cancel_pending" });
  delete cancellingRun.activeOperation;
  const cancelling = formatRunStatus(cancellingRun);
  assert.match(cancelling, /recovery: waiting for the stop you asked for/);
  assert.match(cancelling, /resume .* retries only the stop/);

  const staleOwnerRun = run({
    status: "failed",
    lease: { sessionId: "old-session", pid: 1, heartbeatAt: 0 },
  });
  delete staleOwnerRun.activeOperation;
  const staleOwner = formatRunStatus(staleOwnerRun);
  assert.match(staleOwner, /owner: stale lease/);
  assert.match(staleOwner, /\/exec resume/);
  assert.doesNotMatch(staleOwner, /\/exec adopt/);
  assert.equal(isActionAllowed("resume", staleOwnerRun, "session-1"), true);

  const branchMismatch = formatRunStatus(
    run({
      status: "failed",
      error: "Execution directory is on feature/current, expected master.",
    }),
  );
  assert.match(
    branchMismatch,
    /recovery: this run belongs to a branch you are not on/,
  );
  // The flag left the guidance with the help text; interactive resume asks.
  assert.match(branchMismatch, /interactive \/exec resume .*asks before/);
  assert.doesNotMatch(branchMismatch, /--adopt-current-branch/);

  const planMismatch = formatRunStatus(
    run({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(
    planMismatch,
    /recovery: the plan file changed shape since this run started/,
  );
  assert.match(planMismatch, /first resume only records this pause/);

  const terminal = formatRunStatus(
    run({ status: "completed", stage: "complete" }),
  );
  assert.match(terminal, /recovery: finished/);
  assert.match(terminal, /nothing to recover/);
  assert.match(terminal, /\/exec cleanup/);
});

test("an overdue operation is classified without being called dead", () => {
  const MINUTE_MS = 60_000;
  // Test config: workerMaxTurns 50 => 100m bound, reviewerMaxTurns 30 => 60m.
  const active = (
    agoMinutes: number | undefined,
    overrides: Partial<PlanExecRun["activeOperation"]> = {},
    runOverrides: Partial<PlanExecRun> = {},
  ): PlanExecRun =>
    run({
      status: "running",
      activeOperation: {
        operationId: "active-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
        ...(agoMinutes === undefined
          ? {}
          : { launchStartedAt: Date.now() - agoMinutes * MINUTE_MS }),
        ...overrides,
      },
      ...runOverrides,
    });

  const cases: [string, PlanExecRun, string][] = [
    // The reported bug: a healthy worker mid-model-call at nine minutes.
    [
      "nine minutes, no signal",
      active(9),
      "running, but nothing proves the worker is alive",
    ],
    [
      "nine minutes, workflow-mode signal with no activity",
      active(9, { workerSignal: { mode: "workflow" } }),
      "running, but nothing proves the worker is alive",
    ],
    [
      "inside the worker bound, no signal",
      active(99),
      "running, but nothing proves the worker is alive",
    ],
    [
      "past the worker bound, no signal",
      active(101),
      "running longer than its budget allows",
    ],
    // Same elapsed time, different stage budget: the bound is derived, not flat.
    [
      "past the reviewer bound but inside the worker bound",
      active(65),
      "running, but nothing proves the worker is alive",
    ],
    [
      "past the reviewer bound on a review operation",
      active(65, { kind: "review" }),
      "running longer than its budget allows",
    ],
    // Fresh activity outranks the timer; the operation is provably alive.
    [
      "past the bound with a trustworthy activity value",
      active(180, {
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      }),
      "running, and the worker reported activity",
    ],
    // Decisive death still wins over a mere bound breach.
    [
      "past the bound with the async directory gone",
      active(180, { workerSignal: { asyncDirMissing: true } }),
      "the worker's files are gone, so nothing is running",
    ],
    [
      "past the bound while observation is unavailable",
      active(180, { statusFailures: 1 }),
      "cannot check on the worker right now",
    ],
    [
      "past the bound while still starting",
      active(180, {}, { status: "starting" }),
      "running longer than its budget allows",
    ],
    // A pre-upgrade record carries no launch time and cannot be bounded.
    [
      "no launch time recorded",
      active(undefined),
      "running, but nothing proves the worker is alive",
    ],
    // The bound only speaks while the bridge still reports the run in flight.
    [
      "past the bound on a failed run",
      active(180, {}, { status: "failed", error: "worker crashed" }),
      "stopped, and you can continue it",
    ],
  ];
  for (const [name, candidate, classification] of cases)
    assert.equal(
      recoveryGuidance(candidate).classification,
      classification,
      name,
    );

  const overdue = formatRunStatus(active(180));
  assert.match(overdue, /recovery: running longer than its budget allows/);
  assert.match(overdue, /past the 100m allowed for its 50-turn budget/);
  // Names the uncertainty, offers both escapes, and forbids a second writer.
  assert.match(overdue, /not proof the worker is stuck/);
  assert.match(overdue, /\/exec status .* to re-check/);
  assert.match(overdue, /\/exec stop .* preserve the worktree/);
  assert.match(overdue, /Do not resume or start a second run/);
  assert.doesNotMatch(overdue, /healthy|dead|stalled/);
});

test("no recovery classification names a controller internal", async () => {
  // Scraped from source, not from a shape table: a table only guards the
  // branches it lists, and the point is that a branch added later cannot
  // reintroduce the vocabulary either.
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const classifications = [
    ...source.matchAll(/classification:\s*"([^"]+)"/g),
  ].map((match) => match[1] ?? "");
  assert.ok(
    classifications.length >= 15,
    `expected the classification literals to be found, got ${classifications.length}`,
  );
  for (const classification of classifications)
    assert.doesNotMatch(
      classification,
      /preserved|reconciliation|operation identity/i,
      `classification names a controller internal: ${classification}`,
    );
});

test("every recovery classification ends at a primary verb", () => {
  const withoutOperation = (overrides: Partial<PlanExecRun>): PlanExecRun => {
    const shape = run(overrides);
    delete shape.activeOperation;
    return shape;
  };
  const launched = (
    overrides: Partial<NonNullable<PlanExecRun["activeOperation"]>> = {},
  ): NonNullable<PlanExecRun["activeOperation"]> => ({
    operationId: "operation-1",
    service: "bridge",
    kind: "implementation",
    taskId: 1,
    externalRunId: "worker-run-1",
    launchStartedAt: Date.now() - 180 * 60_000,
    ...overrides,
  });
  const unnamedOperation = run({
    status: "failed",
    error: "Bridge operation lookup is unresolved",
    activeOperation: { operationId: "op", service: "bridge", kind: "review" },
  });
  const unobservable = run({
    activeOperation: launched({ statusFailures: 1 }),
  });
  const trackedFailure = run({
    status: "failed",
    error: "worker crashed",
    activeOperation: launched(),
  });
  const untrackedFailure = withoutOperation({
    status: "failed",
    error: "worker crashed",
  });
  const shapes: PlanExecRun[] = [
    retiredRun(),
    withoutOperation({ lease: DEAD_LEASE }),
    withoutOperation({
      status: "failed",
      error: "Execution directory is on feature/current, expected master.",
    }),
    withoutOperation({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
    run({ status: "skip_pending" }),
    run({ status: "cancel_pending" }),
    unnamedOperation,
    unobservable,
    run({
      activeOperation: launched({ workerSignal: { asyncDirMissing: true } }),
    }),
    run({ activeOperation: launched() }),
    run({ activeOperation: launched({ launchStartedAt: Date.now() }) }),
    run({
      activeOperation: launched({
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      }),
    }),
    withoutOperation({ status: "running" }),
    withoutOperation({ status: "paused", stage: "comprehensive_review" }),
    withoutOperation({
      status: "failed",
      error: "Worker failed: invalid api key.",
    }),
    withoutOperation({
      status: "failed",
      taskAttempts: { "1": 2 },
      error: "Task 1 exhausted its retry limit. Provider billing unavailable.",
    }),
    trackedFailure,
    untrackedFailure,
  ];

  for (const shape of shapes) {
    const { classification, action } = recoveryGuidance(shape);
    assert.match(
      action,
      /\/exec (status|resume|stop|cleanup)\b/,
      `no primary verb: ${classification}`,
    );
    assert.doesNotMatch(
      action,
      /\/exec (start|runs|doctor|setup|adopt|pause|cancel)\b/,
      `names a retired alias: ${classification}`,
    );
  }

  // The two collapses: one situation each, not two words for the same answer.
  assert.equal(
    recoveryGuidance(unnamedOperation).classification,
    recoveryGuidance(unobservable).classification,
  );
  assert.equal(
    recoveryGuidance(trackedFailure).classification,
    recoveryGuidance(untrackedFailure).classification,
  );
});

test("status guidance judges lease staleness the way claiming does", () => {
  const { pid } = spawnSync("true");
  assert.ok(pid, "spawnSync must report a child pid");
  const deadLocalOwner = run({
    lease: {
      sessionId: "old-session",
      pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });
  assert.match(formatRunStatus(deadLocalOwner), /owner: stale lease/);

  const liveLocalOwner = run({
    lease: {
      sessionId: "old-session",
      pid: process.pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });
  assert.doesNotMatch(formatRunStatus(liveLocalOwner), /owner: stale lease/);

  // No hostname is the on-disk shape of every existing run: heartbeat only.
  const legacyOwner = run({
    lease: { sessionId: "old-session", pid, heartbeatAt: Date.now() },
  });
  assert.doesNotMatch(formatRunStatus(legacyOwner), /owner: stale lease/);
});

test("resume output explains a required second plan-structure review", () => {
  const paused = run({
    status: "paused",
    error: "Plan task structure changed outside checkbox completion.",
  });
  delete paused.activeOperation;
  const message = resumeResultMessage(paused);
  assert.match(message, /first resume only recorded the pause/);
  assert.match(message, /run interactive \/exec resume/);

  const resumed = resumeResultMessage(run({ status: "running" }));
  assert.match(
    resumed,
    /already running; its tracked worker is being reconciled/,
  );

  const reconciling = resumeResultMessage(
    run({
      status: "running",
      activeOperation: {
        operationId: "live-worker",
        service: "bridge",
        kind: "implementation",
      },
    }),
  );
  assert.match(
    reconciling,
    /already running; its tracked worker is being reconciled/,
  );
  assert.doesNotMatch(resumed, /second resume/);
});

test("run status includes live operation, progress, and recovery hints", () => {
  const status = formatRunStatus(
    run({
      status: "failed",
      error: "Plan structure changed",
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
      },
    }),
  );
  assert.match(status, /status: failed/);
  assert.match(status, /operation: bridge\/implementation \(Task 1\)/);
  assert.match(status, /operation ID: operation-1/);
  assert.match(status, /external run ID: worker-run-1/);
  assert.match(status, /progress: \/repo\/\.ralphex\/progress\.txt/);
  assert.match(status, /error: Plan structure changed/);
  assert.match(status, /worktree that was kept/);

  const recoverable = formatRunStatus(
    run({
      status: "failed",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(recoverable, /interactive \/exec resume/);

  const failedWorker = run({
    status: "failed",
    error: "Worker run-2 ended as failed and left task 1 checkboxes unchecked.",
  });
  delete failedWorker.activeOperation;
  assert.match(formatRunStatus(failedWorker), /retries the same stage/);

  const paused = formatRunStatus(
    run({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(paused, /interactive \/exec resume/);
  assert.doesNotMatch(paused, /next: \/exec status/);

  const skippedRun = run({
    status: "completed_with_findings",
    stage: "complete",
    skippedStages: [
      {
        stage: "comprehensive_review",
        reason: "operator waiver",
        requestedAt: 1,
        requestedBy: "session-1",
        completedAt: 2,
        terminalOperationState: "stopped",
      },
    ],
  });
  delete skippedRun.activeOperation;
  const skipped = formatRunStatus(skippedRun);
  assert.match(skipped, /force-skipped stages/);
  assert.match(skipped, /operator waiver/);
});

test("run status distinguishes unavailable observation from normal polling", () => {
  const status = formatRunStatus(
    run({
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        statusFailures: 2,
        lastStatusError: "bridge unavailable",
      },
    }),
  );
  assert.match(status, /observation: unavailable \(2\/3\)/);
  assert.match(status, /bridge unavailable/);
});

test("resume keeps exact-worktree priority over a live isolated run", () => {
  const recoverableInPlace = run({
    id: "11111111-1111-4111-8111-111111111111",
    status: "failed",
    error: "Plan task structure changed outside checkbox completion.",
    worktreeCwd: "/repo",
  });
  const pausedIsolated = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "paused",
    worktreeCwd: "/tmp/execution-worktree",
  });

  assert.deepEqual(
    prioritizeRunCandidates([recoverableInPlace, pausedIsolated], "/repo").map(
      (candidate) => candidate.id,
    ),
    [recoverableInPlace.id],
  );
});

test("plan-structure recovery requires interactive adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-index-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Changed\n- [ ] New text\n");
  const recoverable = run({
    planPath,
    status: "failed",
    error: "Plan task structure changed outside checkbox completion.",
  });

  await assert.rejects(
    reviewedPlanHashForResume(recoverable, {
      hasUI: false,
      ui: { confirm: async () => false },
    }),
    /interactive Pi/,
  );

  let confirmed = false;
  const adoptedHash = await reviewedPlanHashForResume(recoverable, {
    hasUI: true,
    ui: {
      confirm: async () => {
        confirmed = true;
        return true;
      },
    },
  });
  assert.equal(confirmed, true);
  assert.notEqual(adoptedHash, recoverable.planHash);
  assert.equal(
    await reviewedPlanHashForResume(run({ status: "failed" }), {
      hasUI: false,
      ui: { confirm: async () => false },
    }),
    undefined,
  );
});

test("removable runs are terminal, past retention, and unheld", () => {
  const liveLease = {
    sessionId: "session-1",
    pid: process.pid,
    heartbeatAt: Date.now(),
    hostname: hostname(),
  };
  const staleLease = {
    sessionId: "session-1",
    pid: process.pid,
    heartbeatAt: 0,
    hostname: hostname(),
  };
  const cases: Array<{
    name: string;
    run: PlanExecRun;
    includeFailed?: boolean;
    removable: boolean;
  }> = [
    {
      name: "a retired completed run is removable",
      run: retiredRun(),
      removable: true,
    },
    {
      name: "completed_with_findings is removable",
      run: retiredRun({ status: "completed_with_findings" }),
      removable: true,
    },
    {
      name: "cancelled is removable",
      run: retiredRun({ status: "cancelled" }),
      removable: true,
    },
    {
      name: "failed is excluded by default so resume stays available",
      run: retiredRun({ status: "failed", stage: "implementation" }),
      removable: false,
    },
    {
      name: "failed is removable with --include-failed",
      run: retiredRun({ status: "failed", stage: "implementation" }),
      includeFailed: true,
      removable: true,
    },
    {
      name: "inside the retention window nothing is removable",
      run: retiredRun({ updatedAt: INSIDE_RETENTION }),
      removable: false,
    },
    {
      name: "a running run is never removable",
      run: run({ updatedAt: PAST_RETENTION }),
      includeFailed: true,
      removable: false,
    },
    {
      name: "cancel_pending is not terminal",
      run: retiredRun({ status: "cancel_pending" }),
      includeFailed: true,
      removable: false,
    },
    {
      name: "a live lease holds a retired run",
      run: retiredRun({ lease: liveLease }),
      removable: false,
    },
    {
      name: "a stale lease does not hold it",
      run: retiredRun({ lease: staleLease }),
      removable: true,
    },
  ];

  for (const testCase of cases)
    assert.equal(
      isRemovableRun(testCase.run, testCase.includeFailed),
      testCase.removable,
      testCase.name,
    );
});

test("cleanup arguments accept one run ID and the two flags", () => {
  assert.deepEqual(parseCleanupArguments([]), {
    runId: undefined,
    apply: false,
    includeFailed: false,
  });
  assert.deepEqual(
    parseCleanupArguments(["run-id", "--apply", "--include-failed"]),
    { runId: "run-id", apply: true, includeFailed: true },
  );
  assert.throws(() => parseCleanupArguments(["--force"]), /Usage/);
  assert.throws(() => parseCleanupArguments(["one", "two"]), /Usage/);
});

test("cleanup previews without deleting and names both escapes", async () => {
  const removable = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const recent = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: INSIDE_RETENTION,
  });
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
  });
  const registry = await seedRegistry([removable, recent, failed]);

  const preview = await execCleanup(registry, []);

  assert.match(preview, /nothing was deleted/);
  assert.match(preview, new RegExp(removable.id));
  assert.doesNotMatch(preview, new RegExp(recent.id));
  assert.doesNotMatch(preview, new RegExp(failed.id));
  assert.match(
    preview,
    /worktree, branch, and progress file are left in place/,
  );
  assert.match(preview, /--include-failed/);
  assert.match(preview, /\/exec cleanup --apply/);
  assert.equal((await registry.list()).length, 3);
});

test("cleanup --apply removes only retired runs past retention", async () => {
  const removable = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const recent = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: INSIDE_RETENTION,
  });
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
  });
  const registry = await seedRegistry([removable, recent, failed]);

  const applied = await execCleanup(registry, ["--apply"]);

  assert.match(applied, /Removed 1 plan execution run;/);
  assert.match(applied, /left in place/);
  assert.deepEqual(
    (await registry.list()).map((entry) => entry.id).sort(),
    [recent.id, failed.id].sort(),
  );
});

test("cleanup includes failed runs only when asked", async () => {
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
  });
  const registry = await seedRegistry([failed]);

  const excluded = await execCleanup(registry, []);
  assert.match(excluded, /No plan execution runs are removable/);
  assert.match(excluded, /7 days/);

  const included = await execCleanup(registry, ["--include-failed"]);
  assert.match(included, new RegExp(failed.id));
  assert.doesNotMatch(included, /Failed runs are excluded/);

  await execCleanup(registry, ["--apply", "--include-failed"]);
  assert.deepEqual(await registry.list(), []);
});

test("cleanup with a run ID removes just that run and refuses live ones", async () => {
  const recent = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: INSIDE_RETENTION,
  });
  const removable = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const active = run({
    id: "66666666-6666-4666-8666-666666666666",
    updatedAt: PAST_RETENTION,
  });
  const held = retiredRun({
    id: "77777777-7777-4777-8777-777777777777",
    lease: {
      sessionId: "session-1",
      pid: process.pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });
  const registry = await seedRegistry([recent, removable, active, held]);

  const applied = await execCleanup(registry, [recent.id, "--apply"]);

  assert.match(applied, /Removed 1 plan execution run;/);
  assert.equal(await registry.get(recent.id), undefined);
  assert.ok(await registry.get(removable.id), "the sweep set is untouched");
  await assert.rejects(
    () => execCleanup(registry, [active.id, "--apply"]),
    /only a terminal run can be removed/,
  );
  await assert.rejects(
    () => execCleanup(registry, [held.id, "--apply"]),
    /held by a live lease/,
  );
  await assert.rejects(
    () => execCleanup(registry, ["88888888-8888-4888-8888-888888888888"]),
    /Plan execution run not found/,
  );
});

test("doctor argument parsing accepts only --reconcile", () => {
  assert.deepEqual(parseDoctorArguments([]), { reconcile: false });
  assert.deepEqual(parseDoctorArguments(["--reconcile"]), { reconcile: true });
  assert.throws(() => parseDoctorArguments(["--apply"]), /Usage/);
  assert.throws(() => parseDoctorArguments(["run-id"]), /Usage/);
});

test("doctor groups every in-flight claim and mutates nothing", async () => {
  const abandoned = abandonedRun();
  const ambiguous = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    activeOperation: {
      operationId: "operation-2",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-2",
    },
  });
  const live = abandonedRun({
    id: "33333333-3333-4333-8333-333333333333",
    lease: LIVE_LEASE,
  });
  const settled = retiredRun({ id: "44444444-4444-4444-8444-444444444444" });
  const { registry, directory } = await seedDirectory([
    abandoned,
    ambiguous,
    live,
    settled,
  ]);
  const before = await snapshotRuns(directory);

  const report = await execDoctor(registry, []);

  assert.match(report, /Plan execution runs: 4 \(3 claiming work in flight\)/);
  assert.match(
    report,
    new RegExp(
      `abandoned — no worker is running:\\n- ${abandoned.id} [^\\n]*operation directory is gone from disk\\. Next: /exec resume ${abandoned.id}`,
    ),
  );
  assert.match(
    report,
    new RegExp(
      `ambiguous[^\\n]*\\n- ${ambiguous.id} [^\\n]*could not be observed\\. Next: /exec status ${ambiguous.id}`,
    ),
  );
  assert.match(
    report,
    new RegExp(
      `live[^\\n]*\\n- ${live.id} [^\\n]*session ${LIVE_LEASE.sessionId} holds a live lease`,
    ),
  );
  assert.match(
    report,
    /1 older terminal run hidden\. \/exec status --all to show, \/exec cleanup to remove\./,
  );
  assert.deepEqual(
    await snapshotRuns(directory),
    before,
    "preview writes nothing",
  );
});

test("doctor --reconcile resets only provably abandoned runs", async () => {
  const abandoned = abandonedRun();
  const ambiguous = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    activeOperation: {
      operationId: "operation-2",
      service: "bridge",
      kind: "implementation",
    },
  });
  const live = abandonedRun({
    id: "33333333-3333-4333-8333-333333333333",
    lease: LIVE_LEASE,
  });
  const cancelling = abandonedRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "cancel_pending",
  });
  const { registry, directory } = await seedDirectory([
    abandoned,
    ambiguous,
    live,
    cancelling,
  ]);
  const before = await snapshotRuns(directory);

  const report = await execDoctor(registry, ["--reconcile"]);

  assert.match(report, /Reset 2 abandoned runs to failed\./);
  assert.match(report, /no task attempt was consumed/);
  assert.match(
    report,
    new RegExp(`- ${abandoned.id} [^\\n]*Next: /exec resume ${abandoned.id}`),
  );
  assert.match(
    report,
    new RegExp(`- ${cancelling.id} [^\\n]*Next: /exec stop ${cancelling.id}`),
  );

  const reset = await registry.get(abandoned.id);
  assert.equal(reset?.status, "failed");
  assert.equal(reset?.activeOperation, undefined);
  assert.deepEqual(reset?.taskAttempts, abandoned.taskAttempts);
  assert.ok(reset?.reconciledAt, "the reset is stamped for audit");
  assert.match(reset?.error ?? "", /lease was dead/);
  assert.match(reset?.error ?? "", /operation directory is gone from disk/);

  const after = await snapshotRuns(directory);
  assert.equal(
    after[ambiguous.id],
    before[ambiguous.id],
    "ambiguous untouched",
  );
  assert.equal(after[live.id], before[live.id], "live untouched");
});

test("doctor --reconcile skips a run reclaimed while the sweep ran", async () => {
  const reclaimed = abandonedRun();
  const stalled = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
  });
  const { registry } = await seedDirectory([reclaimed, stalled]);
  const probe: EvidenceProbe = async (candidate) => {
    if (candidate.id === reclaimed.id) {
      const current = await registry.get(candidate.id);
      await registry.update({ ...current!, lease: LIVE_LEASE });
    }
    return { asyncDirPresent: false };
  };

  const report = await execDoctor(registry, ["--reconcile"], probe);

  assert.match(report, /Reset 1 abandoned run to failed\./);
  assert.match(report, /Skipped 1 run reclaimed while the sweep ran/);
  assert.match(report, new RegExp(`- ${reclaimed.id} `));
  assert.equal((await registry.get(reclaimed.id))?.status, "running");
  assert.equal((await registry.get(reclaimed.id))?.reconciledAt, undefined);
  assert.equal((await registry.get(stalled.id))?.status, "failed");
});

test("a reconciled run is an ordinary recoverable failure", async () => {
  const abandoned = abandonedRun();
  const { registry } = await seedDirectory([abandoned]);

  await execDoctor(registry, ["--reconcile"]);
  const reconciled = await registry.get(abandoned.id);

  assert.ok(reconciled);
  assert.equal(isActionAllowed("resume", reconciled, "session-new"), true);
  assert.equal(isRecoverableFailure(reconciled), true);
  const guidance = recoveryGuidance(reconciled);
  assert.equal(guidance.classification, "stopped, and you can continue it");
  assert.match(guidance.action, new RegExp(`/exec resume ${abandoned.id}`));
  assert.deepEqual(reconciled.taskAttempts, { "1": 2 });
});

test("reconcile records the reset in the run's own progress file", async () => {
  const progressPath = join(
    await mkdtemp(join(tmpdir(), "pi-plan-exec-progress-")),
    "progress.txt",
  );
  const abandoned = abandonedRun({ progressPath });
  const { registry } = await seedDirectory([abandoned]);

  await execDoctor(registry, ["--reconcile"]);

  const progress = await readFile(progressPath, "utf8");
  assert.match(progress, /Reset by \/exec doctor/);
  assert.match(progress, /operation directory is gone from disk/);
  assert.match(progress, /task attempt counter was left unchanged/);
});

test("the bridge is asked only when the directory check was not decisive", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-"));
  const surviving = abandonedRun({
    activeOperation: {
      operationId: "operation-surviving",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const wiped = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
  });
  const fused = abandonedRun({
    id: "33333333-3333-4333-8333-333333333333",
    stage: "fusion_review",
    activeOperation: {
      operationId: "operation-fusion",
      service: "fusion",
      kind: "fusion",
      externalRunId: "external-3",
      asyncDir,
    },
  });
  const { registry } = await seedDirectory([surviving, wiped, fused]);
  const asked: string[] = [];

  const report = await execDoctor(
    registry,
    ["--reconcile"],
    abandonmentProbe(async (operationId) => {
      asked.push(operationId);
      return "absent";
    }),
  );

  assert.deepEqual(
    asked,
    ["operation-surviving"],
    "a gone directory is already decisive, and fusion has no bridge record",
  );
  assert.match(report, /Reset 2 abandoned runs to failed\./);
  assert.match(
    (await registry.get(surviving.id))?.error ?? "",
    /the bridge has no record of its operation/,
  );
  assert.equal((await registry.get(fused.id))?.status, "running");
});

test("a bridge that cannot answer is not evidence the worker is gone", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-"));
  const surviving = abandonedRun({
    activeOperation: {
      operationId: "operation-surviving",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const { registry } = await seedDirectory([surviving]);

  const report = await execDoctor(
    registry,
    ["--reconcile"],
    abandonmentProbe(() => Promise.reject(new Error("bridge is not loaded"))),
  );

  assert.match(report, /No run is provably abandoned, so nothing was reset\./);
  assert.equal((await registry.get(surviving.id))?.status, "running");
});

test("startup says one line about abandoned runs, or nothing", async () => {
  const { registry } = await seedDirectory([
    abandonedRun(),
    abandonedRun({ id: "22222222-2222-4222-8222-222222222222" }),
  ]);
  const { registry: quiet } = await seedDirectory([retiredRun()]);

  assert.equal(
    abandonedRunsNotice(await sweepAbandonment(registry)),
    "2 plan execution runs claim to be running with no worker. Use /exec status.",
  );
  assert.equal(abandonedRunsNotice(await sweepAbandonment(quiet)), undefined);

  const { registry: single } = await seedDirectory([abandonedRun()]);
  assert.match(
    abandonedRunsNotice(await sweepAbandonment(single)) ?? "",
    /^1 plan execution run claims to be running/,
  );
});

test("the startup sweep classifies without writing anything", async () => {
  const abandoned = abandonedRun();
  const live = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    lease: LIVE_LEASE,
  });
  const { registry, directory } = await seedDirectory([abandoned, live]);
  const before = await snapshotRuns(directory);

  const sweep = await sweepAbandonment(registry);

  assert.deepEqual(
    sweep.diagnoses.map((diagnosis) => diagnosis.classification).sort(),
    ["abandoned", "live"],
  );
  assert.deepEqual(await snapshotRuns(directory), before);
});

test("cleanup removes a run record the registry cannot parse", async () => {
  const corruptId = "99999999-9999-4999-8999-999999999999";
  const { registry, directory } = await seedDirectory([retiredRun()]);
  await mkdir(join(directory, corruptId), { recursive: true });
  await writeFile(join(directory, corruptId, "run.json"), "{not-json\n");

  const doctored = await execDoctor(registry, []);
  assert.match(
    doctored,
    new RegExp(
      `unreadable run records:\\n- ${corruptId} — [^\\n]*Next: /exec cleanup ${corruptId} --apply`,
    ),
  );

  const preview = await execCleanup(registry, [corruptId]);
  assert.match(preview, /nothing was deleted/);
  assert.ok(await registry.listWithErrors().then((it) => it.errors.length));

  const applied = await execCleanup(registry, [corruptId, "--apply"]);
  assert.match(applied, /Removed 1 unreadable plan execution run record/);
  assert.deepEqual((await registry.listWithErrors()).errors, []);
});

test("settled runs group by what they need and hide stale terminal rows", () => {
  const paused = run({
    id: "11111111-1111-4111-8111-111111111111",
    status: "paused",
    updatedAt: Date.now() - HOUR_MS,
  });
  const failed = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "failed",
    updatedAt: Date.now() - HOUR_MS,
  });
  // Retired an hour ago: the archive stamp does not hide a run, age does.
  const justArchived = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
    updatedAt: Date.now() - HOUR_MS,
    retiredAt: Date.now() - HOUR_MS,
  });
  const oldCompleted = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
  });
  const oldCancelled = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "cancelled",
  });
  const runs = [paused, failed, justArchived, oldCompleted, oldCancelled];

  const lines = settledRunLines(runs).join("\n");

  assert.match(
    lines,
    new RegExp(
      `waiting for you — no worker is running:\\n- ${paused.id} [^\\n]*Next: /exec resume ${paused.id}`,
    ),
  );
  assert.match(
    lines,
    new RegExp(`- ${failed.id} [^\\n]*/exec resume ${failed.id}`),
  );
  assert.match(
    lines,
    new RegExp(
      `finished:\\n- ${justArchived.id} [^\\n]*Next: /exec status ${justArchived.id}`,
    ),
  );
  assert.ok(!lines.includes(oldCompleted.id), "an old terminal run is hidden");
  assert.ok(!lines.includes(oldCancelled.id), "an old terminal run is hidden");
  assert.match(
    lines,
    /2 older terminal runs hidden\. \/exec status --all to show, \/exec cleanup to remove\./,
  );

  const all = settledRunLines(runs, true).join("\n");

  for (const shown of runs) assert.ok(all.includes(shown.id), shown.id);
  assert.doesNotMatch(all, /hidden/, "--all hides nothing, so no footer");
});

test("status answers what is going on in one pass", async () => {
  const abandoned = abandonedRun();
  const paused = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "paused",
    updatedAt: Date.now() - HOUR_MS,
  });
  const stale = retiredRun({ id: "33333333-3333-4333-8333-333333333333" });
  const registry = await seedRegistry([abandoned, paused, stale]);

  const report = await execStatus(registry);

  assert.match(report, /Plan execution runs: 3 \(1 claiming work in flight\)/);
  assert.match(
    report,
    new RegExp(
      `abandoned — no worker is running:\\n- ${abandoned.id} [^\\n]*Next: /exec resume ${abandoned.id}`,
    ),
  );
  assert.doesNotMatch(report, /--reconcile/, "the retired flag is not offered");
  assert.match(
    report,
    new RegExp(`- ${paused.id} [^\\n]*Next: /exec resume ${paused.id}`),
  );
  assert.ok(!report.includes(stale.id), "an old terminal run needs --all");
  assert.match(report, /1 older terminal run hidden\./);

  const zoomed = await execStatus(registry, { all: true });
  assert.ok(zoomed.includes(stale.id), "--all is the zoom control");
  assert.doesNotMatch(zoomed, /hidden/);
});

test("status reports a missing package with its install commands", async () => {
  const registry = await seedRegistry([]);

  const report = await execStatus(registry, {
    problems: ["missing: pi-subagents"],
  });

  assert.match(report, /Plan-exec prerequisites — missing: pi-subagents\./);
  assert.match(report, /^pi install npm:pi-subagents$/m);
  assert.match(report, /No plan execution runs\. Start one with \/exec\./);
  assert.equal(
    await execStatus(registry),
    "No plan execution runs. Start one with /exec.",
  );
});

test("status arguments take one run ID or the --all zoom, never both", () => {
  assert.deepEqual(parseStatusArguments([]), {
    selector: undefined,
    all: false,
  });
  assert.deepEqual(parseStatusArguments(["run-id"]), {
    selector: "run-id",
    all: false,
  });
  assert.deepEqual(parseStatusArguments(["--all"]), {
    selector: undefined,
    all: true,
  });
  assert.throws(
    () => parseStatusArguments(["run-id", "--all"]),
    /cannot be combined/,
  );
  assert.throws(
    () => parseStatusArguments(["--reconcile"]),
    /\/exec status never writes\. \/exec resume <run-id> resets/,
  );
  assert.throws(() => parseStatusArguments(["one", "two"]), /Usage/);
});

test("the retired read verbs still work and name their replacement", async () => {
  const abandoned = abandonedRun();
  const stale = retiredRun({ id: "33333333-3333-4333-8333-333333333333" });
  const registry = await seedRegistry([abandoned, stale]);

  const runs = await execRead(registry, "runs", []);
  assert.match(runs ?? "", /Plan execution runs: 2/);
  assert.match(runs ?? "", new RegExp(`- ${abandoned.id} `));
  assert.equal(
    (runs?.match(/\/exec runs is now \/exec status/g) ?? []).length,
    1,
    "the replacement is named once",
  );

  const zoomed = await execRead(registry, "runs", ["--all"]);
  assert.ok(zoomed?.includes(stale.id), "--all still zooms through the alias");

  const doctor = await execRead(registry, "doctor", []);
  assert.match(doctor ?? "", new RegExp(`- ${abandoned.id} `));
  assert.match(doctor ?? "", /\/exec doctor is now \/exec status/);

  const setup = await execRead(registry, "setup", []);
  assert.match(setup ?? "", /^pi install npm:pi-subagents$/m);
  assert.match(setup ?? "", /\/exec setup is now part of \/exec status/);

  assert.equal(await execRead(registry, "resume", []), undefined);
  assert.equal(await execRead(registry, "status", ["run-id"]), undefined);
});

test("the doctor alias keeps --reconcile for scripted callers", async () => {
  const abandoned = abandonedRun();
  const registry = await seedRegistry([abandoned]);

  const report = await execRead(registry, "doctor", ["--reconcile"]);

  assert.match(report ?? "", /Reset 1 abandoned run to failed\./);
  assert.match(report ?? "", /still works for scripted callers/);
  assert.equal((await registry.get(abandoned.id))?.status, "failed");
});

test("the start subcommand is gone", () => {
  assert.ok(
    !(Object.values(EXEC_ACTION) as string[]).includes("start"),
    "start is not a subcommand",
  );
  assert.doesNotMatch(execHelp(), /\/exec start/);
  assert.equal(
    (getExecArgumentCompletions("") ?? []).find(
      (item) => item.value === "start",
    ),
    undefined,
  );
});

test("the exec-plan skill documents exactly the subcommands /exec implements", async () => {
  const skill = fileURLToPath(new URL("../skills/exec-plan/", import.meta.url));
  const prose = (
    await Promise.all([
      readFile(join(skill, "SKILL.md"), "utf8"),
      readFile(join(skill, "references", "recovery.md"), "utf8"),
    ])
  ).join("\n");
  // A subcommand token must start with a letter, so `--all`, `--apply`,
  // `--reconcile`, and `--include-failed` are flags and never match.
  const documented = new Set(
    [...prose.matchAll(/(?<![-\w])\/exec[ \t]+(?<subcommand>[a-z][a-z-]*)/g)]
      .map((match) => match.groups?.subcommand)
      .filter((token): token is string => Boolean(token)),
  );
  const actions = new Set<string>(Object.values(EXEC_ACTION));
  const aliases = new Set<string>(EXEC_ALIAS_ACTIONS);

  assert.ok(documented.size > 0, "no /exec subcommand was found in the skill");
  for (const token of documented)
    assert.ok(actions.has(token), `skill documents unknown: /exec ${token}`);
  // A hidden alias may appear in the skill but is never required there: it is
  // absent from /exec help and exists only so an in-flight run keeps working.
  for (const action of actions)
    if (!aliases.has(action))
      assert.ok(
        documented.has(action),
        `skill never documents: /exec ${action}`,
      );
});

test("resume takes over a lease whose session is provably gone", () => {
  const stranded = run({ status: "skip_pending", lease: DEAD_LEASE });
  assert.equal(isActionAllowed("resume", stranded, "session-new"), true);

  const held = run({ status: "skip_pending", lease: LIVE_LEASE });
  assert.equal(isActionAllowed("resume", held, "session-new"), false);

  // Own lease, no lease, and terminal keep answering as they did.
  const mine = run({ status: "skip_pending", lease: LIVE_LEASE });
  assert.equal(isActionAllowed("resume", mine, LIVE_LEASE.sessionId), false);
  const unheld = run({ status: "skip_pending" });
  assert.equal(isActionAllowed("resume", unheld, "session-new"), false);
  const done = run({ status: "completed", stage: "complete" });
  assert.equal(isActionAllowed("resume", done, "session-new"), false);
});

test("a live foreign lease still blocks a second worker", async () => {
  const held = run({ status: "running", lease: LIVE_LEASE });
  const registry = await seedRegistry([held]);

  // Resume is reachable by status, and the claim is what refuses it.
  assert.equal(isActionAllowed("resume", held, "session-new"), true);
  await assert.rejects(
    registry.claim(held, "session-new"),
    /controlled by another active Pi session/,
  );
});

test("the retired adopt verb runs resume and names it once", () => {
  assert.deepEqual(runActionFor("adopt"), {
    action: "resume",
    note: "/exec adopt is now /exec resume; the old name still works.",
  });
  assert.deepEqual(runActionFor("resume"), { action: "resume" });
  assert.deepEqual(runActionFor("skip"), { action: "skip" });
  assert.equal(runActionFor("status"), undefined);
  assert.equal(runActionFor("cleanup"), undefined);
  assert.equal(runActionFor(undefined), undefined);
  assert.ok(
    (EXEC_ALIAS_ACTIONS as readonly string[]).includes(EXEC_ACTION.ADOPT),
    "adopt is a hidden alias",
  );
});

test("help drops both interactive flags but keeps them working", () => {
  const help = execHelp();
  assert.doesNotMatch(help, /--adopt-current-branch/);
  assert.doesNotMatch(help, /--retry-task/);
  assert.match(help, /--model current\|provider\/model/);
  // Both flags stay parseable for a caller with no human to ask.
  assert.deepEqual(
    parseResumeOptions(["--adopt-current-branch", "--retry-task"]),
    { adoptCurrentBranch: true, retryTask: true, model: undefined },
  );
});

test("resume reconciles a provably abandoned run, then continues", async () => {
  const progressPath = join(
    await mkdtemp(join(tmpdir(), "pi-plan-exec-resume-")),
    "progress.txt",
  );
  const abandoned = abandonedRun({ progressPath });
  const registry = await seedRegistry([abandoned]);

  const recovered = await reconcileForResume(
    registry,
    abandoned,
    "session-new",
  );

  assert.equal(recovered.run.status, "failed");
  assert.equal(recovered.run.activeOperation, undefined);
  assert.deepEqual(recovered.run.taskAttempts, abandoned.taskAttempts);
  assert.ok(recovered.run.reconciledAt, "the reset is stamped for audit");
  assert.match(recovered.note ?? "", /was abandoned/);
  assert.match(recovered.note ?? "", /No task attempt was consumed/);
  assert.match(
    (await registry.get(abandoned.id))?.error ?? "",
    /Reset by \/exec resume/,
  );
  assert.match(
    await readFile(progressPath, "utf8"),
    /Reset by \/exec resume[\s\S]*attempt counter was left unchanged/,
  );
  // The reset lands on the state the ordinary resume path already recovers.
  assert.equal(isRecoverableFailure(recovered.run), true);
  assert.equal(
    isActionAllowed("resume", recovered.run, "session-new"),
    true,
    "the reconciled run is resumable",
  );
});

test("resume refuses a run whose worker cannot be proven gone", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-live-"));
  const ambiguous = abandonedRun({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const { registry, directory } = await seedDirectory([ambiguous]);
  const before = await snapshotRuns(directory);

  await assert.rejects(
    reconcileForResume(registry, ambiguous, "session-new"),
    /evidence is incomplete[\s\S]*could add a second writer[\s\S]*\/exec status/,
  );
  assert.deepEqual(
    await snapshotRuns(directory),
    before,
    "an ambiguous run is reported, never reset",
  );
});

test("resume passes through what it has no evidence against", async () => {
  const registry = await seedRegistry([]);
  const untracked = run({ status: "running", lease: DEAD_LEASE });
  delete untracked.activeOperation;
  const own = abandonedRun({ lease: LIVE_LEASE });
  const cancelling = abandonedRun({ status: "cancel_pending" });
  const failed = abandonedRun({ status: "failed" });

  for (const [label, candidate] of [
    ["nothing tracked, so nothing can double-write", untracked],
    ["a live lease holds it", own],
    ["cancellation must survive, not be reset", cancelling],
    ["resume already recovers a failure", failed],
  ] as const) {
    const recovered = await reconcileForResume(
      registry,
      candidate,
      LIVE_LEASE.sessionId,
    );
    assert.equal(recovered.run, candidate, label);
    assert.equal(recovered.note, undefined, label);
  }
});

test("resume skips a run reclaimed while it was being diagnosed", async () => {
  const abandoned = abandonedRun();
  const registry = await seedRegistry([abandoned]);
  const probe: EvidenceProbe = async () => {
    const current = await registry.get(abandoned.id);
    await registry.update({ ...current!, lease: LIVE_LEASE });
    return { asyncDirPresent: false };
  };

  await assert.rejects(
    reconcileForResume(registry, abandoned, "session-new", probe),
    /reclaimed while it was being diagnosed/,
  );
  assert.equal((await registry.get(abandoned.id))?.status, "running");
  assert.equal((await registry.get(abandoned.id))?.reconciledAt, undefined);
});

test("every run whose guidance names resume survives the resume gate", async () => {
  const registry = await seedRegistry([]);
  const shapes: PlanExecRun[] = [
    run({ status: "paused", stage: "comprehensive_review" }),
    run({ status: "failed", error: "worker crashed" }),
    run({ status: "cancel_pending" }),
    run({ status: "running", lease: DEAD_LEASE }),
    abandonedRun(),
  ];

  for (const shape of shapes) {
    const guidance = recoveryGuidance(shape);
    if (!guidance.action.includes(`/exec resume ${shape.id}`)) continue;
    await assert.doesNotReject(
      reconcileForResume(registry, shape, "session-new"),
      `guidance recommends resume but the gate refuses it: ${guidance.classification}`,
    );
  }
  // The pairing only proves something if both branches are exercised.
  const stranded = run({ status: "running", lease: DEAD_LEASE });
  delete stranded.activeOperation;
  assert.equal(
    recoveryGuidance(stranded).classification,
    "someone else's session was holding this run, and it is gone",
  );
  assert.match(
    recoveryGuidance(abandonedRun({ id: stranded.id })).action,
    /Wait and use \/exec status/,
  );
});

test("status counts a hidden-only registry instead of reporting an empty one", async () => {
  const registry = await seedRegistry([retiredRun()]);

  const report = await execStatus(registry);

  assert.match(report, /^Plan execution runs: 1$/m);
  assert.doesNotMatch(report, /claiming work in flight/);
  assert.match(report, /1 older terminal run hidden\./);
});

test("stop reaches both outcomes and asks for the one it takes", async () => {
  const running = run({ status: "running" });
  const asked: Array<{ title: string; options: string[] }> = [];
  const pick = (index: number) => ({
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        asked.push({ title, options });
        return options[index];
      },
    },
  });

  assert.equal(
    await chooseStopOutcome(running, pick(0), "session-1"),
    EXEC_ACTION.PAUSE,
  );
  assert.equal(
    await chooseStopOutcome(running, pick(1), "session-1"),
    EXEC_ACTION.CANCEL,
  );
  assert.equal(asked.length, 2, "each stop asks before it acts");
  assert.match(asked[0]!.title, new RegExp(running.id.slice(0, 8)));
  // Reversibility is what the two differ by, so it is what the labels say.
  assert.match(asked[0]!.options[0]!, /^Pause — .*\/exec resume continues/);
  assert.match(asked[0]!.options[1]!, /^Cancel — final.*worktree is preserved/);

  // A cancelled dialog stops at the dialog.
  await assert.rejects(
    chooseStopOutcome(
      running,
      {
        hasUI: true,
        ui: { select: async () => undefined },
      },
      "session-1",
    ),
    /Stop cancelled\./,
  );
});

test("stop offers only the outcomes a run can still take, and still asks", async () => {
  const paused = run({ status: "paused", stage: "comprehensive_review" });
  let offered: string[] = [];

  const outcome = await chooseStopOutcome(
    paused,
    {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          offered = options;
          return options[0];
        },
      },
    },
    "session-1",
  );

  assert.equal(
    outcome,
    EXEC_ACTION.CANCEL,
    "a paused run has nothing to pause",
  );
  assert.equal(offered.length, 1);
  // One option is still a question: a final cancel is never assumed.
  assert.match(offered[0]!, /^Cancel — final/);
  assert.equal(isActionAllowed("stop", paused, "session-1"), true);
  assert.equal(
    isActionAllowed(
      "stop",
      run({ status: "completed", stage: "complete" }),
      "session-1",
    ),
    false,
  );
});

test("stop refuses without a human and names both scripted verbs", async () => {
  await assert.rejects(
    chooseStopOutcome(
      run({ status: "running" }),
      { hasUI: false, ui: { select: async () => "Pause" } },
      "session-1",
    ),
    (error: Error) => {
      assert.match(error.message, /\/exec pause <run-id>/);
      assert.match(error.message, /\/exec cancel <run-id>/);
      assert.match(error.message, /resumable/);
      assert.match(error.message, /for good/);
      return true;
    },
  );
});

test("the retired pause and cancel verbs still work and name their replacement", () => {
  assert.deepEqual(runActionFor("stop"), { action: "stop" });
  assert.deepEqual(runActionFor("pause"), {
    action: "pause",
    note: "/exec pause is now /exec stop; the old name still works and is the way to pause without a human to ask.",
  });
  assert.deepEqual(runActionFor("cancel"), {
    action: "cancel",
    note: "/exec cancel is now /exec stop; the old name still works and is the way to cancel without a human to ask.",
  });
  for (const alias of ["pause", "cancel"])
    assert.ok(
      (EXEC_ALIAS_ACTIONS as readonly string[]).includes(alias),
      `${alias} is a hidden alias`,
    );
  assert.match(execHelp(), /\/exec stop \[run-id\]/);
  assert.ok(
    (getExecArgumentCompletions("") ?? []).some(
      (item) => item.value === "stop",
    ),
    "stop completes",
  );
});

test("status hands a blocked stage its skip command with the run ID filled in", async () => {
  const blocked = run({
    status: "failed",
    stage: "critical_review",
    error: "reviewer could not pass the stage",
    updatedAt: Date.now() - HOUR_MS,
  });
  delete blocked.activeOperation;
  const implementing = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "paused",
    stage: "implementation",
    updatedAt: Date.now() - HOUR_MS,
  });
  const registry = await seedRegistry([blocked, implementing]);

  const report = (await execRead(registry, "status", [])) ?? "";

  // The row keeps its single next command; the waiver is the line under it.
  assert.match(
    report,
    new RegExp(
      `- ${blocked.id} [^\\n]*Next: /exec resume ${blocked.id}\\n  If critical_review cannot pass, waive it: /exec skip ${blocked.id} --reason <why the residual risk is accepted>`,
    ),
  );
  // Implementation is never skippable, so nothing offers a waiver for it.
  assert.doesNotMatch(report, new RegExp(`/exec skip ${implementing.id}`));
  assert.equal(isStageWaiverAvailable(blocked), true);
  assert.equal(isStageWaiverAvailable(implementing), false);
});
