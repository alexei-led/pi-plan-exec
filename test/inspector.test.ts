import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { test } from 'vitest';
import {
  executionPreviewText,
  inspectorSections,
  inspectRun,
} from '../src/inspector.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';

const run: PlanExecRun = {
  schemaVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  repositoryRoot: '/repo',
  worktreeCwd: '/repo',
  planPath: '/repo/plan.md',
  planHash: 'hash',
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
  config: DEFAULT_FROZEN_RUN_CONFIG,
  createdAt: 1,
  updatedAt: 2,
};

test('start preview names worker and reviewer models before allocation', () => {
  const text = executionPreviewText({
    kind: 'plan',
    cwd: '/repo',
    branch: 'feature',
    config: {
      ...DEFAULT_FROZEN_RUN_CONFIG,
      workerModel: 'fixture/worker',
      reviewerModel: 'fixture/reviewer',
    },
  });
  assert.match(text, /Worker: worker · fixture\/worker/);
  assert.match(
    text,
    /Review: required · subagent · plan-exec-reviewer · fixture\/reviewer/,
  );
});

test('non-TUI inspection returns textual evidence without opening a dialog', async () => {
  const ctx = {
    mode: 'rpc',
    ui: { select: () => assert.fail('No TUI dialog') },
  } as unknown as ExtensionContext;
  assert.deepEqual(await inspectRun(ctx, run, 'exact evidence', ['pause']), {
    kind: 'text',
    text: 'exact evidence',
  });
});

test('inspector actions name the exact run and cancellation needs confirmation', async () => {
  let confirmedId = '';
  const ctx = {
    mode: 'tui',
    ui: {
      select: async (title: string, options: string[]) => {
        assert.match(title, new RegExp(run.id));
        assert.ok(options.includes('Pause this run'));
        return 'Cancel this run';
      },
      confirm: async (_title: string, text: string) => {
        confirmedId = text;
        return false;
      },
    },
  } as unknown as ExtensionContext;
  assert.deepEqual(
    await inspectRun(ctx, run, 'evidence', ['pause', 'cancel']),
    { kind: 'closed' },
  );
  assert.match(confirmedId, new RegExp(run.id));
  ctx.ui.confirm = async () => true;
  assert.deepEqual(
    await inspectRun(ctx, run, 'evidence', ['pause', 'cancel']),
    { kind: 'action', action: 'cancel' },
  );
});

test('inspector details sanitize controls and do not claim requested limits are enforced', () => {
  const sections = inspectorSections(
    { ...run, error: 'Denied\u001b[31m\u202e' },
    'owned evidence',
  );
  assert.equal(sections.Overview?.includes('\u001b'), false);
  assert.equal(sections.Overview?.includes('\u202e'), false);
  assert.match(sections['Checks and review'] ?? '', /not enforced/);
  assert.equal(sections['Ownership evidence'], 'owned evidence');
});

test('Escape and unknown selections never return an action', async () => {
  for (const choice of [undefined, 'unknown']) {
    const ctx = {
      mode: 'tui',
      ui: { select: async () => choice },
    } as unknown as ExtensionContext;
    assert.deepEqual(await inspectRun(ctx, run, 'evidence', ['cancel']), {
      kind: 'closed',
    });
  }
});
