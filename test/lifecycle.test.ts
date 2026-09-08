import assert from "node:assert/strict";
import test from "node:test";
import { classifyAbandonment } from "../src/lifecycle.js";
import type { PlanExecRun } from "../src/types.js";

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

test("durable absence resets only an unbound launch", () => {
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
    "abandoned",
  );
});
