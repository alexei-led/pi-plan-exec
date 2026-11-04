import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { test } from 'vitest';
import {
  goalStatusText,
  parseGoalCommand,
  selectContextualRun,
} from '../src/index.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';

function goal(id: string, updatedAt: number): PlanExecRun {
  return {
    schemaVersion: 1,
    id,
    repositoryRoot: '/repo',
    worktreeCwd: '/repo',
    branch: 'feature',
    defaultBranch: 'main',
    status: 'failed',
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
    createdAt: 1,
    updatedAt,
    goal: {
      text: 'Deliver the fixture',
      hash: 'hash',
      iteration: 1,
      maxTurns: 5,
      noProgress: 0,
    },
    error: 'Credentials expired',
  };
}

test('goal controls forward the shared recovery flags without dropping identity', () => {
  assert.deepEqual(parseGoalCommand('inspect run-1'), {
    action: 'inspect',
    id: 'run-1',
  });
  assert.deepEqual(parseGoalCommand('resume run-1 --model current'), {
    action: 'resume',
    id: 'run-1',
    options: ['--model', 'current'],
  });
  assert.deepEqual(parseGoalCommand('cancel run-1 --force'), {
    action: 'cancel',
    id: 'run-1',
    options: ['--force'],
  });
  assert.throws(() => parseGoalCommand('resume --unknown'), /Usage/);
  assert.throws(() => parseGoalCommand('cancel --force'), /Usage/);
});

test('goal diagnostics retain the common failure reason and recovery guidance', () => {
  const text = goalStatusText(goal('run-1', 1));
  assert.match(text, /Credentials expired/);
  assert.match(text, /turn: 1\/5/);
  assert.match(text, /next:|action:/);
});

test('explicit selection wins over newer runs and ambiguity never silently chooses', async () => {
  const first = goal('first', 1);
  const second = goal('second', 2);
  const ctx = { cwd: '/repo', hasUI: false } as ExtensionContext;
  assert.equal(
    (await selectContextualRun([first, second], 'cancel', ctx, first.id)).id,
    first.id,
  );
  await assert.rejects(
    selectContextualRun([first, second], 'cancel', ctx),
    /Multiple runs/,
  );
  await assert.rejects(
    selectContextualRun([second], 'cancel', ctx, first.id),
    /selected run cannot/,
  );
});
