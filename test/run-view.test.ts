import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { test } from 'vitest';
import {
  progressView,
  RunPresentation,
  renderProgressStrip,
} from '../src/run-view.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';

function run(patch: Partial<PlanExecRun> = {}): PlanExecRun {
  return {
    schemaVersion: 1,
    id: 'run-1',
    revision: 1,
    repositoryRoot: '/repo',
    worktreeCwd: '/repo/work',
    planPath: '/repo/2026-10-05-router-ui.md',
    planHash: 'hash',
    branch: 'work',
    defaultBranch: 'main',
    status: 'running',
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
    createdAt: 1,
    updatedAt: 2,
    tasks: {
      '1': { taskId: 1, state: 'accepted', attempts: 1, dependsOn: [] },
      '2': { taskId: 2, state: 'running', attempts: 1, dependsOn: [1] },
    },
    ...patch,
  };
}
for (const [status, tone, label] of [
  ['running', 'success', 'Working'],
  ['completed', 'success', 'Complete'],
  ['cancel_pending', 'warning', 'Cancelling'],
  ['failed', 'error', 'Failed'],
  ['paused', 'muted', 'Paused'],
  ['cancelled', 'muted', 'Cancelled'],
  ['completed_with_findings', 'warning', 'Complete with findings'],
] as const) {
  test(`strip reports ${status} before stale task state`, () => {
    const view = progressView(run({ status }), undefined, true);
    assert.equal(view.tone, tone);
    assert.match(view.label, new RegExp(label));
    if (status !== 'running')
      assert.doesNotMatch(view.detail, /Task 2.*running/i);
  });
}
for (const [patch, label] of [
  [{ localOperationActive: true }, 'Pausing'],
  [
    {
      activeOperation: {
        operationId: 'op',
        service: 'bridge' as const,
        kind: 'implementation' as const,
        processTreeExited: true,
      },
    },
    'Paused',
  ],
  [
    {
      activeOperation: {
        operationId: 'op',
        service: 'bridge' as const,
        kind: 'implementation' as const,
        launchFenced: true,
      },
    },
    'Paused',
  ],
] as const)
  test(`paused strip reflects actual outstanding work: ${JSON.stringify(patch)}`, () => {
    assert.match(
      progressView(run({ status: 'paused', ...patch }), undefined, true).label,
      new RegExp(label),
    );
  });
test('strip removes bidi controls but preserves emoji joiners', () => {
  const view = progressView(run({ planPath: '/repo/test\u202e-👩‍💻.md' }));
  assert.equal(view.title.includes('\u202e'), false);
  assert.ok(view.title.includes('👩‍💻'));
});
for (const [runWake, expected] of [
  [undefined, 25_000],
  [0, 25_000],
  [900_000, 25_000],
  [1_030_000, 30_000],
] as const)
  test(`retry tone uses the effective future wake with run wake ${runWake}`, () => {
    const view = progressView(
      run({
        ...(runWake === undefined ? {} : { nextAttemptAt: runWake }),
        tasks: {
          '1': {
            taskId: 1,
            dependsOn: [],
            state: 'retry_wait',
            attempts: 1,
            nextAttemptAt: 1_050_000,
          },
          '2': {
            taskId: 2,
            dependsOn: [],
            state: 'retry_wait',
            attempts: 1,
            nextAttemptAt: 1_025_000,
          },
        },
      }),
      1_000_000,
      true,
    );
    assert.equal(view.tone, 'warning');
    assert.match(view.label, /Retry scheduled/);
    assert.match(view.detail, new RegExp(`Retry in ${expected / 1000}s`));
  });
test('unknown launch is amber, never healthy from controller heartbeat', () => {
  const view = progressView(
    run({
      needsAttention: true,
      activeOperation: {
        operationId: 'op',
        service: 'bridge',
        kind: 'implementation',
        lastObservedState: 'unknown_launch',
      },
    }),
    undefined,
    true,
  );
  assert.equal(view.tone, 'warning');
  assert.match(view.label, /unknown/i);
});
test('all tasks accepted does not complete required review', () => {
  const view = progressView(
    run({
      stage: 'comprehensive_review',
      tasks: {
        '1': { taskId: 1, state: 'accepted', attempts: 1, dependsOn: [] },
      },
    }),
    undefined,
    true,
  );
  assert.equal(view.accepted, 1);
  assert.match(view.label, /Reviewing/);
  assert.doesNotMatch(view.label, /Complete/);
});
test('strip is compact, terminal-safe and status-colors the progress bar', () => {
  for (const width of [1, 8, 20, 40, 80, 140]) {
    const colors: string[] = [];
    const lines = renderProgressStrip(
      run({ planPath: '/repo/测试-👩‍💻-\u001b[31m.md' }),
      width,
      (tone, text) => {
        colors.push(tone);
        return text;
      },
      undefined,
      true,
    );
    assert.ok(lines.length <= 3);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(colors.includes('success'));
    assert.ok(colors.includes('text'));
    assert.doesNotMatch(
      lines.join('\n'),
      /Owner:|heartbeat|ENOENT|Lifetime:|\[31m/,
    );
  }
});
for (const status of [
  'starting',
  'running',
  'cancel_pending',
  'skip_pending',
] as const)
  test(`unpolled ${status} is explicitly a snapshot by default`, () => {
    const view = progressView(run({ status }));
    assert.equal(view.tone, 'warning');
    assert.match(view.label, /Snapshot/);
    assert.match(view.detail, /Saved:/);
    assert.match(view.warning ?? '', /No live updates/);
  });
test('unpolled paused cleanup is a snapshot but settled pause and completion retain their states', () => {
  assert.match(
    progressView(run({ status: 'paused', localOperationActive: true })).label,
    /Snapshot/,
  );
  assert.match(progressView(run({ status: 'paused' })).label, /Paused/);
  assert.equal(progressView(run({ status: 'completed' })).tone, 'success');
});
test('visibility survives restoration and late updates cannot undo hiding or dismissal', () => {
  const first = new RunPresentation();
  first.remember(run());
  first.hide();
  const restored = new RunPresentation(first.preferences());
  restored.remember(run({ revision: 2 }));
  assert.equal(restored.current(), undefined);
  restored.show('run-1');
  assert.equal(restored.current()?.id, 'run-1');
  restored.clear();
  restored.remember(run({ revision: 3 }));
  assert.equal(restored.current(), undefined);
  const next = new RunPresentation(restored.preferences());
  next.remember(run({ revision: 4 }));
  assert.equal(next.current(), undefined);
  next.remember(run({ id: 'run-2', revision: 1 }));
  assert.equal(next.current()?.id, 'run-2');
});
test('stale projection does not replace newer cancellation state; removed records disappear', () => {
  const view = new RunPresentation();
  view.remember(run({ revision: 3, status: 'cancel_pending' }));
  view.remember(run({ revision: 2, status: 'running' }));
  assert.equal(view.current()?.status, 'cancel_pending');
  view.reconcile([]);
  assert.equal(view.current(), undefined);
  view.remember(run({ revision: 2 }));
  view.reconcile([run({ revision: 2 })]);
  assert.equal(view.current(), undefined);
});
test('explicit selection is deterministic and clear only dismisses that run', () => {
  const view = new RunPresentation();
  view.reconcile([run({ id: 'a' }), run({ id: 'b' })]);
  view.show('b');
  view.remember(run({ id: 'a', revision: 2, updatedAt: 4 }));
  assert.equal(view.current()?.id, 'b');
  view.clear();
  assert.equal(view.current()?.id, 'a');
  assert.throws(() => view.show('not-found'), /not found/);
});
