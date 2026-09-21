import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "@tintinweb/pi-tasks/dist/task-store.js";
import { formatRunWidget, shouldAutoRestoreRun, shouldStopBackgroundController } from "../src/index.js";
import { sessionTaskPath, TaskProjector } from "../src/task-projection.js";
import { RunRegistry } from "../src/registry.js";
import {
  DEFAULT_FROZEN_RUN_CONFIG,
  RUN_STAGE,
  RUN_STATUS,
  type PlanExecRun,
} from "../src/types.js";

function runFixture(root: string): Omit<PlanExecRun, "id" | "createdAt" | "updatedAt"> {
  return {
    schemaVersion: 1,
    repositoryRoot: root,
    planPath: join(root, "plan.md"),
    planHash: "ignored",
    worktreeCwd: root,
    branch: "feature",
    defaultBranch: "main",
    status: RUN_STATUS.RUNNING,
    stage: RUN_STAGE.IMPLEMENTATION,
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
  };
}

test("projection preserves explicit independent dependencies and durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-ui-"));
  await writeFile(
    join(root, "plan.md"),
    [
      "### Task 1: First",
      "- [ ] Pending",
      "",
      "### Task 2: Independent",
      "dependsOn: []",
      "- [ ] Pending",
      "",
      "### Task 3: Needs first",
      "dependsOn: [1]",
      "- [ ] Pending",
      "",
    ].join("\n"),
  );
  const registry = new RunRegistry(join(root, "runs"));
  const run = await registry.create(runFixture(root));
  const projected = await new TaskProjector(registry).sync(run, {
    cwd: root,
    sessionId: "session-1",
  });
  const tasks = new TaskStore(sessionTaskPath(root, "session-1")).list();
  const implementation = (id: number) =>
    tasks.find((task) => task.metadata.planExecKey === `implementation:${id}`);
  assert.deepEqual(implementation(2)?.blockedBy, []);
  assert.deepEqual(implementation(3)?.blockedBy, [implementation(1)?.id]);
  assert.deepEqual(
    implementation(2)?.metadata.planExecDependsOn,
    [],
  );
  assert.equal(projected.taskProjection?.state, "ready");
});

test("widget reports waits, verified activity, usage, and explicit unbounded lifetime", () => {
  const now = 1_000_000;
  const run = {
    ...runFixture("/repo"),
    id: "run-widget",
    createdAt: now - 20_000,
    updatedAt: now,
    tasks: {
      "1": {
        taskId: 1,
        dependsOn: [],
        state: "retry_wait" as const,
        attempts: 4,
        nextAttemptAt: now + 25_000,
        reason: "provider unavailable",
        lastVerifiedActivityAt: now - 2_000,
        usage: { inputTokens: 1200, outputTokens: 800, cost: 0.12 },
      },
      "2": {
        taskId: 2,
        dependsOn: [1],
        state: "waiting_dependency" as const,
        attempts: 0,
        reason: "after task 1",
      },
    },
    needsAttention: true,
    usage: { inputTokens: 3_000, outputTokens: 1_800, cost: 0.4 },
  } satisfies PlanExecRun;
  const widget = formatRunWidget(run, now);
  assert.match(widget.join("\n"), /0\/2 accepted/);
  assert.match(widget.join("\n"), /retry 1/);
  assert.match(widget.join("\n"), /after task 1 is accepted/);
  assert.match(widget.join("\n"), /Needs attention/);
  assert.match(widget.join("\n"), /Usage: tokens 4800, cost 0.4/);
  assert.match(widget.join("\n"), /Lifetime: unbounded requested/);
  assert.match(widget.join("\n"), /Last verified progress/);
});

test("startup restores stale or unleased runs without stealing live leases or pauses", () => {
  const base = {
    ...runFixture("/repo"),
    id: "run",
    createdAt: 1,
    updatedAt: 1,
  } satisfies PlanExecRun;
  assert.equal(shouldAutoRestoreRun(base, "session-1"), true);
  assert.equal(
    shouldAutoRestoreRun(
      { ...base, lease: { sessionId: "other", pid: process.pid, heartbeatAt: Date.now() } },
      "session-1",
    ),
    false,
  );
  assert.equal(
    shouldAutoRestoreRun({ ...base, status: RUN_STATUS.PAUSED }, "session-1"),
    false,
  );
  assert.equal(
    shouldAutoRestoreRun(
      { ...base, status: RUN_STATUS.CANCEL_PENDING, userStopped: true },
      "session-1",
    ),
    true,
  );
});

test("restart restores paused local cleanup without resuming plan execution", () => {
  const paused = { ...runFixture("/repo"), id: "paused-cleanup", createdAt: 1, updatedAt: 1,
    status: RUN_STATUS.PAUSED, userStopped: true, localOperationActive: true } satisfies PlanExecRun;
  assert.equal(shouldAutoRestoreRun(paused, "new-session"), true);
  assert.equal(shouldStopBackgroundController(paused), false);
  const retired = { ...paused, localOperationActive: false };
  assert.equal(shouldAutoRestoreRun(retired, "new-session"), false);
  assert.equal(shouldStopBackgroundController(retired), true);
});
