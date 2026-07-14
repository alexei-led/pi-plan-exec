import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("concurrent claims allow only one session to acquire the lease", async () => {
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

  const claims = await Promise.allSettled([
    registry.claim(run, "session-1"),
    registry.claim(run, "session-2"),
  ]);

  assert.equal(
    claims.filter((claim) => claim.status === "fulfilled").length,
    1,
  );
  assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
  const stored = await registry.get(run.id);
  assert.equal(
    stored?.lease?.sessionId,
    claims.find((claim) => claim.status === "fulfilled")?.value.lease
      ?.sessionId,
  );
});

test("claiming from a stale snapshot preserves newer run state", async () => {
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
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  await registry.update({
    ...run,
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
    },
  });

  const claimed = await registry.claim(run, "session-1");

  assert.equal(claimed.activeOperation?.operationId, "operation-1");
});

test("ordinary stale updates cannot erase a newer active operation", async () => {
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
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  const launching = await registry.update({
    ...run,
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
    },
  });

  const preserved = await registry.update({ ...run, status: "paused" });

  assert.equal(preserved.updatedAt, launching.updatedAt);
  assert.equal(preserved.status, "running");
  assert.equal(preserved.activeOperation?.operationId, "operation-1");
});

test("stale heartbeat preserves a newer cancellation request", async () => {
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
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
    lease: { sessionId: "session-1", pid: 123, heartbeatAt: 1 },
  });
  const cancelling = await registry.update({
    ...run,
    status: "cancel_pending",
  });

  const observed = await registry.heartbeat(run);

  assert.equal(observed.status, "cancel_pending");
  assert.equal(observed.updatedAt, cancelling.updatedAt);
});

test("controller lock recovers an orphan from the same live Pi process", async () => {
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
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  const lockPath = join(directory, run.id, "run.json.controller.lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now() - 180_000,
      token: "orphaned-extension",
    })}\n`,
  );

  const result = await registry.withControllerLock(run.id, async () => "ok");

  assert.equal(result, "ok");
  await assert.rejects(readFile(lockPath), /ENOENT/);
});

test("controller lock does not steal a fresh live provider request", async () => {
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
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  const lockPath = join(directory, run.id, "run.json.controller.lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now() - 60_000,
      token: "live-provider-request",
    })}\n`,
  );

  const result = await registry.withControllerLock(run.id, async () => "ok");

  assert.equal(result, undefined);
  assert.match(await readFile(lockPath, "utf8"), /live-provider-request/);
  await rm(lockPath);
});

test("registry update timestamps are monotonic for compare-and-set safety", async () => {
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

  const updated = await registry.update({ ...run, status: "paused" });

  assert.ok(updated.updatedAt > run.updatedAt);
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
