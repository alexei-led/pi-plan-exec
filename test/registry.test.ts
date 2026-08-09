import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isLeaseLive,
  LEASE_STALE_MS,
  removalRefusal,
  RunRegistry,
} from "../src/registry.js";
import type { PlanExecRun } from "../src/types.js";

type RunLease = NonNullable<PlanExecRun["lease"]>;

/** A pid that is reaped before spawnSync returns, so it is reliably gone. */
function reapedPid(): number {
  const { pid } = spawnSync("true");
  assert.ok(pid, "spawnSync must report a child pid");
  return pid;
}

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
  assert.equal(adopted.lease?.hostname, hostname());
});

test("lease liveness weighs session, heartbeat, hostname, and pid", () => {
  const gone = reapedPid();
  const fresh = Date.now();
  const stale = Date.now() - LEASE_STALE_MS;
  const here = hostname();
  const cases: Array<{
    name: string;
    lease: RunLease;
    sessionId?: string;
    live: boolean;
  }> = [
    {
      name: "the owning session is live whatever the lease says",
      lease: { sessionId: "s1", pid: gone, heartbeatAt: stale, hostname: here },
      sessionId: "s1",
      live: true,
    },
    {
      name: "a foreign lease with a running local pid still blocks",
      lease: {
        sessionId: "s1",
        pid: process.pid,
        heartbeatAt: fresh,
        hostname: here,
      },
      sessionId: "s2",
      live: true,
    },
    {
      name: "a foreign lease with a dead local pid is dead now",
      lease: { sessionId: "s1", pid: gone, heartbeatAt: fresh, hostname: here },
      sessionId: "s2",
      live: false,
    },
    {
      name: "a stale heartbeat outranks a running pid",
      lease: {
        sessionId: "s1",
        pid: process.pid,
        heartbeatAt: stale,
        hostname: here,
      },
      live: false,
    },
    {
      name: "another host falls back to heartbeat freshness",
      lease: {
        sessionId: "s1",
        pid: gone,
        heartbeatAt: fresh,
        hostname: "other-host",
      },
      live: true,
    },
    {
      name: "another host with a stale heartbeat is dead",
      lease: {
        sessionId: "s1",
        pid: process.pid,
        heartbeatAt: stale,
        hostname: "other-host",
      },
      live: false,
    },
    {
      name: "an absent hostname falls back to heartbeat freshness",
      lease: { sessionId: "s1", pid: gone, heartbeatAt: fresh },
      live: true,
    },
    {
      name: "an absent hostname with a stale heartbeat is dead",
      lease: { sessionId: "s1", pid: process.pid, heartbeatAt: stale },
      live: false,
    },
    {
      name: "a lease with no session ID never matches an absent argument",
      lease: {
        pid: gone,
        heartbeatAt: fresh,
        hostname: here,
      } as unknown as RunLease,
      live: false,
    },
  ];

  for (const testCase of cases)
    assert.equal(
      isLeaseLive(testCase.lease, testCase.sessionId),
      testCase.live,
      testCase.name,
    );
});

test("a dead local pid frees the lease without waiting out the heartbeat", async () => {
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
    lease: {
      sessionId: "session-1",
      pid: reapedPid(),
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });

  const claimed = await registry.claim(run, "session-2");

  assert.equal(claimed.lease?.sessionId, "session-2");
  assert.equal(claimed.lease?.pid, process.pid);
});

test("a heartbeat refreshes liveness without taking over lease identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const gone = reapedPid();
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
    lease: {
      sessionId: "session-1",
      pid: gone,
      heartbeatAt: 1,
      hostname: hostname(),
    },
  });

  const lease = (await registry.heartbeat(run)).lease;

  assert.ok(lease);
  assert.equal(lease.pid, gone);
  assert.equal(isLeaseLive(lease, "session-2"), false);
});

test("a lease written before hostname existed is judged by heartbeat alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const runId = "22222222-2222-4222-8222-222222222222";
  await mkdir(join(directory, runId), { recursive: true });
  await writeFile(
    join(directory, runId, "run.json"),
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
      stage: "implementation",
      taskAttempts: {},
      stageAttempts: {},
      reviewFindings: [],
      unresolvedFindings: [],
      config,
      createdAt: 1,
      updatedAt: 1,
      lease: {
        sessionId: "session-1",
        pid: reapedPid(),
        heartbeatAt: Date.now(),
      },
    }),
    "utf8",
  );

  const loaded = await registry.get(runId);

  assert.ok(loaded);
  const lease = loaded.lease;
  assert.ok(lease);
  assert.equal(lease.hostname, undefined);
  // The pid is dead, so a pid check would free this lease; the heartbeat holds it.
  assert.equal(isLeaseLive(lease, "session-2"), true);
  await assert.rejects(
    () => registry.claim(loaded, "session-2"),
    /another active Pi session/,
  );
});

test("remove retires a terminal run and refuses anything still in play", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const seed = {
    schemaVersion: 1 as const,
    repositoryRoot: "/repo",
    planPath: "/repo/plan.md",
    planHash: "hash",
    worktreeCwd: "/repo",
    branch: "feature",
    defaultBranch: "main",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  };
  const retired = await registry.create({
    ...seed,
    status: "completed",
    stage: "complete",
  });
  const running = await registry.create({
    ...seed,
    status: "running",
    stage: "implementation",
  });
  const held = await registry.create({
    ...seed,
    status: "cancelled",
    stage: "implementation",
    lease: {
      sessionId: "session-1",
      pid: process.pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });

  await registry.remove(retired.id);

  assert.equal(await registry.get(retired.id), undefined);
  await assert.rejects(stat(join(directory, retired.id)), /ENOENT/);
  await assert.rejects(
    () => registry.remove(running.id),
    /only a terminal run can be removed/,
  );
  await assert.rejects(
    () => registry.remove(held.id),
    /held by a live lease from session session-1/,
  );
  assert.equal(removalRefusal(retired), undefined);
  assert.match(removalRefusal(running) ?? "", /only a terminal run/);
  // A second removal of a gone run is a no-op, not a failure.
  await registry.remove(retired.id);
  await assert.rejects(
    () => registry.remove("../escape"),
    /Invalid plan-exec run ID/,
  );
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
  assert.equal(migrated?.config.taskRetries, 1);
  assert.equal(migrated?.config.maxTaskIterations, 50);
  assert.equal(migrated?.config.workerAgent, "worker");
  assert.equal(migrated?.config.workerMaxTurns, 50);
  assert.equal(migrated?.config.reviewIterations, 5);
  assert.deepEqual(migrated?.reviewFindings, []);
  assert.deepEqual(migrated?.skippedStages, []);
  assert.deepEqual(migrated?.branchRebindings, []);
  assert.equal(JSON.parse(await readFile(path, "utf8")).stage, "tasks");
});

test("registry rejects invalid persisted lifecycle shapes", async () => {
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
  const missingConfig = structuredClone(run) as unknown as PlanExecRun;
  delete (missingConfig.config as Partial<typeof config>).workerAgent;

  await assert.rejects(
    registry.update({
      ...run,
      status: "not-a-status" as PlanExecRun["status"],
    }),
    /Invalid plan-exec run registry entry/,
  );
  await assert.rejects(
    registry.update(missingConfig),
    /Invalid plan-exec run registry entry/,
  );
  await assert.rejects(
    registry.update({
      ...run,
      activeOperation: {
        operationId: "review-at-implementation",
        service: "bridge",
        kind: "review",
      },
    }),
    /Invalid plan-exec run registry entry/,
  );
  await assert.rejects(
    registry.update({
      ...run,
      status: "skip_pending",
      pendingStageSkip: {
        stage: "implementation",
        reason: "unsafe waiver",
        requestedAt: 1,
        requestedBy: "session-1",
      },
    }),
    /Invalid plan-exec run registry entry/,
  );
  await assert.rejects(
    registry.update({
      ...run,
      skippedStages: [
        {
          stage: "archive",
          reason: "unsafe waiver",
          requestedAt: 1,
          requestedBy: "session-1",
          completedAt: 2,
        },
      ],
    }),
    /Invalid plan-exec run registry entry/,
  );

  const path = join(directory, run.id, "run.json");
  await writeFile(path, JSON.stringify({ ...run, skippedStages: {} }));
  await assert.rejects(
    registry.get(run.id),
    /Invalid plan-exec run registry entry/,
  );
});

test("registry lists healthy runs when a sibling entry is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const healthy = await registry.create({
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
  const corruptId = "22222222-2222-4222-8222-222222222222";
  await mkdir(join(directory, corruptId), { recursive: true });
  await writeFile(join(directory, corruptId, "run.json"), "{not-json\n");

  const result = await registry.listWithErrors();

  assert.deepEqual(
    result.runs.map((run) => run.id),
    [healthy.id],
  );
  assert.equal(result.errors[0]?.runId, corruptId);
  assert.notEqual(result.errors[0]?.message, "");
});
