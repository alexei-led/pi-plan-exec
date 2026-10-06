import assert from 'node:assert/strict';
import { snapshotBackgroundWork } from 'pi-subagents/background-work';
import { snapshotExternalRuns } from 'pi-subagents/external-runs';
import { test } from 'vitest';
import {
  type BackgroundWorkProvider,
  type ExternalRunRecord,
  loadPlanExecRuntimeIntegration,
  PlanExecRuntimeIntegration,
} from '../src/runtime-integration.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';

class FakeRuntimeApi {
  readonly rows = new Map<string, ExternalRunRecord>();
  readonly providers = new Map<string, BackgroundWorkProvider>();

  registerExternalRun = (record: ExternalRunRecord): void => {
    const key = `${record.sessionId}:${record.id}`;
    if (this.rows.has(key)) throw new Error(`duplicate external run ${key}`);
    this.rows.set(key, record);
  };

  updateExternalRun = (
    sessionId: string,
    runId: string,
    update: Partial<ExternalRunRecord>,
  ): void => {
    const key = `${sessionId}:${runId}`;
    const current = this.rows.get(key);
    if (current) this.rows.set(key, { ...current, ...update });
  };

  unregisterExternalRun = (sessionId: string, runId: string): void => {
    this.rows.delete(`${sessionId}:${runId}`);
  };

  registerBackgroundWorkProvider = (
    provider: BackgroundWorkProvider,
  ): (() => void) => {
    this.providers.set(provider.name, provider);
    return () => {
      if (this.providers.get(provider.name) === provider)
        this.providers.delete(provider.name);
    };
  };
}

function run(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return {
    schemaVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    revision: 3,
    repositoryRoot: '/repo',
    planPath: '/repo/plan.md',
    planHash: 'hash',
    worktreeCwd: '/repo',
    branch: 'feature',
    defaultBranch: 'main',
    status: 'running',
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    lease: { sessionId: 'session-1', pid: process.pid, heartbeatAt: 1 },
    config: {
      ...DEFAULT_FROZEN_RUN_CONFIG,
      taskRetries: 1,
      maxTaskIterations: 50,
      reviewIterations: 5,
      fusionIterations: 10,
      finalizeEnabled: true,
      workerAgent: 'worker',
      workerMaxTurns: 50,
      reviewerAgent: 'reviewer',
      reviewerMaxTurns: 30,
      statsAgent: 'reviewer',
      statsMaxTurns: 30,
    },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

for (const runtimeId of ['/tmp/pi-tests/sessions/session-1.jsonl', 'session-1'])
  test(`native consumers see runtime identity ${runtimeId}, not lease identity`, async () => {
    const integration = await loadPlanExecRuntimeIntegration();
    try {
      integration.reconcile([run()], 'session-1', runtimeId);
      assert.equal(snapshotExternalRuns(runtimeId).length, 1);
      assert.equal(snapshotBackgroundWork(runtimeId).items.length, 1);
      if (runtimeId !== 'session-1') {
        assert.equal(snapshotExternalRuns('session-1').length, 0);
        assert.equal(snapshotBackgroundWork('session-1').items.length, 0);
      }
      integration.reconcile(
        [run({ status: 'completed', updatedAt: 3 })],
        'session-1',
        runtimeId,
      );
      assert.equal(snapshotBackgroundWork(runtimeId).items.length, 0);
    } finally {
      integration.dispose();
    }
    assert.equal(snapshotExternalRuns(runtimeId).length, 0);
  });
test('Fleet admission failure cannot hide active background work or leak completion', () => {
  const api = new FakeRuntimeApi();
  api.registerExternalRun = () => {
    throw new Error('external run cache full');
  };
  const integration = new PlanExecRuntimeIntegration(api);
  assert.doesNotThrow(() => integration.sync(run(), 'session-1'));
  assert.equal([...api.providers.values()][0]?.listActiveWork().length, 1);
  integration.sync(run({ status: 'completed' }), 'session-1');
  assert.equal([...api.providers.values()][0]?.listActiveWork().length, 0);
  integration.dispose();
});
test('terminal Fleet retention is bounded without dropping active work', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.reconcile(
    [
      ...Array.from({ length: 120 }, (_, i) =>
        run({ id: `done-${i}`, status: 'completed', updatedAt: i }),
      ),
      run(),
    ],
    'session-1',
  );
  assert.ok(api.rows.size <= 21);
  assert.equal([...api.providers.values()][0]?.listActiveWork().length, 1);
  integration.dispose();
});

test('registers one PlanExec row and one background provider', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.reconcile([run()], 'session-1');

  assert.equal(api.rows.size, 1);
  const row = [...api.rows.values()][0];
  assert.equal(row?.id, 'plan-exec:11111111-1111-4111-8111-111111111111');
  assert.equal(row?.source, 'pi-plan-exec');
  assert.equal(api.providers.size, 1);
  const provider = [...api.providers.values()][0];
  assert.deepEqual(provider?.listActiveWork(), [
    {
      id: 'plan-exec:11111111-1111-4111-8111-111111111111',
      sessionId: 'session-1',
    },
  ]);
});

test('reload reconciliation replaces owned registrations without duplicates', () => {
  const api = new FakeRuntimeApi();
  const first = new PlanExecRuntimeIntegration(api);
  first.reconcile([run()], 'session-1');
  const second = new PlanExecRuntimeIntegration(api);
  second.reconcile([run({ revision: 4, updatedAt: 3 })], 'session-1');

  assert.equal(api.rows.size, 1);
  assert.equal(api.providers.size, 1);
  first.dispose();
  assert.equal(api.rows.size, 1);
  assert.equal(api.providers.size, 1);
  second.dispose();
  assert.equal(api.rows.size, 0);
  assert.equal(api.providers.size, 0);
});

test('new reload reconciliation removes stale rows from the prior generation', () => {
  const api = new FakeRuntimeApi();
  const first = new PlanExecRuntimeIntegration(api);
  const stale = run({ id: '22222222-2222-4222-8222-222222222222' });
  first.reconcile([run(), stale], 'session-1');
  const second = new PlanExecRuntimeIntegration(api);

  second.reconcile([run()], 'session-1');

  assert.deepEqual(
    [...api.rows.values()].map((row) => row.id),
    ['plan-exec:11111111-1111-4111-8111-111111111111'],
  );
  first.dispose();
  assert.equal(api.rows.size, 1);
  second.dispose();
});

test('old reload reconciliation cannot remove a replacement row', () => {
  const api = new FakeRuntimeApi();
  const first = new PlanExecRuntimeIntegration(api);
  first.reconcile([run()], 'session-1');
  const second = new PlanExecRuntimeIntegration(api);
  second.reconcile([run()], 'session-1');
  first.reconcile([], 'session-1');

  assert.equal(api.rows.size, 1);
  second.reconcile([], 'session-1');
  assert.equal(api.rows.size, 0);
  first.dispose();
  second.dispose();
});

test('same generation reconciliation removes its own retired row', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.reconcile([run()], 'session-1');
  integration.reconcile([], 'session-1');

  assert.equal(api.rows.size, 0);
  integration.dispose();
});

test('disposed integration cannot resurrect rows or providers', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.reconcile([run()], 'session-1');
  integration.dispose();

  integration.sync(run({ revision: 4, updatedAt: 3 }), 'session-1');
  integration.reconcile([run({ revision: 5, updatedAt: 4 })], 'session-1');

  assert.equal(api.rows.size, 0);
  assert.equal(api.providers.size, 0);
});

test('terminal retention eviction preserves the observation watermark', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.sync(run({ status: 'completed', updatedAt: 10 }), 'session-1');
  for (let i = 0; i < 20; i++)
    integration.sync(
      run({ id: `new-${i}`, status: 'completed', updatedAt: 20 + i }),
      'session-1',
    );
  assert.equal(api.rows.size, 20);
  integration.sync(run({ status: 'running', updatedAt: 9 }), 'session-1');
  assert.equal([...api.providers.values()][0]?.listActiveWork().length, 0);
  assert.equal(api.rows.size, 20);
  integration.dispose();
});

test('late running snapshots cannot re-add terminal work to the provider', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.sync(run({ status: 'completed', updatedAt: 4 }), 'session-1');
  integration.sync(run({ status: 'running', updatedAt: 3 }), 'session-1');
  assert.equal([...api.providers.values()][0]?.listActiveWork().length, 0);
  assert.equal([...api.rows.values()][0]?.state, 'completed');
  integration.dispose();
});

test('terminal runs remain visible but leave background work', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  integration.reconcile([run()], 'session-1');
  const completed = run({ status: 'completed', stage: 'complete' });
  delete completed.lease;
  integration.sync(completed, 'session-1');

  assert.equal([...api.rows.values()][0]?.state, 'completed');
  const provider = [...api.providers.values()][0];
  assert.deepEqual(provider?.listActiveWork(), []);
});

test('owner attribution keeps terminal history visible after lease release', () => {
  const api = new FakeRuntimeApi();
  const integration = new PlanExecRuntimeIntegration(api);
  const terminal = run({ status: 'completed', ownerSessionId: 'session-1' });
  delete terminal.lease;
  integration.reconcile([terminal], 'foreign');
  assert.equal(api.rows.size, 0);
  integration.reconcile([terminal], 'session-1');
  assert.equal(
    [...api.rows.values()][0]?.preview,
    'completed · implementation',
  );
  assert.deepEqual([...api.providers.values()][0]?.listActiveWork(), []);
  integration.dispose();
});
