import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { appendProgress, appendProgressOnce } from '../src/progress.js';
import type { PlanExecRun } from '../src/types.js';

test('logging after worktree removal never recreates execution directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'progress-missing-'));
  try {
    const worktreeCwd = join(root, 'worktree');
    const progressPath = join(worktreeCwd, '.ralphex', 'progress', 'run.txt');
    await mkdir(join(worktreeCwd, '.ralphex', 'progress'), { recursive: true });
    const run = { worktreeCwd, progressPath } as PlanExecRun;
    await rm(worktreeCwd, { recursive: true });
    await appendProgress(run, 'recovery waiting');
    await appendProgressOnce(run, 'stopped');
    await assert.rejects(access(worktreeCwd), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
