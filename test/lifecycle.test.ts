import assert from "node:assert/strict";
import test from "node:test";
import { activeExecutionLifetime, classifyAbandonment, longRunningOperation } from "../src/lifecycle.js";
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from "../src/types.js";

function inFlight(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    repositoryRoot: "/repo",
    planPath: "/repo/docs/plans/plan.md",
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
      externalRunId: "external-1",
      asyncDir: "/tmp/missing-async-directory",
    },
    config: {
      ...DEFAULT_FROZEN_RUN_CONFIG,
      taskRetries: 1,
      maxTaskIterations: 1,
      reviewIterations: 1,
      fusionIterations: 1,
      finalizeEnabled: true,
      workerAgent: "worker",
      workerMaxTurns: 1,
      reviewerAgent: "reviewer",
      reviewerMaxTurns: 1,
      statsAgent: "reviewer",
      statsMaxTurns: 1,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("recovery fails closed when a bound worker has only missing-directory or absent evidence", () => {
  const run = inFlight();

  assert.equal(
    classifyAbandonment(run, {
      leaseLive: false,
      asyncDirPresent: false,
      bridgeState: "absent",
      durableOperationLookup: true,
    }),
    "ambiguous",
  );
  assert.equal(
    classifyAbandonment(run, {
      leaseLive: false,
      processTerminalProof: {
        version: 1,
        state: "observed",
        runId: "different-external-run",
        runnerProcessInstanceId: "native-instance-1",
        observedAt: 1,
        instances: [],
      },
    }),
    "ambiguous",
  );
});

test("durable absence is ambiguous unless it explicitly permits same-identity reconciliation", () => {
  const run = inFlight({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
    },
  });

  assert.equal(
    classifyAbandonment(run, {
      leaseLive: false,
      bridgeState: "absent",
      durableOperationLookup: true,
    }),
    "ambiguous",
  );
  assert.equal(classifyAbandonment(run, { leaseLive: false, bridgeState: "absent", durableOperationLookup: true, replaySafe: true }), "reconcilable");
});

test("only explicitly bounded compatibility runs receive an elapsed deadline", () => {
  const unbounded = inFlight({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      launchStartedAt: 1,
    },
  });
  assert.equal(longRunningOperation(unbounded, 10_000_000), undefined);

  const bounded = inFlight({
    config: {
      ...DEFAULT_FROZEN_RUN_CONFIG,
      executionLifetime: { mode: "bounded", timeoutMs: 5_000 },
    },
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      launchStartedAt: 1,
      expectedLifetime: { mode: "bounded", timeoutMs: 5_000 },
    },
  });
  assert.equal(longRunningOperation(bounded, 5_001), undefined);
  assert.deepEqual(longRunningOperation(bounded, 5_002), {
    elapsedMs: 5_001,
    boundMs: 5_000,
  });
  assert.deepEqual(longRunningOperation(bounded, 5_003), {
    elapsedMs: 5_002,
    boundMs: 5_000,
  });
});

test("compatibility deadline display follows the persisted attempt rather than the frozen base", () => {
  const run = inFlight({ config: { ...DEFAULT_FROZEN_RUN_CONFIG, executionLifetime: { mode: "bounded", timeoutMs: 5_000 } },
    activeOperation: { operationId: "grown", service: "bridge", kind: "implementation", launchStartedAt: 1,
      expectedLifetime: { mode: "bounded", timeoutMs: 20_000 }, effectiveLifetime: { mode: "bounded", timeoutMs: 20_000 } },
  });
  assert.deepEqual(activeExecutionLifetime(run), { mode: "bounded", timeoutMs: 20_000 });
  assert.equal(longRunningOperation(run, 10_001), undefined);
  assert.deepEqual(longRunningOperation(run, 20_002), { elapsedMs: 20_001, boundMs: 20_000 });
});

test("legacy unknown operation lifetime is not synthesized from a changed frozen base", () => {
  const run = inFlight({ config: { ...DEFAULT_FROZEN_RUN_CONFIG, executionLifetime: { mode: "bounded", timeoutMs: 5_000 } } });
  assert.equal(activeExecutionLifetime(run), undefined);
  assert.equal(longRunningOperation(run, 100_000), undefined);
  run.activeOperation!.params = { executionLifetime: { mode: "bounded", timeoutMs: 10_000 } };
  assert.deepEqual(activeExecutionLifetime(run), { mode: "bounded", timeoutMs: 10_000 });
});
