import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunRegistry } from "../src/registry.js";
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

test("registry persists runs, protects path traversal, and reclaims stale leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: "/repo",
    planPath: "/repo/docs/plans/example.md",
    planHash: "hash",
    worktreeCwd: "/worktree",
    branch: "feature",
    defaultBranch: "main",
    status: "starting",
    stage: "resolve",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });

  const claimed = await registry.claim(run, "session-1");
  await assert.rejects(
    () => registry.claim(claimed, "session-2"),
    /another active Pi session/,
  );
  await assert.rejects(
    () => registry.get("../escape"),
    /Invalid plan-exec run ID/,
  );

  const stale: PlanExecRun = {
    ...claimed,
    lease: { sessionId: "session-1", pid: process.pid, heartbeatAt: 0 },
  };
  const adopted = await registry.claim(stale, "session-2");
  assert.equal(adopted.lease?.sessionId, "session-2");
});

test("registry rejects stale compare-and-set updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: "/repo",
    planPath: "/repo/plan.md",
    planHash: "hash",
    worktreeCwd: "/repo",
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "resolve",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  const newer = await registry.update({ ...run, status: "paused" });
  const result = await registry.updateIfCurrent(
    { ...run, status: "cancel_pending" },
    run.updatedAt,
  );
  assert.equal(result.applied, false);
  assert.equal(result.run.status, newer.status);
});

test("registry migrates vertical-slice runs missing review metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const runId = "11111111-1111-4111-8111-111111111111";
  const path = join(directory, runId, "run.json");
  await mkdir(join(directory, runId), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      id: runId,
      repositoryRoot: "/repo",
      planPath: "/repo/plan.md",
      planHash: "hash",
      worktreeCwd: "/repo",
      branch: "feature",
      defaultBranch: "main",
      status: "running",
      stage: "tasks",
      taskAttempts: {},
      config: {
        taskRetries: 1,
        maxTaskIterations: 50,
        workerAgent: "worker",
        workerMaxTurns: 50,
      },
      unresolvedFindings: [],
      createdAt: 1,
      updatedAt: 1,
    }) + "\n",
  );

  const registry = new RunRegistry(directory);
  const migrated = await registry.get(runId);
  assert.equal(migrated?.stage, "project_tasks");
  assert.equal(migrated?.config.reviewIterations, 5);
  assert.deepEqual(migrated?.reviewFindings, []);
  assert.equal(JSON.parse(await readFile(path, "utf8")).stage, "tasks");
});
