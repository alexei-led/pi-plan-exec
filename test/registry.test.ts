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
  classifyAbandonment,
  type Abandonment,
  type AbandonmentEvidence,
} from "../src/lifecycle.js";
import {
  asLocalRun,
  isLeaseLive,
  isLocalRun,
  LEASE_STALE_MS,
  removalRefusal,
  RunRegistry,
} from "../src/registry.js";
import type { PlanExecRun } from "../src/types.js";

type RunLease = NonNullable<PlanExecRun["lease"]>;

/**
 * A pid that is reaped before spawnSync returns, so it is reliably gone.
 * Assumes the OS does not recycle it inside one test run — the only
 * nondeterministic input in the liveness matrix, and the first thing to
 * suspect if a lease test ever flakes.
 */
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
  const shortHere = here.split(".")[0]!;
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
      name: "the same machine under a different network suffix checks its pid",
      lease: {
        sessionId: "s1",
        pid: gone,
        heartbeatAt: fresh,
        hostname: `${shortHere}.corp.example.com`,
      },
      sessionId: "s2",
      live: false,
    },
    {
      name: "hostname case is not machine identity",
      lease: {
        sessionId: "s1",
        pid: gone,
        heartbeatAt: fresh,
        hostname: shortHere.toUpperCase(),
      },
      sessionId: "s2",
      live: false,
    },
    {
      name: "an mDNS collision rename is a different machine",
      lease: {
        sessionId: "s1",
        pid: gone,
        heartbeatAt: fresh,
        hostname: `${shortHere}-2.local`,
      },
      sessionId: "s2",
      live: true,
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
  assert.equal(loaded.retiredAt, undefined);
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

test("remove deletes an unreadable record instead of throwing on it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-registry-"));
  const registry = new RunRegistry(directory);
  const corruptId = "22222222-2222-4222-8222-222222222222";
  const wrongSchemaId = "33333333-3333-4333-8333-333333333333";
  await mkdir(join(directory, corruptId), { recursive: true });
  await writeFile(join(directory, corruptId, "run.json"), "{not-json\n");
  await mkdir(join(directory, wrongSchemaId), { recursive: true });
  await writeFile(
    join(directory, wrongSchemaId, "run.json"),
    `${JSON.stringify({ id: wrongSchemaId, schemaVersion: 2 })}\n`,
  );

  await registry.remove(corruptId);
  await registry.remove(wrongSchemaId);

  await assert.rejects(stat(join(directory, corruptId)), /ENOENT/);
  await assert.rejects(stat(join(directory, wrongSchemaId)), /ENOENT/);
  assert.deepEqual((await registry.listWithErrors()).errors, []);
});

test("abandonment needs a dead lease, an in-flight claim, and a gone operation", () => {
  const subject = (overrides: Partial<PlanExecRun> = {}): PlanExecRun => ({
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
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
    skippedStages: [],
    branchRebindings: [],
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      asyncDir: "/tmp/async",
    },
    config,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
  const withoutOperation = subject();
  delete withoutOperation.activeOperation;
  const cases: Array<{
    name: string;
    run: PlanExecRun;
    evidence: AbandonmentEvidence;
    expected: Abandonment;
  }> = [
    {
      name: "dead lease, running, directory gone",
      run: subject(),
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "abandoned",
    },
    {
      name: "dead lease, running, bridge has no record",
      run: subject(),
      evidence: { leaseLive: false, bridgeState: "absent" },
      expected: "abandoned",
    },
    {
      name: "dead lease, starting, directory gone",
      run: subject({ status: "starting" }),
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "abandoned",
    },
    {
      name: "dead lease, cancel_pending, directory gone",
      run: subject({ status: "cancel_pending" }),
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "abandoned",
    },
    {
      name: "dead lease, skip_pending, directory gone",
      run: subject({
        status: "skip_pending",
        stage: "comprehensive_review",
        activeOperation: {
          operationId: "operation-1",
          service: "bridge",
          kind: "review",
          asyncDir: "/tmp/async",
        },
        pendingStageSkip: {
          stage: "comprehensive_review",
          reason: "blocked",
          requestedAt: 1,
          requestedBy: "session-1",
        },
      }),
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "abandoned",
    },
    {
      name: "live lease outranks every other signal",
      run: subject(),
      evidence: { leaseLive: true, asyncDirPresent: false },
      expected: "live",
    },
    {
      name: "directory still on disk is not gone",
      run: subject(),
      evidence: { leaseLive: false, asyncDirPresent: true },
      expected: "ambiguous",
    },
    {
      name: "no operation evidence at all",
      run: subject(),
      evidence: { leaseLive: false },
      expected: "ambiguous",
    },
    {
      name: "a running bridge answer is not absence",
      run: subject(),
      evidence: { leaseLive: false, bridgeState: "running" },
      expected: "ambiguous",
    },
    {
      name: "paused does not claim work in flight",
      run: subject({ status: "paused" }),
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "ambiguous",
    },
    {
      name: "a terminal run is never abandoned",
      run: subject({ status: "failed" }),
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "ambiguous",
    },
    {
      name: "no tracked operation cannot be proven gone",
      run: withoutOperation,
      evidence: { leaseLive: false, asyncDirPresent: false },
      expected: "ambiguous",
    },
  ];

  for (const { name, run, evidence, expected } of cases)
    assert.equal(classifyAbandonment(run, evidence), expected, name);
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

/** The seed every removal test starts from: a run the registry would delete. */
async function seedRemovable(): Promise<{
  directory: string;
  registry: RunRegistry;
  run: PlanExecRun;
}> {
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
    status: "completed",
    stage: "complete",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config,
  });
  return { directory, registry, run };
}

test("remove refuses a record it cannot read for an I/O reason", async () => {
  const { directory, registry, run } = await seedRemovable();
  // A directory where the file belongs yields EISDIR without needing root:
  // unreadable, but not evidence of anything, so it must not be deleted.
  await rm(join(directory, run.id, "run.json"));
  await mkdir(join(directory, run.id, "run.json"), { recursive: true });

  await assert.rejects(registry.remove(run.id), /EISDIR|illegal operation/i);
  assert.ok(
    await stat(join(directory, run.id)),
    "an unreadable-for-I/O record survives",
  );
});

test("remove decides refusal under the lock, not before it", async () => {
  const { directory, registry, run } = await seedRemovable();
  const path = join(directory, run.id, "run.json");
  const lockPath = `${path}.lock`;
  // Hold the run's lock the way a concurrent writer would.
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "held" })}\n`,
  );

  const removal = registry.remove(run.id);
  // The run is revived while the removal waits for the lock. A refusal decided
  // before locking would delete the directory a live worker is writing to.
  await writeFile(
    path,
    `${JSON.stringify({ ...run, status: "running", stage: "implementation" })}\n`,
  );
  await rm(lockPath);

  await assert.rejects(removal, /only a terminal run can be removed/);
  assert.equal((await registry.get(run.id))?.status, "running");
});

test("remove reports whether a record was actually deleted", async () => {
  const { registry, run } = await seedRemovable();

  assert.equal(await registry.remove(run.id), true);
  assert.equal(await registry.remove(run.id), false, "already gone is not a removal");
});

test("updateLatest re-applies a write that update would have dropped", async () => {
  const { registry, run } = await seedRemovable();
  const stale = await registry.update({ ...run, branch: "first" });
  await registry.update({ ...stale, branch: "second" });

  // The optimistic write is silently dropped: whoever wrote second wins, and
  // the caller is handed that record back rather than an error.
  const dropped = await registry.update({ ...stale, branch: "third" });
  assert.equal(dropped.branch, "second");
  assert.equal((await registry.get(run.id))?.branch, "second");

  // A terminal write cannot be dropped like that: the work it records has
  // already happened on disk, so it is re-applied on top of the newer record.
  const merged = await registry.updateLatest(run.id, (current) => ({
    ...current,
    status: "cancelled",
  }));

  assert.equal(merged.status, "cancelled");
  assert.equal(merged.branch, "second", "the other writer's change survives");
  await assert.rejects(
    registry.updateLatest("11111111-1111-4111-8111-111111111111", (it) => it),
    /Plan execution run not found/,
  );
});

test("only this host's evidence speaks for a run", () => {
  const local = (lease?: RunLease): PlanExecRun =>
    ({ id: "11111111-1111-4111-8111-111111111111", lease }) as PlanExecRun;

  assert.equal(isLocalRun(local()), true, "no lease is no other host");
  assert.equal(
    isLocalRun(local({ sessionId: "s", pid: 1, heartbeatAt: 0 })),
    true,
    "a pre-upgrade lease is treated as local, as it always was",
  );
  assert.equal(
    isLocalRun(
      local({ sessionId: "s", pid: 1, heartbeatAt: 0, hostname: hostname() }),
    ),
    true,
  );
  assert.equal(
    isLocalRun(
      local({ sessionId: "s", pid: 1, heartbeatAt: 0, hostname: "other-host" }),
    ),
    false,
  );
  const shortHere = hostname().split(".")[0]!;
  assert.equal(
    isLocalRun(
      local({
        sessionId: "s",
        pid: 1,
        heartbeatAt: 0,
        hostname: `${shortHere.toUpperCase()}.lan`,
      }),
    ),
    true,
    "a network rename of this machine is still this machine",
  );
  assert.equal(
    isLocalRun(
      local({
        sessionId: "s",
        pid: 1,
        heartbeatAt: 0,
        hostname: `${shortHere}-2.local`,
      }),
    ),
    false,
    "the suffix mDNS adds to avoid a collision names a different machine",
  );
});

test("--same-machine asserts the host and touches nothing else", () => {
  const lease = {
    sessionId: "s",
    pid: 1,
    heartbeatAt: 7,
    hostname: "renamed-by-dhcp",
  };
  const run = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "running",
    lease,
  } as PlanExecRun;

  const asserted = asLocalRun(run);

  assert.equal(isLocalRun(run), false, "the stored run is left alone");
  assert.equal(isLocalRun(asserted), true);
  assert.equal(asserted.lease?.sessionId, "s");
  assert.equal(asserted.lease?.pid, 1);
  assert.equal(asserted.lease?.heartbeatAt, 7);
  assert.deepEqual(
    asLocalRun({ id: run.id } as PlanExecRun),
    { id: run.id },
    "a run with no lease has no host to assert",
  );
});
