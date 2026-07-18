import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "@tintinweb/pi-tasks/dist/task-store.js";
import { RunRegistry } from "../src/registry.js";
import { sessionTaskPath, TaskProjector } from "../src/task-projection.js";

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

test("projects plan tasks and pipeline stages into the pi-tasks session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-projection-"));
  const planPath = join(root, "plan.md");
  await writeFile(
    planPath,
    `### Task 1: First\n- [x] Finished\n\n### Task 2: Second\n- [ ] Pending\n`,
  );
  const registry = new RunRegistry(join(root, "runs"));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    planPath,
    planHash: "ignored-by-projection",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  const projector = new TaskProjector(registry);
  const projected = await projector.sync(run, {
    cwd: root,
    sessionId: "session-1",
  });
  const path = sessionTaskPath(root, "session-1");
  const tasks = new TaskStore(path).list();

  assert.equal(projected.taskProjection?.listPath, path);
  assert.equal(tasks.length, 9);
  assert.deepEqual(
    tasks.map((task) => [task.metadata.planExecKey, task.status]),
    [
      ["implementation:1", "completed"],
      ["implementation:2", "pending"],
      ["comprehensive_review", "pending"],
      ["smells_review", "pending"],
      ["fusion_review", "pending"],
      ["critical_review", "pending"],
      ["finalize", "pending"],
      ["stats", "pending"],
      ["archive", "pending"],
    ],
  );
  assert.deepEqual(tasks[1]?.blockedBy, [tasks[0]?.id]);
  assert.deepEqual(tasks[2]?.blockedBy, [tasks[1]?.id]);
});

test("completed runs can project after the plan is archived", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-projection-"));
  const planPath = join(root, "plan.md");
  await mkdir(join(root, "completed"), { recursive: true });
  await writeFile(
    join(root, "completed", "plan.md"),
    `### Task 1: First\n- [x] Finished\n`,
  );
  const registry = new RunRegistry(join(root, "runs"));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    planPath,
    planHash: "ignored-by-projection",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: "completed",
    stage: "complete",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    config,
    unresolvedFindings: [],
  });
  const projector = new TaskProjector(registry);
  await projector.sync(run, { cwd: root, sessionId: "session-1" });
  assert.equal(
    new TaskStore(sessionTaskPath(root, "session-1")).list()[0]?.status,
    "completed",
  );
});

test("failed runs are visible without leaving projected work in progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-projection-"));
  const planPath = join(root, "plan.md");
  await writeFile(
    planPath,
    `### Task 1: First\n- [x] Finished\n\n### Task 2: Second\n- [ ] Pending\n`,
  );
  const registry = new RunRegistry(join(root, "runs"));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    planPath,
    planHash: "ignored-by-projection",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: "failed",
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    config,
    error: "Plan task structure changed outside checkbox completion.",
    unresolvedFindings: [],
  });
  const projector = new TaskProjector(registry);
  await projector.sync(run, { cwd: root, sessionId: "session-1" });

  const tasks = new TaskStore(sessionTaskPath(root, "session-1")).list();
  const task = tasks.find(
    (candidate) => candidate.metadata.planExecKey === "implementation:2",
  );
  assert.equal(task?.status, "pending");
  assert.match(task?.description ?? "", /Plan-exec failed/);

  const stage = tasks.find(
    (candidate) => candidate.metadata.planExecKey === "comprehensive_review",
  );
  assert.equal(stage?.status, "pending");

  assert.throws(() => sessionTaskPath("/repo", ""), /session ID/);
});

test("projection removes stale tasks and their blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-projection-"));
  const planPath = join(root, "plan.md");
  await writeFile(
    planPath,
    "### Task 1: First\n- [x] Finished\n\n### Task 2: Removed\n- [ ] Old\n",
  );
  const registry = new RunRegistry(join(root, "runs"));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    planPath,
    planHash: "ignored-by-projection",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "comprehensive_review",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  const projector = new TaskProjector(registry);
  const first = await projector.sync(run, {
    cwd: root,
    sessionId: "session-1",
  });
  await writeFile(planPath, "### Task 1: First\n- [x] Finished\n");

  await projector.sync(first, { cwd: root, sessionId: "session-1" });

  const tasks = new TaskStore(sessionTaskPath(root, "session-1")).list();
  assert.equal(
    tasks.some((task) => task.metadata.planExecKey === "implementation:2"),
    false,
  );
  const implementation = tasks.find(
    (task) => task.metadata.planExecKey === "implementation:1",
  );
  const review = tasks.find(
    (task) => task.metadata.planExecKey === "comprehensive_review",
  );
  assert.deepEqual(review?.blockedBy, [implementation?.id]);
});

test("force-skipped stages remain auditable while unblocking the next stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-projection-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: First\n- [x] Finished\n");
  const registry = new RunRegistry(join(root, "runs"));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    planPath,
    planHash: "ignored-by-projection",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "smells_review",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [
      {
        stage: "comprehensive_review",
        reason: "operator accepted the remaining review risk",
        requestedAt: 1,
        requestedBy: "session-1",
        completedAt: 2,
      },
    ],
    config,
  });
  const projector = new TaskProjector(registry);
  await projector.sync(run, { cwd: root, sessionId: "session-1" });

  const tasks = new TaskStore(sessionTaskPath(root, "session-1")).list();
  const skipped = tasks.find(
    (task) => task.metadata.planExecKey === "comprehensive_review",
  );
  const next = tasks.find(
    (task) => task.metadata.planExecKey === "smells_review",
  );
  assert.equal(skipped?.status, "completed");
  assert.match(skipped?.subject ?? "", /FORCE-SKIPPED/);
  assert.match(skipped?.description ?? "", /remaining review risk/);
  assert.equal(next?.status, "in_progress");
  assert.deepEqual(next?.blockedBy, [skipped?.id]);
});
