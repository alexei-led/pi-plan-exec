import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test } from 'vitest';
import { shouldAutoRestoreRun } from '../src/index.js';
import { RunRegistry } from '../src/registry.js';
import { RunPresentation } from '../src/run-view.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../src/types.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'force-stop-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const registry = new RunRegistry(directory);
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: join(directory, 'missing'),
    planPath: join(directory, 'missing', 'plan.md'),
    planHash: 'hash',
    worktreeCwd: join(directory, 'missing'),
    branch: 'feature',
    defaultBranch: 'main',
    status: 'cancel_pending',
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
    userStopped: true,
    activeOperation: {
      operationId: 'legacy',
      requestDigest: 'digest',
      service: 'bridge',
      kind: 'implementation',
      stopAcknowledged: true,
      lastObservedState: 'unknown_launch',
    },
  });
  return { directory, registry, run };
}

test('force abandonment ends management without inventing retirement or freeing an unknown checkout', async () => {
  const { registry, run } = await fixture();
  const abandoned = await registry.abandon(run.id, 'owner');
  assert.equal(abandoned.status, 'abandoned');
  assert.deepEqual(abandoned.activeOperation, run.activeOperation);
  assert.equal(shouldAutoRestoreRun(abandoned, 'owner'), false);
  assert.equal(new RunPresentation().current(), undefined);
  const view = new RunPresentation();
  view.remember(abandoned);
  view.show(run.id);
  assert.equal(view.current(), undefined);
  const restarted = await registry.get(run.id);
  assert.equal(restarted?.status, 'abandoned');
  await assert.rejects(
    () => registry.assertExclusive({ ...run, id: 'another-run' }),
    /already exists/,
  );
  await assert.rejects(() => registry.remove(run.id), /unconfirmed|unknown/);
  await assert.rejects(
    () =>
      registry.update({ ...abandoned, status: 'running', userStopped: false }),
    /Invalid plan-exec/,
  );
  assert.equal((await registry.update(run)).status, 'abandoned');
  assert.equal(
    (await registry.abandon(run.id, 'owner')).updatedAt,
    abandoned.updatedAt,
  );
  assert.equal(
    JSON.parse(await readFile(registry.abandonmentBackupPath(run.id), 'utf8'))
      .status,
    'cancel_pending',
  );
});

test('force abandonment refuses a live foreign controller without changing state', async () => {
  const { registry, run } = await fixture();
  const leased = await registry.update({
    ...run,
    lease: {
      sessionId: 'other',
      hostname: hostname(),
      pid: process.pid,
      heartbeatAt: Date.now(),
    },
  });
  await assert.rejects(
    () => registry.abandon(run.id, 'owner'),
    /another active Pi session/,
  );
  assert.equal((await registry.get(run.id))?.updatedAt, leased.updatedAt);
});

for (const lease of [
  undefined,
  { sessionId: 'old', pid: 2147483647, heartbeatAt: 0, hostname: hostname() },
  { sessionId: 'old', pid: 2147483647, heartbeatAt: 0 },
]) {
  test(`force abandonment accepts claimable ownership ${JSON.stringify(lease)}`, async () => {
    const { registry, run } = await fixture();
    if (lease) await registry.update({ ...run, lease });
    assert.equal((await registry.abandon(run.id, 'owner')).status, 'abandoned');
  });
}

test('foreign hostname stays protected even with an expired heartbeat and missing pid', async () => {
  const { registry, run } = await fixture();
  await registry.update({
    ...run,
    lease: {
      sessionId: 'old',
      pid: 2147483647,
      heartbeatAt: 0,
      hostname: 'remote.invalid',
    },
  });
  await assert.rejects(
    () => registry.abandon(run.id, 'owner'),
    /another active/,
  );
});

test('backup failure leaves management state unchanged', async () => {
  const { directory, registry, run } = await fixture();
  await writeFile(join(directory, '.abandoned'), 'not a directory');
  await assert.rejects(() => registry.abandon(run.id, 'owner'));
  assert.equal((await registry.get(run.id))?.status, 'cancel_pending');
});

test('failed final backup never deletes the abandoned active record', async () => {
  const { registry, run, directory } = await fixture();
  const safe = { ...run };
  delete safe.activeOperation;
  await registry.update(safe);
  const abandoned = await registry.abandon(run.id, 'owner');
  await mkdir(join(directory, '.abandoned', run.id, 'run.json'));
  await assert.rejects(() => registry.cleanupAbandoned(abandoned));
  assert.equal((await registry.get(run.id))?.status, 'abandoned');
});

test('abandonment rejects malformed persisted metadata', async () => {
  const { registry, run } = await fixture();
  await writeFile(
    registry.authorizationPath(run.id),
    JSON.stringify({ ...run, status: 'abandoned' }),
  );
  await assert.rejects(() => registry.get(run.id), /Invalid plan-exec/);
});

for (const status of [
  'failed',
  'cancel_pending',
  'paused',
  'cancelled',
  'completed',
] as const) {
  test(`failed-only unknown operation retains ownership after force from ${status}`, async () => {
    const { registry, run } = await fixture();
    assert.ok(run.activeOperation);
    const legacy = { ...run, status, failedOperation: run.activeOperation };
    delete legacy.activeOperation;
    await registry.update(legacy);
    const abandoned = await registry.abandon(run.id, 'owner');
    assert.equal(abandoned.activeOperation?.operationId, 'legacy');
    assert.equal(await registry.cleanupAbandoned(abandoned), false);
    await assert.rejects(
      () => registry.assertExclusive({ ...run, id: 'another' }),
      /already exists/,
    );
  });
}

test('eligible cleanup archives then removes only the exact registry directory', async () => {
  const { directory, registry, run } = await fixture();
  const safe = { ...run };
  delete safe.activeOperation;
  await registry.update(safe);
  await mkdir(run.worktreeCwd);
  await writeFile(join(run.worktreeCwd, 'user.txt'), 'keep');
  const abandoned = await registry.abandon(run.id, 'owner');
  await writeFile(join(directory, run.id, 'recovery.log'), 'old diagnostics');
  assert.equal(await registry.cleanupAbandoned(abandoned), true);
  assert.equal(await registry.get(run.id), undefined);
  assert.equal(
    await readFile(join(run.worktreeCwd, 'user.txt'), 'utf8'),
    'keep',
  );
  assert.equal((await registry.abandon(run.id, 'owner')).status, 'abandoned');
});

test('force abandonment revokes the current controller even while its tick lock is held', async () => {
  const { registry, run } = await fixture();
  await registry.claim(run, 'owner');
  await registry.withControllerLock(run.id, async () => {
    const abandoned = await registry.abandon(run.id, 'owner');
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(abandoned.lease, undefined);
    assert.equal(abandoned.stopGeneration, 1);
  });
});
