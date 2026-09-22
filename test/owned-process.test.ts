import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { onTestFinished, test } from 'vitest';
import {
  cancelOwnedProcess,
  launchOwnedProcess,
  observeOwnedProcess,
  prepareOwnedProcess,
} from '../src/owned-process.js';

async function workdir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'owned-process-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

function request(directory: string, cwd: string) {
  return {
    operationDirectory: directory,
    argv: [process.execPath, '-e', '0'] as [string, ...string[]],
    cwd,
    env: process.env as Record<string, string>,
    lifetime: { kind: 'unbounded' as const },
  };
}

test('a failed spawn is recorded and a later attempt can launch', async () => {
  const root = await workdir();
  const directory = join(root, 'operation');
  const missing = join(root, 'missing-directory');

  const failed = await launchOwnedProcess(request(directory, missing));
  assert.equal(failed.status, 'unknown');
  assert.match(String(failed.reason), /did not report a pid|did not launch/);
  assert.ok(await readFile(join(directory, 'launch-failed.json'), 'utf8'));
  await assert.rejects(
    readFile(join(directory, 'launching.json'), 'utf8'),
    /ENOENT/,
  );

  // The claim was released, so a later attempt reaches the spawn again
  // instead of being stuck on an unresolved claim.
  const retried = await launchOwnedProcess(request(directory, missing));
  assert.equal(retried.status, 'unknown');
  assert.equal((await observeOwnedProcess(directory)).status, 'unknown');
  await assert.rejects(
    readFile(join(directory, 'launching.json'), 'utf8'),
    /ENOENT/,
  );
});

test('an unresolved launch claim is fenced instead of never-started', async () => {
  const root = await workdir();
  const directory = join(root, 'operation');
  const binding = await prepareOwnedProcess(request(directory, root));
  await writeFile(
    join(directory, 'launching.json'),
    JSON.stringify({
      version: 1,
      operationId: binding.operationId,
      requestDigest: binding.requestDigest,
      claimedAt: Date.now(),
    }),
  );

  const fresh = await observeOwnedProcess(directory);
  assert.equal(fresh.status, 'pending');

  const stale = await cancelOwnedProcess(directory, {
    deadlineMs: 100,
    cancelled: true,
  });
  assert.equal(stale.status, 'pending');

  await writeFile(
    join(directory, 'launching.json'),
    JSON.stringify({
      version: 1,
      operationId: binding.operationId,
      requestDigest: binding.requestDigest,
      claimedAt: Date.now() - 10 * 60_000,
    }),
  );
  const fenced = await observeOwnedProcess(directory);
  assert.equal(fenced.status, 'unknown');
  assert.match(String(fenced.reason), /unresolved/);
});

test('a synchronous spawn throw releases the claim and stays retryable', async () => {
  const root = await workdir();
  const directory = join(root, 'operation');
  const fileCwd = join(root, 'file-cwd');
  await writeFile(fileCwd, 'not a directory');

  const failed = await launchOwnedProcess(request(directory, fileCwd));
  assert.equal(failed.status, 'unknown');
  await readFile(join(directory, 'launch-failed.json'), 'utf8');
  await assert.rejects(
    readFile(join(directory, 'launching.json'), 'utf8'),
    /ENOENT/,
  );
  const retried = await launchOwnedProcess(request(directory, fileCwd));
  assert.equal(retried.status, 'unknown');
});

test('a retired operation with a stale claim still cancels as retired', async () => {
  const root = await workdir();
  const directory = join(root, 'operation');
  await launchOwnedProcess(request(directory, root));

  let observation = await observeOwnedProcess(directory);
  const deadline = Date.now() + 10_000;
  while (observation.status === 'running' && Date.now() < deadline) {
    await delay(20);
    observation = await observeOwnedProcess(directory);
  }
  assert.equal(observation.status, 'retired');

  // Recreate a stale claim to simulate a launcher that never released it.
  await writeFile(
    join(directory, 'launching.json'),
    JSON.stringify({ version: 1, claimedAt: Date.now() - 10 * 60_000 }),
  );
  const cancelled = await cancelOwnedProcess(directory, {
    deadlineMs: 100,
    cancelled: true,
  });
  assert.equal(cancelled.status, 'retired');
  assert.deepEqual(cancelled.proof, observation.proof);
});

test('retirement is persisted and repeated cancellation stops signalling', async () => {
  const root = await workdir();
  const directory = join(root, 'operation');
  await launchOwnedProcess(request(directory, root));

  let observation = await observeOwnedProcess(directory);
  const deadline = Date.now() + 10_000;
  while (observation.status === 'running' && Date.now() < deadline) {
    await delay(20);
    observation = await observeOwnedProcess(directory);
  }
  assert.equal(observation.status, 'retired');
  assert.equal(observation.proof?.kind, 'process-group-retired');
  assert.ok(await readFile(join(directory, 'retired.json'), 'utf8'));

  const cancelled = await cancelOwnedProcess(directory, { deadlineMs: 100 });
  assert.equal(cancelled.status, 'retired');
  assert.deepEqual(cancelled.proof, observation.proof);
});
