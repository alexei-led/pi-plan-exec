import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PLAN_STRUCTURE_CHANGED_ERROR,
  PlanExecController,
} from "../src/controller.js";
import { parsePlan } from "../src/plan.js";
import { RunRegistry } from "../src/registry.js";
import type { BridgeResult, PlanExecRun } from "../src/types.js";

const success = (data: Record<string, unknown>) => ({
  success: true as const,
  data,
});

test("in-place execution on the default branch keeps that branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const controller = new PlanExecController(
    new RunRegistry(join(root, "runs")),
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root, "main"),
  );

  const run = await controller.start({
    cwd: root,
    planPath,
    useWorktree: false,
    sessionId: "session-1",
  });

  assert.equal(run.branch, "main");
  assert.equal(run.worktreeCwd, root);
  assert.equal(run.stage, "project_tasks");
});

test("controller advances checkbox-complete implementation into review stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const reviewPath = join(root, "review-result.json");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  await writeFile(reviewPath, JSON.stringify({ output: "NO_FINDINGS" }));
  const bridge = new FakeBridge(reviewPath);
  const controller = new PlanExecController(
    new RunRegistry(join(root, "runs")),
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );

  let run = await controller.start({
    cwd: root,
    planPath,
    useWorktree: false,
    sessionId: "session-1",
  });
  assert.equal(run.stage, "project_tasks");
  run = await controller.advance(run);
  run = await controller.advance(run);
  run = await controller.advance(run);
  assert.equal(run.stage, "implementation");
  run = await controller.advance(run);
  assert.equal(run.activeOperation?.kind, "implementation");

  await writeFile(planPath, "### Task 1: Implement\n- [x] Do the work\n");
  run = await controller.advance(run);
  assert.equal(run.stage, "comprehensive_review");
  assert.equal(run.activeOperation, undefined);

  run = await controller.advance(run);
  assert.equal(run.activeOperation?.kind, "review");
  run = await controller.advance(run);
  assert.equal(run.stage, "smells_review");
  assert.equal(run.reviewFindings.length, 0);
});

test("plan structure drift pauses for review and resumes after repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const original = `### Task 1: Implement
- [ ] Do the work
`;
  await writeFile(planPath, original);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, original).hash,
    stage: "implementation",
  });

  await writeFile(
    planPath,
    `### Task 1: Implement
- [ ] Changed text
`,
  );
  const paused = await controller.advance(run);
  assert.equal(paused.status, "paused");
  assert.equal(paused.error, PLAN_STRUCTURE_CHANGED_ERROR);

  await writeFile(planPath, original);
  const resumed = await controller.resume(paused.id, "session-1");
  assert.equal(resumed.status, "running");
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.activeOperation?.kind, "implementation");
});

test("explicit resume retries a worker after its task retry limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "implementation",
    taskAttempts: { "1": 2 },
    error: "Worker run-2 ended as failed and left task 1 checkboxes unchecked.",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.taskAttempts["1"], 0);
  assert.equal(resumed.config.workerMaxTurns, 75);
  assert.equal(resumed.activeOperation?.kind, "implementation");
});

test("resume retries a failed review in the same stage with a larger review budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "comprehensive_review",
    error: "Review operation ended as failed.",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.stage, "comprehensive_review");
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.config.reviewerMaxTurns, 75);
  assert.equal(resumed.activeOperation?.kind, "review");
  assert.equal(resumed.worktreeCwd, failed.worktreeCwd);
  assert.equal(resumed.branch, failed.branch);
  assert.deepEqual(resumed.activeOperation?.params?.turnBudget, {
    maxTurns: 75,
  });
});

test("resume does not adopt a fixer launched during the same recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new StartupRaceBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "comprehensive_review",
    stageAttempts: { comprehensive_review: 1 },
    reviewFindings: [
      { id: "major-1", severity: "MAJOR", summary: "Verify this defect" },
    ],
    failedOperation: {
      operationId: "failed-fix",
      service: "bridge",
      kind: "fix",
      reviewIteration: 1,
    },
    error: "Fix operation ended as failed.",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.activeOperation?.kind, "fix");
  assert.equal(resumed.activeOperation?.externalRunId, "run-1");
  assert.equal(resumed.activeOperation?.params?.completionGuard, false);
  assert.equal(bridge.spawnCount, 1);
  assert.equal(bridge.adoptCount, 0);
});

test("resume reconciles a preserved fixer instead of spawning a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new RunningBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "comprehensive_review",
    reviewFindings: [
      { id: "major-1", severity: "MAJOR", summary: "Verify this defect" },
    ],
    activeOperation: {
      operationId: "preserved-fix",
      service: "bridge",
      kind: "fix",
      externalRunId: "existing-run",
      asyncDir: "/tmp/existing-run",
      reviewIteration: 4,
    },
    failedOperation: {
      operationId: "preserved-fix",
      service: "bridge",
      kind: "fix",
      externalRunId: "existing-run",
      asyncDir: "/tmp/existing-run",
      reviewIteration: 4,
    },
    error: "Unable to adopt bridge operation: Status file not found.",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.activeOperation?.operationId, "preserved-fix");
  assert.equal(resumed.activeOperation?.externalRunId, "existing-run");
  assert.equal(bridge.spawnCount, 0);
});

test("resume keeps a preserved fixer recoverable when adoption is not ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new AdoptionNotReadyBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "comprehensive_review",
    activeOperation: {
      operationId: "preserved-fix",
      service: "bridge",
      kind: "fix",
      externalRunId: "existing-run",
      asyncDir: "/tmp/existing-run",
      reviewIteration: 1,
    },
    error: "Unable to observe bridge/fix (3/3): unavailable",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.activeOperation?.operationId, "preserved-fix");
  assert.equal(resumed.activeOperation?.statusFailures, 2);
  assert.match(resumed.activeOperation?.lastStatusError ?? "", /Status file not found/);
  assert.equal(bridge.spawnCount, 0);
});

test("resume retries a failed one-pass review fixer instead of skipping the capped stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new RunningBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "critical_review",
    stageAttempts: { critical_review: 1 },
    reviewFindings: [
      {
        id: "major-1",
        severity: "MAJOR",
        summary: "Fix this defect",
      },
    ],
    error: "Fix operation ended as failed.",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.stage, "critical_review");
  assert.equal(resumed.activeOperation?.kind, "fix");
  assert.equal(resumed.activeOperation?.reviewIteration, 1);
  assert.match(
    String(resumed.activeOperation?.params?.task),
    /FINDING: MAJOR \| Fix this defect/,
  );
});

test("legacy structure failure adopts reviewed hash after claiming the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const current = `### Task 1: Implement
- [ ] Changed text
`;
  await writeFile(planPath, current);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: "old-hash",
    status: "failed",
    stage: "implementation",
    error: PLAN_STRUCTURE_CHANGED_ERROR,
  });
  const reviewedHash = parsePlan(planPath, current).hash;

  const resumed = await controller.resume(
    failed.id,
    "session-1",
    true,
    reviewedHash,
  );

  assert.equal(resumed.status, "running");
  assert.equal(resumed.planHash, reviewedHash);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.activeOperation?.kind, "implementation");
});

test("failed claim does not persist a reviewed plan hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Changed text\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: "old-hash",
    status: "failed",
    stage: "implementation",
    error: PLAN_STRUCTURE_CHANGED_ERROR,
    lease: {
      sessionId: "session-1",
      pid: 123,
      heartbeatAt: Date.now(),
    },
  });

  await assert.rejects(
    controller.resume(failed.id, "session-2", true, "reviewed-hash"),
    /controlled by another active Pi session/,
  );
  const stored = await registry.get(failed.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.planHash, "old-hash");
  assert.equal(stored?.error, PLAN_STRUCTURE_CHANGED_ERROR);
});

test("same-session concurrent resumes launch one operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new RunningBridge(join(root, "none.json"));
  const first = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const second = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const paused = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "paused",
    stage: "implementation",
  });

  await Promise.all([
    first.resume(paused.id, "session-1"),
    second.resume(paused.id, "session-1"),
  ]);

  assert.equal(bridge.spawnCount, 1);
  assert.equal(
    (await registry.get(paused.id))?.activeOperation?.externalRunId,
    "run-1",
  );
});

test("controller cancels a stopped review without advancing later stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create(baseRun(root, planPath));
  const cancelling: PlanExecRun = {
    ...run,
    status: "cancel_pending",
    stage: "comprehensive_review",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "review",
      externalRunId: "run-1",
      asyncDir: "/tmp/async",
    },
  };

  const requested = await controller.advance(cancelling);
  assert.equal(requested.activeOperation?.stopRequested, true);
  const cancelled = await controller.advance(requested);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stage, "comprehensive_review");
  assert.equal(cancelled.activeOperation, undefined);
});

test("paused runs retain a terminal child until resume applies its completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "paused",
    stage: "implementation",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "run-1",
      taskId: 1,
    },
  });
  const paused = await controller.advance(run);
  assert.equal(paused.status, "paused");
  assert.equal(paused.activeOperation?.operationId, "operation-1");
  assert.equal(paused.stage, "implementation");
  const resumed = await controller.resume(paused.id, "session-1");
  assert.equal(resumed.stage, "implementation");
  assert.equal(resumed.activeOperation?.kind, "implementation");
});

test("controller fails after repeated status-observation errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new UnavailableBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  let run = await registry.create({
    ...baseRun(root, planPath),
    stage: "implementation",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "run-1",
      taskId: 1,
    },
  });

  run = await controller.advance(run);
  assert.equal(run.activeOperation?.statusFailures, 1);
  assert.match(run.activeOperation?.lastStatusError ?? "", /unavailable/);
  run = await controller.advance(run);
  assert.equal(run.activeOperation?.statusFailures, 2);
  run = await controller.advance(run);
  assert.equal(run.status, "failed");
  assert.equal(run.activeOperation?.externalRunId, "run-1");
  assert.match(
    run.error ?? "",
    /Unable to observe bridge\/implementation \(3\/3\)/,
  );
});

test("stale completed observation preserves a newer cancellation request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new DeferredStatusBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "implementation",
    lease: { sessionId: "session-1", pid: 123, heartbeatAt: Date.now() },
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "run-1",
      taskId: 1,
    },
  });

  const observing = controller.advance(run);
  await bridge.statusRequested;
  await registry.update({ ...run, status: "cancel_pending" });
  bridge.completeStatus();
  const preserved = await observing;

  assert.equal(preserved.status, "cancel_pending");
  assert.equal(preserved.activeOperation?.operationId, "operation-1");
  assert.equal(preserved.taskAttempts["1"], undefined);
});

test("cancellation during missing reviewer output prevents a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new DeferredResultBridge(join(root, "missing-result.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "comprehensive_review",
    stageAttempts: { comprehensive_review: 1 },
    lease: { sessionId: "session-1", pid: 123, heartbeatAt: Date.now() },
    activeOperation: {
      operationId: "review-1",
      service: "bridge",
      kind: "review",
      externalRunId: "run-1",
      asyncDir: join(root, "missing-async"),
      reviewIteration: 1,
    },
  });

  const observing = controller.advance(run);
  await bridge.resultRequested;
  const current = await registry.get(run.id);
  await registry.update({ ...current!, status: "cancel_pending" });
  bridge.completeResult();
  const preserved = await observing;

  assert.equal(preserved.status, "cancel_pending");
  assert.equal(preserved.activeOperation?.operationId, "review-1");
  assert.equal(bridge.spawnCount, 0);
  assert.equal(preserved.stageAttempts.comprehensive_review, 1);
});

test("controller refuses an untracked persisted bridge operation rather than duplicating work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "implementation",
    activeOperation: {
      operationId: "operation-crashed-before-reply",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      params: { agent: "worker", task: "recover", cwd: root },
    },
  });
  const recovered = await controller.advance(run);
  assert.equal(recovered.status, "failed");
  assert.match(
    recovered.error ?? "",
    /refusing to launch a possible duplicate/,
  );
  assert.equal(recovered.activeOperation?.externalRunId, undefined);
  assert.equal(
    recovered.activeOperation?.operationId,
    "operation-crashed-before-reply",
  );
  assert.equal(bridge.spawnCount, 0);
});

test("concurrent controllers launch one bridge operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "none.json"));
  const first = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const second = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    stage: "implementation",
  });

  await Promise.all([first.advance(run), second.advance(run)]);

  assert.equal(bridge.spawnCount, 1);
  assert.equal(
    (await registry.get(run.id))?.activeOperation?.externalRunId,
    "run-1",
  );
});

test("stale structure pause cannot erase a persisted launch intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new DeferredBridge(join(root, "none.json"));
  const launchingController = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const staleController = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    stage: "implementation",
  });

  const advancing = launchingController.advance(run);
  await bridge.spawned;
  await writeFile(planPath, "### Task 1: Changed\n- [ ] Changed text\n");
  const stale = await staleController.advance(run);
  assert.equal(stale.status, "running");
  assert.equal(stale.activeOperation?.operationId !== undefined, true);

  bridge.completeSpawn();
  const attached = await advancing;
  assert.equal(attached.status, "running");
  assert.equal(attached.activeOperation?.externalRunId, "run-1");
});

test("concurrent controllers launch one review operation and record one attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "none.json"));
  const first = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const second = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "comprehensive_review",
  });

  await Promise.all([first.advance(run), second.advance(run)]);

  const stored = await registry.get(run.id);
  assert.equal(bridge.spawnCount, 1);
  assert.equal(stored?.stageAttempts.comprehensive_review, 1);
  assert.equal(stored?.activeOperation?.externalRunId, "run-1");
});

test("spawn reply preserves cancel requested while launch was pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new DeferredBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    stage: "implementation",
  });

  const advancing = controller.advance(run);
  await bridge.spawned;
  const launching = await registry.get(run.id);
  assert.ok(launching?.activeOperation);
  await registry.update({ ...launching!, status: "cancel_pending" });
  bridge.completeSpawn();
  const preserved = await advancing;

  assert.equal(preserved.status, "cancel_pending");
  assert.equal(preserved.activeOperation?.externalRunId, "run-1");
});

test("cancel waits for a pending spawn reply and then stops the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new DeferredBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    stage: "implementation",
  });

  const advancing = controller.advance(run);
  await bridge.spawned;
  const launching = await registry.get(run.id);
  const cancelPending = await registry.update({
    ...launching!,
    status: "cancel_pending",
  });
  const waiting = await controller.advance(cancelPending);
  assert.equal(waiting.status, "cancel_pending");
  assert.equal(waiting.activeOperation?.externalRunId, undefined);

  bridge.completeSpawn();
  const attached = await advancing;
  assert.equal(attached.status, "cancel_pending");
  assert.equal(attached.activeOperation?.externalRunId, "run-1");

  const stopping = await controller.advance(attached);
  assert.equal(stopping.status, "cancel_pending");
  assert.equal(stopping.activeOperation?.stopRequested, true);
  const cancelled = await controller.advance(stopping);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.activeOperation, undefined);
});

test("recent launch intent is not replayed while its spawn reply is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "implementation",
    activeOperation: {
      operationId: "operation-launching",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      params: { agent: "worker", task: "pending", cwd: root },
      launchStartedAt: Date.now(),
    },
  });

  const observed = await controller.advance(run);

  assert.equal(bridge.spawnCount, 0);
  assert.equal(observed.activeOperation?.operationId, "operation-launching");
  assert.equal(observed.status, "running");
});

test("bridge spawn contention fails while preserving the operation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new ContendedBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    stage: "implementation",
  });

  const deferred = await controller.advance(run);

  assert.equal(deferred.status, "failed");
  assert.match(deferred.error ?? "", /already in progress/);
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
  assert.equal(deferred.activeOperation?.operationId !== undefined, true);
});

test("ambiguous spawn timeout fails while preserving the operation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new TimedOutSpawnBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    stage: "implementation",
  });

  const deferred = await controller.advance(run);

  assert.equal(deferred.status, "failed");
  assert.match(deferred.error ?? "", /timed out/);
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
  assert.equal(deferred.activeOperation?.operationId !== undefined, true);
});

test("malformed Fusion start fails without discarding the operation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new MalformedStartFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "fusion_review",
  });

  const deferred = await controller.advance(run);

  assert.equal(deferred.status, "failed");
  assert.match(deferred.error ?? "", /no run ID/);
  assert.equal(deferred.activeOperation?.service, "fusion");
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
});

test("unknown persisted launch remains failed without a duplicate replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "implementation",
    activeOperation: {
      operationId: "operation-pending",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      params: { agent: "worker", task: "pending", cwd: root },
      launchStartedAt: 0,
    },
  });

  const deferred = await controller.advance(run);

  assert.equal(deferred.status, "failed");
  assert.match(deferred.error ?? "", /refusing to launch a possible duplicate/);
  assert.equal(deferred.activeOperation?.operationId, "operation-pending");
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
});

test("resume attaches a found bridge operation instead of spawning another child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FoundOperationBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "implementation",
    error: "Unable to observe bridge/implementation (3/3): unavailable",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      params: { agent: "worker", task: "Do the work", cwd: root },
    },
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.activeOperation?.externalRunId, "existing-run");
  assert.equal(bridge.spawnCount, 0);
});

test("unknown bridge lookup stays recoverable without a duplicate spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new UnknownOperationBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "implementation",
    error: "Bridge spawn timed out.",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      params: { agent: "worker", task: "Do the work", cwd: root },
    },
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "failed");
  assert.match(resumed.error ?? "", /lookup is unresolved/);
  assert.equal(bridge.spawnCount, 0);
});

test("bridge lookup recovery handles pending and malformed outcomes without spawning", async () => {
  const cases: Array<{
    name: string;
    lookup: Record<string, unknown>;
    status: "running" | "failed";
    error?: RegExp;
  }> = [
    {
      name: "pending",
      lookup: { state: "pending" },
      status: "running",
    },
    {
      name: "unknown",
      lookup: { state: "unknown" },
      status: "failed",
      error: /lookup is unresolved/,
    },
    {
      name: "invalid state",
      lookup: { state: "unexpected" },
      status: "failed",
      error: /invalid state/,
    },
    {
      name: "found without run ID",
      lookup: { state: "found" },
      status: "failed",
      error: /omitted a run ID/,
    },
  ];
  for (const testCase of cases) {
    const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
    const planPath = join(root, "plan.md");
    const plan = "### Task 1: Implement\n- [ ] Do the work\n";
    await writeFile(planPath, plan);
    const registry = new RunRegistry(join(root, "runs"));
    const bridge = new LookupOperationBridge(
      join(root, "none.json"),
      testCase.lookup,
    );
    const controller = new PlanExecController(
      registry,
      bridge,
      new FakeFusion(),
      fakeGit(root),
    );
    const failed = await registry.create({
      ...baseRun(root, planPath),
      planHash: parsePlan(planPath, plan).hash,
      status: "failed",
      stage: "implementation",
      error: "Bridge spawn timed out.",
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
      },
    });

    const recovered = await controller.resume(failed.id, "session-1");

    assert.equal(recovered.status, testCase.status, testCase.name);
    if (testCase.error)
      assert.match(recovered.error ?? "", testCase.error, testCase.name);
    assert.equal(bridge.spawnCount, 0, testCase.name);
  }
});

test("resume resets capped reviewer attempts instead of skipping the stage", async () => {
  const cases: Array<{
    stage: "smells_review" | "comprehensive_review" | "fusion_review";
    kind: "review" | "fusion";
    service: "bridge" | "fusion";
    attempts: number;
  }> = [
    {
      stage: "smells_review",
      kind: "review",
      service: "bridge",
      attempts: 1,
    },
    {
      stage: "comprehensive_review",
      kind: "review",
      service: "bridge",
      attempts: 5,
    },
    {
      stage: "fusion_review",
      kind: "fusion",
      service: "fusion",
      attempts: 10,
    },
  ];
  for (const testCase of cases) {
    const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
    const planPath = join(root, "plan.md");
    const plan = "### Task 1: Implement\n- [x] Done\n";
    await writeFile(planPath, plan);
    const registry = new RunRegistry(join(root, "runs"));
    const controller = new PlanExecController(
      registry,
      new FakeBridge(join(root, "none.json")),
      new FakeFusion(),
      fakeGit(root),
    );
    const failed = await registry.create({
      ...baseRun(root, planPath),
      planHash: parsePlan(planPath, plan).hash,
      status: "failed",
      stage: testCase.stage,
      stageAttempts: { [testCase.stage]: testCase.attempts },
      error: "Reviewer terminated without output.",
      failedOperation: {
        operationId: "review-operation",
        service: testCase.service,
        kind: testCase.kind,
        reviewIteration: testCase.attempts,
      },
    });

    const resumed = await controller.resume(failed.id, "session-1");

    assert.equal(resumed.stage, testCase.stage, testCase.stage);
    assert.equal(resumed.stageAttempts[testCase.stage], testCase.attempts);
    assert.equal(resumed.activeOperation?.kind, testCase.kind);
  }
});

test("failed cancellation request keeps the active child recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new StopFailingBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  let run = await registry.create({
    ...baseRun(root, planPath),
    status: "cancel_pending",
    stage: "implementation",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "run-1",
      taskId: 1,
    },
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    run = await controller.advance(run);
  }

  assert.equal(run.status, "failed");
  assert.match(
    run.error ?? "",
    /Unable to cancel bridge\/implementation \(3\/3\)/,
  );
  assert.equal(run.activeOperation?.externalRunId, "run-1");
  assert.equal(run.activeOperation?.stopRequested, undefined);
  assert.equal(run.activeOperation?.statusFailures, 3);
  assert.match(run.activeOperation?.lastStatusError ?? "", /stop unavailable/);
});

test("resume retries cancellation after a provider outage without launching work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [ ] Do the work\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const failing = new PlanExecController(
    registry,
    new StopFailingBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  let run = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "cancel_pending",
    stage: "implementation",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "run-1",
      taskId: 1,
    },
  });
  for (let attempt = 0; attempt < 3; attempt += 1)
    run = await failing.advance(run);
  assert.equal(run.status, "failed");
  assert.equal(run.activeOperation?.recovery, "cancel");

  const recoveringBridge = new FakeBridge(join(root, "none.json"));
  const recovering = new PlanExecController(
    registry,
    recoveringBridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const resumed = await recovering.resume(run.id, "session-1");
  const cancelled = await recovering.advance(resumed);

  assert.equal(cancelled.status, "cancelled");
  assert.equal(recoveringBridge.spawnCount, 0);
});

test("Fusion result failure becomes terminal instead of polling forever", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const fusion = new ResultFailingFusion();
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    fusion,
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "fusion_review",
    activeOperation: {
      operationId: "fusion-operation",
      service: "fusion",
      kind: "fusion",
      externalRunId: "fusion-1",
    },
  });

  const failed = await controller.advance(run);
  const terminal = await controller.advance(failed);

  assert.equal(failed.status, "failed");
  assert.equal(failed.activeOperation?.operationId, "fusion-operation");
  assert.equal(terminal.updatedAt, failed.updatedAt);
  assert.equal(fusion.statusCount, 1);
  assert.equal(fusion.resultCount, 1);
});

test("Fusion recovery reuses the persisted prompt and profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const fusion = new RecordingFusion();
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    fusion,
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "fusion_review",
    activeOperation: {
      operationId: "fusion-operation",
      service: "fusion",
      kind: "fusion",
      launchStartedAt: 0,
      params: { prompt: "saved prompt", profile: "saved-profile" },
    },
  });

  const recovered = await controller.advance(run);

  assert.equal(recovered.activeOperation?.externalRunId, "recovered-fusion");
  assert.deepEqual(fusion.startCalls, [
    ["fusion-operation", "saved prompt", "saved-profile"],
  ]);
});

test("archive records completed_with_findings when findings remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const progressPath = join(root, "progress.txt");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  await writeFile(progressPath, "");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "archive",
    progressPath,
    unresolvedFindings: [
      { id: "minor-1", severity: "MINOR", summary: "Known issue" },
    ],
  });

  const completed = await controller.advance(run);

  assert.equal(completed.status, "completed_with_findings");
  assert.equal(completed.stage, "complete");
  assert.match(await readFile(progressPath, "utf8"), /completed_with_findings/);
});

test("archive commit failure remains resumable and retries idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const failingGit = async (command: string, args: string[]) =>
    args[0] === "commit"
      ? { stdout: "", stderr: "commit failed", code: 1 }
      : fakeGit(root)(command, args);
  const failing = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    failingGit,
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "archive",
  });

  const failed = await failing.advance(run);
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "archive");

  const recovering = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const completed = await recovering.resume(failed.id, "session-1");

  assert.equal(completed.status, "completed");
  assert.equal(completed.stage, "complete");
  await assert.rejects(readFile(planPath));
  assert.match(
    await readFile(join(root, "completed", "plan.md"), "utf8"),
    /Task 1/,
  );
});

test("archive recovery completes after a committed plan move without committing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const destination = join(root, "completed", "plan.md");
  await mkdir(join(root, "completed"), { recursive: true });
  await writeFile(destination, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  let commits = 0;
  const gitAfterCommit = async (_command: string, args: string[]) => {
    if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "commit") {
      commits += 1;
      return { stdout: "", stderr: "", code: 0 };
    }
    return fakeGit(root)("git", args);
  };
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    gitAfterCommit,
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    status: "failed",
    stage: "archive",
    error: "Pi stopped after archive commit.",
  });

  const completed = await controller.resume(failed.id, "session-1");

  assert.equal(completed.status, "completed");
  assert.equal(commits, 0);
  assert.match(await readFile(destination, "utf8"), /Task 1/);
});

test("explicit recovery can adopt the verified current execution branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root, "feature/current"),
  );
  const stale = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    branch: "master",
    status: "failed",
    stage: "smells_review",
    error: "Execution directory is on feature/current, expected master.",
  });

  const rebound = await controller.rebindBranchAndResume(
    stale.id,
    "session-1",
  );

  assert.equal(rebound.branch, "feature/current");
  assert.equal(rebound.activeOperation?.kind, "review");
  assert.deepEqual(rebound.branchRebindings, [
    {
      from: "master",
      to: "feature/current",
      requestedAt: rebound.branchRebindings[0]?.requestedAt,
      requestedBy: "session-1",
    },
  ]);
  assert.equal(bridge.spawnCount, 1);
});

test("branch adoption rejects a run with an active child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root, "feature/current"),
  );
  const busy = await registry.create({
    ...baseRun(root, planPath),
    branch: "master",
    status: "running",
    stage: "smells_review",
    activeOperation: {
      operationId: "live-review",
      service: "bridge",
      kind: "review",
      externalRunId: "live-run",
    },
  });

  await assert.rejects(
    controller.rebindBranchAndResume(busy.id, "session-1"),
    /external operation is tracked/,
  );
});

test("force skip advances a failed review and preserves findings as unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    status: "failed",
    stage: "comprehensive_review",
    reviewFindings: [
      { id: "major-1", severity: "MAJOR", summary: "Unresolved defect" },
    ],
    error: "Fix operation ended as stopped.",
  });

  const skipped = await controller.skip(
    failed.id,
    "session-1",
    "review loop is repeating an already evaluated finding",
  );

  assert.equal(skipped.status, "running");
  assert.equal(skipped.stage, "smells_review");
  assert.equal(skipped.pendingStageSkip, undefined);
  assert.equal(skipped.skippedStages.length, 1);
  assert.equal(skipped.skippedStages[0]?.stage, "comprehensive_review");
  assert.equal(skipped.skippedStages[0]?.requestedBy, "session-1");
  assert.equal(skipped.unresolvedFindings[0]?.id, "major-1");
});

test("force skip stops a live fixer before advancing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new SkippableRunningBridge(join(root, "none.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    status: "failed",
    stage: "comprehensive_review",
    activeOperation: {
      operationId: "live-fix",
      service: "bridge",
      kind: "fix",
      externalRunId: "live-run",
      asyncDir: "/tmp/live-run",
      reviewIteration: 2,
    },
    error: "Unable to observe bridge/fix (3/3): unavailable",
  });

  const stopping = await controller.skip(
    failed.id,
    "session-1",
    "operator accepted the remaining review risk",
  );

  assert.equal(stopping.status, "skip_pending");
  assert.equal(stopping.stage, "comprehensive_review");
  assert.equal(stopping.activeOperation?.stopRequested, true);
  assert.equal(stopping.pendingStageSkip?.reason, "operator accepted the remaining review risk");
  assert.equal(bridge.stopCount, 1);
  assert.equal(bridge.spawnCount, 0);

  bridge.state = "stopped";
  const skipped = await controller.advance(stopping);
  assert.equal(skipped.status, "running");
  assert.equal(skipped.stage, "smells_review");
  assert.equal(skipped.activeOperation?.kind, "review");
  assert.equal(skipped.skippedStages[0]?.terminalOperationState, "stopped");
});

test("force skip does not treat an absent operation as terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new LookupOperationBridge(join(root, "none.json"), {
    state: "absent",
  });
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    status: "failed",
    stage: "comprehensive_review",
    activeOperation: {
      operationId: "uncertain-fix",
      service: "bridge",
      kind: "fix",
      reviewIteration: 2,
    },
    error: "Launch outcome is unknown.",
  });

  const pending = await controller.skip(
    failed.id,
    "session-1",
    "operator accepts review risk",
  );

  assert.equal(pending.status, "skip_pending");
  assert.equal(pending.stage, "comprehensive_review");
  assert.equal(pending.skippedStages.length, 0);
  assert.match(pending.activeOperation?.lastSkipError ?? "", /cannot prove/);
});

test("force skip does not treat unknown bridge states as terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new SkippableRunningBridge(join(root, "none.json"));
  bridge.state = "mystery";
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    status: "failed",
    stage: "comprehensive_review",
    activeOperation: {
      operationId: "mystery-fix",
      service: "bridge",
      kind: "fix",
      externalRunId: "mystery-run",
    },
    error: "Unknown provider state.",
  });

  const pending = await controller.skip(
    failed.id,
    "session-1",
    "operator accepts review risk",
  );

  assert.equal(pending.status, "skip_pending");
  assert.equal(pending.stage, "comprehensive_review");
  assert.equal(pending.skippedStages.length, 0);
  assert.equal(pending.activeOperation?.skipFailures, 1);
  assert.equal(bridge.stopCount, 0);

  const retried = await controller.advance(pending);
  assert.equal(retried.status, "skip_pending");
  assert.equal(retried.activeOperation?.skipFailures, 2);
  const failedAgain = await controller.advance(retried);
  assert.equal(failedAgain.status, "failed");
  assert.equal(failedAgain.pendingStageSkip?.stage, "comprehensive_review");
});

test("force skip recovers a Fusion launch before stopping it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const fusion = new SkippableFusion();
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    fusion,
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    status: "failed",
    stage: "fusion_review",
    activeOperation: {
      operationId: "fusion-launch",
      service: "fusion",
      kind: "fusion",
      params: { prompt: "Review this diff", profile: "default" },
    },
    error: "Fusion launch response was lost.",
  });

  const pending = await controller.skip(
    failed.id,
    "session-1",
    "operator accepts remaining Fusion risk",
  );

  assert.equal(pending.status, "skip_pending");
  assert.equal(pending.activeOperation?.externalRunId, "recovered-fusion");
  assert.equal(pending.activeOperation?.stopRequested, true);
  assert.equal(fusion.startCount, 1);
  assert.equal(fusion.cancelCount, 1);
});

test("resume returns a failed pending skip to skip_pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new SkippableRunningBridge(join(root, "none.json"));
  bridge.state = "stopped";
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(
      planPath,
      "### Task 1: Implement\n- [x] Done\n",
    ).hash,
    status: "failed",
    stage: "comprehensive_review",
    pendingStageSkip: {
      stage: "comprehensive_review",
      reason: "operator waiver",
      requestedAt: 1,
      requestedBy: "session-1",
    },
    activeOperation: {
      operationId: "stopping-fix",
      service: "bridge",
      kind: "fix",
      externalRunId: "stopping-run",
      stopRequested: true,
      statusFailures: 3,
      lastStatusError: "provider unavailable",
    },
    error: "Unable to finish force-skip.",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.status, "running");
  assert.equal(resumed.stage, "smells_review");
  assert.equal(resumed.pendingStageSkip, undefined);
  assert.equal(resumed.skippedStages.length, 1);
});

test("force skip rejects implementation and archive stages", async () => {
  for (const stage of ["implementation", "archive"] as const) {
    const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
    const planPath = join(root, "plan.md");
    await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
    const registry = new RunRegistry(join(root, "runs"));
    const controller = new PlanExecController(
      registry,
      new FakeBridge(join(root, "none.json")),
      new FakeFusion(),
      fakeGit(root),
    );
    const failed = await registry.create({
      ...baseRun(root, planPath),
      status: "failed",
      stage,
      error: "blocked",
    });

    await assert.rejects(
      controller.skip(failed.id, "session-1", "force it"),
      /cannot be force-skipped/,
    );
  }
});

test("a force-skipped stage makes terminal completion honest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "complete",
    skippedStages: [
      {
        stage: "comprehensive_review",
        reason: "operator waiver",
        requestedAt: 1,
        requestedBy: "session-1",
        completedAt: 2,
      },
    ],
  });

  const completed = await controller.advance(run);
  assert.equal(completed.status, "completed_with_findings");
});

test("archive refuses to overwrite an existing completed plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const destination = join(root, "completed", "plan.md");
  await mkdir(join(root, "completed"), { recursive: true });
  await writeFile(planPath, "new plan\n");
  await writeFile(destination, "old archive\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "archive",
  });

  const failed = await controller.advance(run);

  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /destination already exists/);
  assert.equal(await readFile(planPath, "utf8"), "new plan\n");
  assert.equal(await readFile(destination, "utf8"), "old archive\n");
});

test("failed fixer recovery uses operation metadata instead of its error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const plan = "### Task 1: Implement\n- [x] Done\n";
  await writeFile(planPath, plan);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new RunningBridge(join(root, "none.json")),
    new FakeFusion(),
    fakeGit(root),
  );
  const failed = await registry.create({
    ...baseRun(root, planPath),
    planHash: parsePlan(planPath, plan).hash,
    status: "failed",
    stage: "smells_review",
    stageAttempts: { smells_review: 1 },
    reviewFindings: [{ id: "major-1", severity: "MAJOR", summary: "Fix it" }],
    failedOperation: {
      operationId: "fix-1",
      service: "bridge",
      kind: "fix",
      externalRunId: "run-1",
      reviewIteration: 1,
    },
    error: "Unable to observe bridge/fix (3/3): unavailable",
  });

  const resumed = await controller.resume(failed.id, "session-1");

  assert.equal(resumed.stage, "smells_review");
  assert.equal(resumed.activeOperation?.kind, "fix");
  assert.match(
    String(resumed.activeOperation?.params?.task),
    /FINDING: MAJOR \| Fix it/,
  );
});

test("comprehensive review retries when the reviewer produces no output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(join(root, "missing-result.json"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "comprehensive_review",
  });

  const first = await controller.advance(run);
  const retried = await controller.advance(first);

  assert.equal(retried.status, "running");
  assert.equal(retried.stage, "comprehensive_review");
  assert.equal(retried.stageAttempts.comprehensive_review, 2);
  assert.equal(retried.activeOperation?.reviewIteration, 2);
  assert.equal(bridge.spawnCount, 2);
});

test("malformed reviewer output fails instead of consuming an output retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const reviewPath = join(root, "malformed-review.json");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  await writeFile(reviewPath, JSON.stringify({ output: "looks fine" }));
  const registry = new RunRegistry(join(root, "runs"));
  const bridge = new FakeBridge(reviewPath);
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "comprehensive_review",
  });

  const launched = await controller.advance(run);
  const failed = await controller.advance(launched);

  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /structured FINDING/);
  assert.equal(failed.stageAttempts.comprehensive_review, 1);
  assert.equal(bridge.spawnCount, 1);
});

test("archive stages the plan move and final progress entries together", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const progressPath = join(root, ".ralphex", "progress", "progress-plan.txt");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  await mkdir(join(root, ".ralphex", "progress"), { recursive: true });
  await writeFile(progressPath, "started\n");
  const calls: string[][] = [];
  const git = async (command: string, args: string[]) => {
    calls.push(args);
    return fakeGit(root)(command, args);
  };
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new FakeBridge(join(root, "none.json")),
    new FakeFusion(),
    git,
  );
  const run = await registry.create({
    ...baseRun(root, planPath),
    stage: "archive",
    progressPath,
  });

  const completed = await controller.advance(run);

  assert.equal(completed.status, "completed");
  assert.equal(completed.stage, "complete");
  await assert.rejects(readFile(planPath));
  assert.match(
    await readFile(join(root, "completed", "plan.md"), "utf8"),
    /Task 1/,
  );
  assert.match(
    await readFile(progressPath, "utf8"),
    /Run completed as completed/,
  );
  const add = calls.find((args) => args[0] === "add");
  assert.deepEqual(add, [
    "add",
    "-A",
    "--",
    "plan.md",
    "completed/plan.md",
    ".ralphex/progress/progress-plan.txt",
  ]);
});

test("controller records unresolved capped review findings and completes honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  const reviewPath = join(root, "review-result.json");
  await writeFile(planPath, "### Task 1: Implement\n- [x] Done\n");
  await writeFile(
    reviewPath,
    JSON.stringify({
      output:
        "FINDING: MAJOR | Broken boundary\nEvidence: src/a.ts:1\nFix: validate input",
    }),
  );
  const bridge = new FakeBridge(reviewPath);
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    bridge,
    new FakeFusion(),
    fakeGit(root),
  );
  const run = await registry.create(
    baseRun(root, planPath, { reviewIterations: 1 }),
  );
  const reviewRun: PlanExecRun = {
    ...run,
    status: "running",
    stage: "comprehensive_review",
  };

  const launched = await controller.advance(reviewRun);
  assert.equal(launched.activeOperation?.kind, "review");
  const resolved = await controller.advance(launched);
  assert.equal(resolved.stage, "smells_review");
  assert.equal(resolved.unresolvedFindings[0]?.severity, "MAJOR");
});

function baseRun(
  root: string,
  planPath: string,
  overrides: { reviewIterations?: number } = {},
) {
  return {
    schemaVersion: 1 as const,
    repositoryRoot: root,
    planPath,
    planHash: "ignored",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: "running" as const,
    stage: "resolve" as const,
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    config: {
      taskRetries: 1,
      maxTaskIterations: 50,
      reviewIterations: overrides.reviewIterations ?? 5,
      fusionIterations: 10,
      finalizeEnabled: true,
      workerAgent: "worker",
      workerMaxTurns: 50,
      reviewerAgent: "reviewer",
      reviewerMaxTurns: 30,
      statsAgent: "reviewer",
      statsMaxTurns: 30,
    },
  };
}

class FakeBridge {
  protected current = 0;
  constructor(protected readonly resultPath: string) {}
  get spawnCount() {
    return this.current;
  }
  async spawn(): Promise<BridgeResult> {
    this.current += 1;
    return success({ runId: `run-${this.current}`, asyncDir: "/tmp/async" });
  }
  async operation(): Promise<BridgeResult> {
    return success({ state: "absent" });
  }
  async status(): Promise<
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: { message: string } }
  > {
    return success({ state: "complete" });
  }
  async result(): Promise<BridgeResult> {
    return success({ state: "complete", resultPath: this.resultPath });
  }
  async adopt(): Promise<BridgeResult> {
    return success({ state: "complete" });
  }
  async stop(): Promise<BridgeResult> {
    return success({ state: "stopping" });
  }
}

class DeferredResultBridge extends FakeBridge {
  private announceResult!: () => void;
  private releaseResult?: (result: BridgeResult) => void;
  readonly resultRequested = new Promise<void>((resolve) => {
    this.announceResult = resolve;
  });

  override result(): Promise<BridgeResult> {
    this.announceResult();
    return new Promise((resolve) => {
      this.releaseResult = resolve;
    });
  }

  completeResult(): void {
    this.releaseResult?.(success({ resultPath: this.resultPath }));
  }
}

class DeferredStatusBridge extends FakeBridge {
  private announceStatus!: () => void;
  private releaseStatus?: (
    result:
      | { success: true; data: Record<string, unknown> }
      | { success: false; error: { message: string } },
  ) => void;
  readonly statusRequested = new Promise<void>((resolve) => {
    this.announceStatus = resolve;
  });

  override status(): Promise<
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: { message: string } }
  > {
    this.announceStatus();
    return new Promise((resolve) => {
      this.releaseStatus = resolve;
    });
  }

  completeStatus(): void {
    this.releaseStatus?.(success({ state: "complete" }));
  }
}

class DeferredBridge extends FakeBridge {
  private announceSpawn!: () => void;
  private releaseSpawn?: (result: BridgeResult) => void;
  readonly spawned = new Promise<void>((resolve) => {
    this.announceSpawn = resolve;
  });

  override spawn(): Promise<BridgeResult> {
    this.current += 1;
    this.announceSpawn();
    return new Promise((resolve) => {
      this.releaseSpawn = resolve;
    });
  }

  completeSpawn(): void {
    this.releaseSpawn?.(
      success({ runId: `run-${this.current}`, asyncDir: "/tmp/async" }),
    );
  }
}

class StartupRaceBridge extends FakeBridge {
  adoptCount = 0;

  override async status() {
    return success({ state: "running" });
  }

  override async adopt(): Promise<BridgeResult> {
    this.adoptCount += 1;
    return {
      success: false,
      error: { message: "Status file not found." },
    };
  }
}

class AdoptionNotReadyBridge extends FakeBridge {
  override async adopt(): Promise<BridgeResult> {
    return {
      success: false,
      error: { message: "Status file not found." },
    };
  }

  override async status() {
    return {
      success: false as const,
      error: { message: "Status file not found." },
    };
  }
}

class SkippableRunningBridge extends FakeBridge {
  state = "running";
  stopCount = 0;

  override async status() {
    return success({ state: this.state });
  }

  override async stop(): Promise<BridgeResult> {
    this.stopCount += 1;
    return success({ state: "stopping" });
  }
}

class RunningBridge extends FakeBridge {
  override async status(): Promise<
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: { message: string } }
  > {
    return success({ state: "running" });
  }
}

class TimedOutSpawnBridge extends FakeBridge {
  override async spawn(): Promise<BridgeResult> {
    return {
      success: false,
      error: { code: "timeout", message: "Bridge spawn timed out." },
    };
  }
}

class FoundOperationBridge extends FakeBridge {
  override async operation(): Promise<BridgeResult> {
    return success({
      state: "found",
      runId: "existing-run",
      asyncDir: "/tmp/existing-run",
    });
  }
}

class UnknownOperationBridge extends FakeBridge {
  override async operation(): Promise<BridgeResult> {
    return success({ state: "unknown" });
  }
}

class LookupOperationBridge extends FakeBridge {
  constructor(
    artifactPath: string,
    private readonly lookup: Record<string, unknown>,
  ) {
    super(artifactPath);
  }

  override async operation(): Promise<BridgeResult> {
    return success(this.lookup);
  }
}

class StopFailingBridge extends FakeBridge {
  override async stop(): Promise<BridgeResult> {
    return {
      success: false,
      error: { message: "stop unavailable" },
    };
  }
}

class ContendedBridge extends FakeBridge {
  override async spawn() {
    return {
      success: false as const,
      error: {
        message:
          "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
      },
    };
  }
}

class UnavailableBridge extends FakeBridge {
  override async status() {
    return {
      success: false as const,
      error: { message: "bridge unavailable" },
    };
  }
}

class FakeFusion {
  async start(
    _operationId?: string,
    _prompt?: string,
    _profile?: string,
  ): Promise<BridgeResult> {
    void _operationId;
    void _prompt;
    void _profile;
    return success({
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    });
  }
  async status(): Promise<BridgeResult> {
    return success({
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    });
  }
  async result(): Promise<BridgeResult> {
    return success({
      run: {
        runId: "fusion-1",
        phase: "done",
        terminal: true,
        report: "NO_FINDINGS",
      },
    });
  }
  async adopt(): Promise<BridgeResult> {
    return success({
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    });
  }
  async cancel(): Promise<BridgeResult> {
    return success({ cancelled: true });
  }
}

class SkippableFusion extends FakeFusion {
  startCount = 0;
  cancelCount = 0;

  override async start(): Promise<BridgeResult> {
    this.startCount += 1;
    return success({
      run: { runId: "recovered-fusion", phase: "panel", terminal: false },
    });
  }

  override async status(): Promise<BridgeResult> {
    return success({
      run: { runId: "recovered-fusion", phase: "panel", terminal: false },
    });
  }

  override async cancel(): Promise<BridgeResult> {
    this.cancelCount += 1;
    return success({ cancelled: true });
  }
}

class RecordingFusion extends FakeFusion {
  readonly startCalls: Array<[string, string, string | undefined]> = [];

  override async start(
    operationId: string,
    prompt: string,
    profile?: string,
  ): Promise<BridgeResult> {
    this.startCalls.push([operationId, prompt, profile]);
    return success({
      run: { runId: "recovered-fusion", phase: "panel", terminal: false },
    });
  }
}

class ResultFailingFusion extends FakeFusion {
  statusCount = 0;
  resultCount = 0;

  override async status(): Promise<BridgeResult> {
    this.statusCount += 1;
    return success({
      run: { runId: "fusion-1", phase: "failed", terminal: true },
    });
  }

  override async result(): Promise<BridgeResult> {
    this.resultCount += 1;
    return {
      success: false as const,
      error: { message: "Fusion report unavailable" },
    };
  }
}

class MalformedStartFusion extends FakeFusion {
  override async start(): Promise<BridgeResult> {
    return success({ accepted: true });
  }
}

function fakeGit(root: string, branch = "feature") {
  return async (_command: string, args: string[]) => {
    if (args[0] === "symbolic-ref")
      return { stdout: "origin/main\n", stderr: "", code: 0 };
    if (args[0] === "branch")
      return { stdout: `${branch}\n`, stderr: "", code: 0 };
    if (args.includes("--git-common-dir"))
      return { stdout: `${root}/.git\n`, stderr: "", code: 0 };
    return { stdout: `${root}\n`, stderr: "", code: 0 };
  };
}
