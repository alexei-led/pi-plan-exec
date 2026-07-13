import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("session task paths reject missing session IDs", () => {
  assert.throws(() => sessionTaskPath("/repo", ""), /session ID/);
});
