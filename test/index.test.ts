import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunRegistry } from "../src/registry.js";
import {
  execCleanup,
  execHelp,
  execSetup,
  isRemovableRun,
  parseCleanupArguments,
  formatRunList,
  formatRunStatus,
  getExecArgumentCompletions,
  hasBridgeOperationMethod,
  hasBridgeWorkflowScriptSpawnCapability,
  isActionAllowed,
  isRecoverableFailure,
  missingRuntimeTools,
  needsPlanStructureReview,
  parseResumeArguments,
  parseResumeOptions,
  parseSkipReason,
  resumeResultMessage,
  prioritizeRunCandidates,
  reviewedPlanHashForResume,
} from "../src/index.js";
import type { PlanExecRun } from "../src/types.js";

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

/** Every cleanup test writes into its own temp directory, never ~/.pi. */
async function seedRegistry(runs: PlanExecRun[]): Promise<RunRegistry> {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-cleanup-"));
  for (const seed of runs) {
    await mkdir(join(directory, seed.id), { recursive: true });
    await writeFile(
      join(directory, seed.id, "run.json"),
      `${JSON.stringify(seed)}\n`,
      "utf8",
    );
  }
  return new RunRegistry(directory);
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
    ["start", "status"],
  );
  assert.match(items?.[0]?.description ?? "", /Start a plan/);
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
  assert.match(execHelp(), /Reconcile, resume, or retry safely/);
  assert.match(execHelp(), /\/exec skip <full-run-id> --reason <text>/);
  assert.match(execHelp(), /--model current\|provider\/model/);
  assert.match(execHelp(), /completed_with_findings/);
  assert.match(execHelp(), /\/exec cleanup \[full-run-id\]/);
  assert.match(execHelp(), /registry entries only/);
  assert.match(execHelp(), /\/skill:exec-plan/);
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
  assert.match(active, /recovery: healthy active operation/);
  assert.match(active, /next safe action: wait/);
  assert.match(active, /do not resume/);

  const failedRun = run({
    status: "failed",
    error: "worker crashed before launch",
  });
  delete failedRun.activeOperation;
  const failed = formatRunStatus(failedRun);
  assert.match(failed, /recovery: failed with no active operation/);
  assert.match(failed, /resume .* retries the same stage/);

  const blockedRun = run({
    status: "failed",
    taskAttempts: { "1": 2 },
    error: "Task 1 exhausted its retry limit. Provider billing unavailable.",
  });
  delete blockedRun.activeOperation;
  const blocked = formatRunStatus(blockedRun);
  assert.match(blocked, /recovery: external\/manual blocker/);
  assert.match(blocked, /--retry-task/);
  assert.match(blocked, /cannot bypass an incomplete implementation task/);

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
  assert.match(modelFailure, /recovery: model\/provider failure/);
  assert.match(
    modelFailure,
    /Use \/exec resume .*current authenticated Pi model/,
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
  assert.match(unknown, /recovery: preserved unknown operation/);
  assert.match(unknown, /never launch a replacement worker/);

  const pausedRun = run({ status: "paused", stage: "comprehensive_review" });
  delete pausedRun.activeOperation;
  const paused = formatRunStatus(pausedRun);
  assert.match(paused, /recovery: paused review/);
  assert.match(paused, /resume .* applies the paused stage/);

  const cancellingRun = run({ status: "cancel_pending" });
  delete cancellingRun.activeOperation;
  const cancelling = formatRunStatus(cancellingRun);
  assert.match(cancelling, /recovery: cancel-pending/);
  assert.match(cancelling, /resume .* retries cancellation only/);

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
  assert.equal(isActionAllowed("adopt", staleOwnerRun, "session-1"), false);

  const branchMismatch = formatRunStatus(
    run({
      status: "failed",
      error: "Execution directory is on feature/current, expected master.",
    }),
  );
  assert.match(branchMismatch, /recovery: execution-branch mismatch/);
  assert.match(branchMismatch, /--adopt-current-branch/);

  const planMismatch = formatRunStatus(
    run({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(planMismatch, /recovery: plan-structure review required/);
  assert.match(planMismatch, /first resume only records this pause/);

  const terminal = formatRunStatus(
    run({ status: "completed", stage: "complete" }),
  );
  assert.match(terminal, /recovery: terminal/);
  assert.match(terminal, /no recovery action/);
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
  assert.match(status, /preserved worktree/);

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

test("status prefers a live isolated run over a failed current-checkout run", () => {
  const failedInPlace = run({
    id: "11111111-1111-4111-8111-111111111111",
    status: "failed",
    worktreeCwd: "/repo",
  });
  const activeIsolated = run({
    id: "22222222-2222-4222-8222-222222222222",
    worktreeCwd: "/tmp/execution-worktree",
  });

  assert.deepEqual(
    prioritizeRunCandidates([failedInPlace, activeIsolated], "/repo", true).map(
      (candidate) => candidate.id,
    ),
    [activeIsolated.id],
  );
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

test("run list tells users how to inspect an unambiguous run", () => {
  const list = formatRunList([run()]);
  assert.match(list, /example\.md running\/implementation/);
  assert.match(list, /\/exec status/);
  assert.doesNotMatch(list, /hidden/, "nothing hidden means no footer");
});

test("run list hides older terminal runs behind --all", () => {
  const active = run();
  // Retired an hour ago: the archive stamp does not hide a run, age does.
  const justArchived = retiredRun({
    id: "22222222-2222-4222-8222-222222222222",
    updatedAt: Date.now() - HOUR_MS,
    retiredAt: Date.now() - HOUR_MS,
  });
  const oldCompleted = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const oldCancelled = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    status: "cancelled",
  });
  const runs = [active, justArchived, oldCompleted, oldCancelled];

  const listed = formatRunList(runs);

  assert.ok(listed.includes(active.id), "an active run always lists");
  assert.ok(listed.includes(justArchived.id), "a fresh terminal run lists");
  assert.ok(!listed.includes(oldCompleted.id), "an old terminal run is hidden");
  assert.ok(!listed.includes(oldCancelled.id), "an old terminal run is hidden");
  assert.match(
    listed,
    /2 older terminal runs hidden\. \/exec runs --all to show, \/exec cleanup to remove\./,
  );

  const all = formatRunList(runs, true);

  for (const shown of runs) assert.ok(all.includes(shown.id), shown.id);
  assert.doesNotMatch(all, /hidden/, "--all hides nothing, so no footer");
});

test("run list reports a hidden-only registry instead of an empty one", () => {
  const listed = formatRunList([retiredRun()]);

  assert.match(listed, /^No recent plan execution runs\./);
  assert.match(listed, /1 older terminal run hidden\./);
  assert.equal(
    formatRunList([]),
    "No plan execution runs. Start one with /exec.",
  );
});
