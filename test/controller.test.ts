import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlanExecController } from "../src/controller.js";
import { RunRegistry } from "../src/registry.js";
import type { PlanExecRun } from "../src/types.js";

const success = (data: Record<string, unknown>) => ({
  success: true as const,
  data,
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
  private current = 0;
  constructor(private readonly resultPath: string) {}
  async spawn() {
    this.current += 1;
    return success({ runId: `run-${this.current}`, asyncDir: "/tmp/async" });
  }
  async status() {
    return success({ state: "complete" });
  }
  async result() {
    return success({ state: "complete", resultPath: this.resultPath });
  }
  async adopt() {
    return success({ state: "complete" });
  }
  async stop() {
    return success({ state: "stopping" });
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

function fakeGit(root: string) {
  return async (_command: string, args: string[]) => {
    if (args[0] === "symbolic-ref")
      return { stdout: "origin/main\n", stderr: "", code: 0 };
    if (args[0] === "branch")
      return { stdout: "feature\n", stderr: "", code: 0 };
    if (args.includes("--git-common-dir"))
      return { stdout: `${root}/.git\n`, stderr: "", code: 0 };
    return { stdout: `${root}\n`, stderr: "", code: 0 };
  };
}
