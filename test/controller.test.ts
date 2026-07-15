import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("paused runs finish an active child without advancing the stage", async () => {
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
  assert.equal(paused.activeOperation, undefined);
  assert.equal(paused.stage, "implementation");
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

test("controller replays a persisted bridge operation after a crash before spawn reply", async () => {
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
      operationId: "operation-crashed-before-reply",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      params: { agent: "worker", task: "recover", cwd: root },
    },
  });
  const recovered = await controller.advance(run);
  assert.equal(recovered.activeOperation?.externalRunId, "run-1");
  assert.equal(
    recovered.activeOperation?.operationId,
    "operation-crashed-before-reply",
  );
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

test("bridge spawn contention stays recoverable instead of failing the run", async () => {
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

  assert.equal(deferred.status, "running");
  assert.equal(deferred.error, undefined);
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
  assert.ok((deferred.activeOperation?.launchStartedAt ?? 0) < Date.now());
});

test("ambiguous spawn timeout preserves the launch intent for replay", async () => {
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

  assert.equal(deferred.status, "running");
  assert.equal(deferred.error, undefined);
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
  assert.ok((deferred.activeOperation?.launchStartedAt ?? 0) < Date.now());
});

test("malformed Fusion start preserves the operation ID for replay", async () => {
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

  assert.equal(deferred.status, "running");
  assert.equal(deferred.error, undefined);
  assert.equal(deferred.activeOperation?.service, "fusion");
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
});

test("recovery spawn contention remains pending instead of failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-controller-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const registry = new RunRegistry(join(root, "runs"));
  const controller = new PlanExecController(
    registry,
    new ContendedBridge(join(root, "none.json")),
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

  assert.equal(deferred.status, "running");
  assert.equal(deferred.error, undefined);
  assert.equal(deferred.activeOperation?.operationId, "operation-pending");
  assert.equal(deferred.activeOperation?.externalRunId, undefined);
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

  assert.equal(run.status, "cancel_pending");
  assert.equal(run.error, undefined);
  assert.equal(run.activeOperation?.externalRunId, "run-1");
  assert.equal(run.activeOperation?.stopRequested, undefined);
  assert.equal(run.activeOperation?.statusFailures, 3);
  assert.match(run.activeOperation?.lastStatusError ?? "", /stop unavailable/);
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
  async start() {
    return success({
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    });
  }
  async status() {
    return success({
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    });
  }
  async result() {
    return success({
      run: {
        runId: "fusion-1",
        phase: "done",
        terminal: true,
        report: "NO_FINDINGS",
      },
    });
  }
  async adopt() {
    return success({
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    });
  }
  async cancel() {
    return success({ cancelled: true });
  }
}

class MalformedStartFusion extends FakeFusion {
  override async start() {
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
