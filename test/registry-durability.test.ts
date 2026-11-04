import assert from 'node:assert/strict';
import { test } from 'vitest';
import { requiresDurableWrite } from '../src/registry.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';

const run: PlanExecRun = {
  schemaVersion: 1,
  id: 'run',
  repositoryRoot: '/repo',
  worktreeCwd: '/repo',
  planPath: '/repo/plan.md',
  planHash: 'hash',
  branch: 'feature',
  defaultBranch: 'main',
  status: 'running',
  stage: 'implementation',
  config: DEFAULT_FROZEN_RUN_CONFIG,
  taskAttempts: {},
  stageAttempts: {},
  reviewFindings: [],
  unresolvedFindings: [],
  skippedStages: [],
  branchRebindings: [],
  createdAt: 1,
  updatedAt: 2,
  lease: { sessionId: 'owner', pid: 1, hostname: 'host', heartbeatAt: 2 },
};

for (const patch of [
  { wakeReason: 'fresh observation', updatedAt: 3 },
  { nextAttemptAt: 5000 },
  { displayDismissed: true },
  { lease: { sessionId: 'owner', pid: 1, hostname: 'host', heartbeatAt: 3 } },
])
  test(`diagnostic/heartbeat updates do not fsync unrelated authority: ${JSON.stringify(patch)}`, () => {
    assert.equal(requiresDurableWrite(run, { ...run, ...patch }), false);
  });

for (const patch of [
  { status: 'cancel_pending' as const, userStopped: true, stopGeneration: 1 },
  { executionGeneration: 1 },
  { worktreeCwd: '/another' },
  { acceptedHead: 'accepted-commit' },
  {
    lease: { sessionId: 'new-owner', pid: 2, hostname: 'host', heartbeatAt: 3 },
  },
  {
    activeOperation: {
      operationId: 'intent',
      service: 'native' as const,
      kind: 'implementation' as const,
    },
  },
  {
    config: {
      ...DEFAULT_FROZEN_RUN_CONFIG,
      requiredChecks: [['node', 'check.mjs']],
    },
  },
  {
    lanePreparation: {
      taskId: 1,
      cwd: '/lane',
      branch: 'lane',
      baselineCommit: 'base',
      state: 'create' as const,
    },
  },
])
  test(`authority/acceptance changes retain power-loss durability: ${JSON.stringify(patch)}`, () => {
    assert.equal(requiresDurableWrite(run, { ...run, ...patch }), true);
  });
