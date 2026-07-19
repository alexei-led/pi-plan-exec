import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  execHelp,
  execSetup,
  formatRunList,
  formatRunStatus,
  getExecArgumentCompletions,
  hasBridgeOperationMethod,
  isActionAllowed,
  isRecoverableFailure,
  missingRuntimeTools,
  needsPlanStructureReview,
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

test("bridge runtime compatibility requires the operation lookup method", () => {
  assert.equal(
    hasBridgeOperationMethod({ methods: ["ping", "operation"] }),
    true,
  );
  assert.equal(hasBridgeOperationMethod({ methods: ["ping", "spawn"] }), false);
  assert.equal(hasBridgeOperationMethod({ methods: "operation" }), false);
  assert.equal(hasBridgeOperationMethod(undefined), false);
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
    /retry a failed run/,
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
  assert.match(execHelp(), /retry a failed run/);
  assert.match(execHelp(), /\/exec skip <full-run-id> --reason <text>/);
  assert.match(execHelp(), /completed_with_findings/);
  assert.match(execHelp(), /\/skill:exec-plan/);
  assert.match(
    execSetup(),
    /pi install npm:@alexeiled\/pi-subagents-bridge@\^0\.2\.0/,
  );
  assert.match(execSetup(), /pi install npm:@alexeiled\/pi-fusion/);
  assert.match(execSetup(), /pi install npm:@alexeiled\/pi-plan-exec/);
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

test("resume branch-adoption option is explicit", () => {
  assert.deepEqual(parseResumeOptions([]), {
    adoptCurrentBranch: false,
    retryTask: false,
  });
  assert.deepEqual(parseResumeOptions(["--adopt-current-branch"]), {
    adoptCurrentBranch: true,
    retryTask: false,
  });
  assert.deepEqual(parseResumeOptions(["--retry-task"]), {
    adoptCurrentBranch: false,
    retryTask: true,
  });
  assert.deepEqual(
    parseResumeOptions(["--adopt-current-branch", "--retry-task"]),
    { adoptCurrentBranch: true, retryTask: true },
  );
  assert.throws(() => parseResumeOptions(["--force"]), /Usage/);

  const running = run({ status: "running" });
  delete running.activeOperation;
  assert.equal(isActionAllowed("resume", running, "session-1"), false);
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

  const staleOwner = formatRunStatus(
    run({
      status: "failed",
      lease: { sessionId: "old-session", pid: 1, heartbeatAt: 0 },
    }),
  );
  assert.match(staleOwner, /owner: stale lease/);
  assert.match(staleOwner, /\/exec adopt/);

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
  assert.match(resumed, /resumed: running/);
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
  assert.match(formatRunStatus(failedWorker), /retry this stage/);

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

test("run list tells users how to inspect an unambiguous run", () => {
  const list = formatRunList([run()]);
  assert.match(list, /example\.md running\/implementation/);
  assert.match(list, /\/exec status/);
});
