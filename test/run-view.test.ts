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
for (const goal of [
  undefined,
  {
    text: 'Release the project',
    hash: 'goal',
    iteration: 4,
    maxTurns: 20,
    noProgress: 0,
  },
])
  test(`a resolved ${goal ? 'goal' : 'plan'} warning is not resurrected by a saved attention flag`, () => {
    const view = progressView(
      run({ needsAttention: true, ...(goal ? { goal } : {}) }),
      1_000,
      true,
    );
    assert.equal(view.tone, 'success');
    assert.match(view.label, /Working/);
    assert.doesNotMatch(
      renderProgressStrip(
        run({ needsAttention: true, ...(goal ? { goal } : {}) }),
        140,
        undefined,
        1_000,
        true,
      ).join('\n'),
      /attention|blocker/i,
    );
  });

for (const goal of [
  undefined,
  {
    text: 'Release the project',
    hash: 'goal',
    iteration: 4,
    maxTurns: 20,
    noProgress: 0,
  },
])
  test(`a blocked ${goal ? 'goal' : 'plan'} pause explains the reason and recovery command`, () => {
    const held = run({
      status: 'paused',
      ...(goal ? { goal } : {}),
      blocked: {
        reason: 'Approval UI unavailable\u001b[31m\nRestore the UI\u202e',
      },
      needsAttention: true,
    });
    const view = progressView(held, 1_000, true);
    assert.equal(view.tone, 'warning');
    assert.match(view.label, /Blocked/);
    assert.match(view.detail, /Approval UI unavailable.*Restore the UI/);
    assert.equal(view.detail, 'Approval UI unavailable Restore the UI');
    assert.match(
      view.warning ?? '',
      new RegExp(`/${goal ? 'goal' : 'exec'} resume run-1`),
    );
  });

test('a current observation failure shows its reason and a safe inspection action', () => {
  const view = progressView(
    run({
      activeOperation: {
        operationId: 'op',
        service: 'bridge',
        kind: 'implementation',
        lastStatusError: 'Native runtime disconnected',
      },
    }),
    1_000,
    true,
  );
  assert.equal(view.tone, 'warning');
  assert.match(view.detail, /Native runtime disconnected/);
  assert.match(view.warning ?? '', /\/exec status run-1/);
  assert.doesNotMatch(view.warning ?? '', /resume/);
});

test('routine goal continuation is healthy, not a failed-attempt warning', () => {
  const view = progressView(
    run({
      goal: {
        text: 'Release',
        hash: 'goal',
        iteration: 4,
        maxTurns: 20,
        noProgress: 0,
      },
      nextAttemptAt: 6_000,
      tasks: {},
    }),
    1_000,
    true,
  );
  assert.equal(view.tone, 'success');
  assert.match(view.label, /Continuing/);
  assert.match(view.detail, /5s/);
});

test('a past retry deadline does not hide a current recovery reason', () => {
  const view = progressView(
    run({
      error: 'Required check failed',
      needsAttention: true,
      nextAttemptAt: 500,
    }),
    1_000,
    true,
  );
  assert.equal(view.tone, 'warning');
  assert.match(view.detail, /Required check failed/);
  assert.match(view.warning ?? '', /\/exec status run-1/);
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
test('an observed operation pause is not working or proof of a question', () => {
  const operation = {
    operationId: 'op',
    service: 'bridge',
    kind: 'implementation',
    lastObservedState: 'paused',
  } as const;
  const paused = run({ activeOperation: operation });
  for (const observing of [true, false]) {
    const view = progressView(paused, 1_000, observing);
    assert.equal(view.tone, 'warning');
    assert.match(view.label, /Operation paused/);
    assert.doesNotMatch(view.detail, /implementing|supervisor|reply/i);
    assert.equal(view.label.includes('Snapshot'), !observing);
  }
  assert.match(
    progressView(
      {
        ...paused,
        activeOperation: { ...operation, lastStatusError: 'offline' },
      },
      1_000,
      true,
    ).label,
    /unknown/i,
  );
});
for (const state of ['running', 'verifying'] as const)
  test(`active ${state} work stays visible alongside an external wait`, () => {
    const view = progressView(
      run({
        needsAttention: true,
        tasks: {
          '1': {
            taskId: 1,
            state: 'waiting_external',
            attempts: 1,
            dependsOn: [],
          },
          '2': { taskId: 2, state, attempts: 1, dependsOn: [] },
        },
      }),
      1_000,
      true,
    );
    assert.match(view.label, /Working.*1 task waiting/);
    assert.match(
      view.detail,
      new RegExp(
        `Task 2.*${state === 'running' ? 'implementing' : 'verifying'}`,
      ),
    );
    assert.equal(view.tone, 'warning');
  });
test('an external wait does not necessarily require human input', () => {
  const view = progressView(
    run({
      tasks: {
        '1': {
          taskId: 1,
          state: 'waiting_external',
          attempts: 1,
          dependsOn: [],
        },
      },
    }),
    1_000,
    true,
  );
  assert.match(view.label, /Waiting on prerequisite/);
  assert.doesNotMatch(view.label, /Needs input/);
});
test('snapshot labels retain cancellation and pending pause intent', () => {
  for (const [patch, expected] of [
    [{ status: 'cancel_pending' }, /Cancelling.*Snapshot/],
    [{ status: 'paused', localOperationActive: true }, /Pausing.*Snapshot/],
    [{ status: 'skip_pending' }, /Stopping optional stage.*Snapshot/],
  ] as const) {
    const view = progressView(run(patch));
    assert.match(view.label, expected);
    assert.equal(view.tone, 'warning');
    assert.match(view.warning ?? '', /No live updates/);
  }
});
test('a failed controller probe keeps independent saved blocker evidence visible', () => {
  const held = run({
    tasks: {
      '1': {
        taskId: 1,
        dependsOn: [],
        attempts: 1,
        state: 'waiting_external',
        reason: 'Approval required',
      },
    },
  });
  const view = progressView(held, 1_000, false, 'Controller disconnected');
  assert.match(view.label, /Waiting on prerequisite.*Snapshot/);
  assert.match(view.detail, /Saved: Approval required/);
  assert.match(view.warning ?? '', /Controller disconnected/);
  assert.match(view.warning ?? '', /\/exec status run-1/);
  const strip = renderProgressStrip(
    held,
    160,
    undefined,
    1_000,
    false,
    'Controller disconnected',
  ).join('\n');
  assert.match(strip, /Approval required/);
  assert.match(strip, /Controller disconnected/);
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
test('stale snapshot does not replace newer cancellation state; removed records disappear', () => {
  const view = new RunPresentation();
  view.remember(run({ revision: 3, status: 'cancel_pending' }));
  view.remember(run({ revision: 2, status: 'running' }));
  assert.equal(view.current(), undefined);
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

for (const status of ['cancel_pending', 'cancelled'] as const)
  test(`cancelled runs stay dismissed across reload, show and stale updates: ${status}`, () => {
    const cancelled = run({ status, revision: 2 });
    const view = new RunPresentation({
      hidden: false,
      dismissed: [],
      selected: cancelled.id,
    });
    view.reconcile([cancelled]);
    assert.equal(view.current(), undefined);
    view.show(cancelled.id);
    assert.equal(view.current(), undefined);
    view.remember(run({ revision: 1 }));
    assert.equal(view.current(), undefined);
    view.remember(
      run({ revision: 3, status: 'failed', displayDismissed: true }),
    );
    assert.equal(view.current(), undefined);
    const restored = new RunPresentation();
    restored.reconcile([cancelled]);
    assert.equal(restored.current(), undefined);
    restored.remember(run({ id: 'new-run' }));
    assert.equal(restored.current()?.id, 'new-run');
  });
