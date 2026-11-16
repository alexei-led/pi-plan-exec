import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test } from 'vitest';
import { removeRunProgress } from '../src/cancel-cleanup.js';
import { shouldAutoRestoreRun } from '../src/index.js';
import { RunRegistry } from '../src/registry.js';
import { acquireLock } from '../src/registry-lock.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cancel-cleanup-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status,
    0,
  );
  const progressPath = join(root, '.ralphex', 'progress', 'progress-plan.txt');
  await mkdir(join(root, '.ralphex', 'progress'), { recursive: true });
  await writeFile(progressPath, 'progress');
  const registry = new RunRegistry(join(root, 'runs'));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    worktreeCwd: root,
    planPath: join(root, 'plan.md'),
    planHash: 'hash',
    branch: 'feature',
    defaultBranch: 'main',
    status: 'cancelled',
    stage: 'implementation',
    userStopped: true,
    displayDismissed: true,
    cleanupRequested: true,
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
    progressPath,
  });
  return { root, registry, run, progressPath };
}

test('cancel cleanup resumes after a restart between retirement and deletion', async () => {
  const { registry, run, progressPath } = await fixture();
  assert.equal(shouldAutoRestoreRun(run, 'new-session'), true);
  assert.equal(await registry.remove(run.id, { cancelled: true }), true);
  assert.equal(await registry.get(run.id), undefined);
  await assert.rejects(access(progressPath), { code: 'ENOENT' });
  assert.equal(await registry.remove(run.id, { cancelled: true }), false);
});

for (const ownership of ['worker', 'local', 'lease'] as const)
  test(`cancel cleanup keeps evidence while ${ownership} ownership is unconfirmed`, async () => {
    const { registry, run, progressPath } = await fixture();
    const operation = {
      operationId: 'op',
      service: 'bridge' as const,
      kind: 'implementation' as const,
    };
    const patches: Record<typeof ownership, Partial<PlanExecRun>> = {
      worker: { activeOperation: operation },
      local: { localOperationActive: true },
      lease: {
        lease: {
          sessionId: 'live-owner',
          pid: process.pid,
          heartbeatAt: Date.now(),
        },
      },
    };
    await registry.update({ ...run, ...patches[ownership] });
    if (ownership === 'local') {
      await mkdir(registry.localOperationsPath(run.id), { recursive: true });
      await writeFile(
        join(registry.localOperationsPath(run.id), `${'a'.repeat(64)}.json`),
        '{}',
      );
    }
    await assert.rejects(
      registry.remove(run.id, { cancelled: true }),
      /ownership|quarantined|live lease/,
    );
    assert.ok(await registry.get(run.id));
    assert.equal(await readFile(progressPath, 'utf8'), 'progress');
  });

test('cancel cleanup cannot delete beneath an active controller lock', async () => {
  const { root, registry, run, progressPath } = await fixture();
  const lock = await acquireLock(
    join(root, 'runs', '.locks', `${run.id}.controller.lock`),
  );
  try {
    await assert.rejects(
      registry.remove(run.id, { cancelled: true }),
      /another controller/,
    );
    assert.equal(await readFile(progressPath, 'utf8'), 'progress');
  } finally {
    await lock.release();
  }
  assert.equal(await registry.remove(run.id, { cancelled: true }), true);
});

for (const target of ['file', 'directory'] as const)
  test(`progress cleanup refuses a symlinked ${target}`, async () => {
    const { root, registry, run, progressPath } = await fixture();
    const outside = join(root, 'outside');
    if (target === 'file') {
      await writeFile(outside, 'keep');
      await rm(progressPath);
      await symlink(outside, progressPath);
    } else {
      await mkdir(outside);
      await writeFile(join(outside, 'progress-plan.txt'), 'keep');
      await rm(join(root, '.ralphex', 'progress'), { recursive: true });
      await symlink(outside, join(root, '.ralphex', 'progress'));
    }
    await assert.rejects(
      registry.remove(run.id, { cancelled: true }),
      /symbolic links/,
    );
    assert.ok(await registry.get(run.id));
    assert.equal(
      await readFile(
        target === 'file' ? outside : join(outside, 'progress-plan.txt'),
        'utf8',
      ),
      'keep',
    );
  });

test('progress cleanup preserves tracked files and shared progress', async () => {
  const { root, registry, run, progressPath } = await fixture();
  await removeRunProgress(run, [run, { ...run, id: 'other' }]);
  assert.equal(await readFile(progressPath, 'utf8'), 'progress');
  assert.equal(
    spawnSync('git', ['add', '-f', progressPath], { cwd: root }).status,
    0,
  );
  assert.equal(await registry.remove(run.id, { cancelled: true }), true);
  assert.equal(await readFile(progressPath, 'utf8'), 'progress');
});

test('progress cleanup refuses an unexpected path and keeps the run retryable', async () => {
  const { root, registry, run } = await fixture();
  const source = join(root, 'source.txt');
  await writeFile(source, 'keep');
  await registry.update({ ...run, progressPath: source });
  await assert.rejects(
    registry.remove(run.id, { cancelled: true }),
    /executor-owned/,
  );
  assert.ok(await registry.get(run.id));
  assert.equal(await readFile(source, 'utf8'), 'keep');
});
