import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { PlanExecController } from '../src/controller.js';
import { parseResumeArguments } from '../src/index.js';
import { NativeRuntimeClient } from '../src/native-runtime.js';
import { parsePlan } from '../src/plan.js';
import { RunRegistry } from '../src/registry.js';
import { required } from '../src/required.js';
import { DEFAULT_FROZEN_RUN_CONFIG, type PlanExecRun } from '../src/types.js';
import { writeLegacyJournal } from './fixtures/legacy-journal.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legacy-import-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const registry = new RunRegistry(join(root, 'runs'));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    worktreeCwd: root,
    planPath: join(root, 'plan.md'),
    planHash: 'original',
    branch: 'feature',
    defaultBranch: 'main',
    status: 'paused',
    userStopped: true,
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
    activeOperation: {
      operationId: 'original-operation',
      requestDigest: 'original-digest',
      service: 'bridge',
      kind: 'implementation',
      params: { frozen: 'original' },
    },
  });
  const calls: unknown[] = [];
  const client = new NativeRuntimeClient(
    {
      on() {
        return () => {};
      },
      emit(_name, value) {
        calls.push(value);
      },
    },
    registry,
    () => {
      throw new Error('Import must not invoke runtime or workspace');
    },
  );
  onTestFinished(() => client.dispose());
  const refuse = async () => {
    throw new Error('Import must not launch');
  };
  const controller = new PlanExecController(
    registry,
    client,
    {
      start: refuse,
      status: refuse,
      result: refuse,
      adopt: refuse,
      cancel: refuse,
    },
    refuse,
  );
  const snapshot = join(root, 'offline.sqlite');
  const binding = {
    operationId: 'original-operation',
    ownerRunId: run.id,
    requestDigest: 'original-digest',
  };
  return { root, registry, run, calls, controller, snapshot, binding };
}

test('common resume parses only one explicit absolute legacy snapshot path', () => {
  expect(
    parseResumeArguments([
      'run',
      '--legacy-journal',
      '/isolated/offline.sqlite',
    ]).legacyJournal,
  ).toBe('/isolated/offline.sqlite');
  expect(
    parseResumeArguments([
      'run',
      '--legacy-journal',
      '"/isolated/two  spaces.sqlite"',
    ]).legacyJournal,
  ).toBe('/isolated/two  spaces.sqlite');
  for (const args of [
    ['--legacy-journal'],
    ['--legacy-journal', 'relative.sqlite'],
    ['--legacy-journal', '/one', '--legacy-journal', '/two'],
  ])
    expect(() => parseResumeArguments(args)).toThrow(/Usage/);
});

test('legacy snapshot import preserves original intent, cancellation and read-only source bytes', async () => {
  const f = await fixture();
  await writeLegacyJournal(f.snapshot, f.binding, {
    cancel_requested: 1,
    stop_receipt_state: 'stopping',
  });
  const before = await readFile(f.snapshot);
  const imported = await f.controller.importLegacyJournal(
    f.run.id,
    'owner',
    f.snapshot,
    0,
  );
  expect(imported.status).toBe('paused');
  expect(imported.userStopped).toBe(true);
  expect(imported.activeOperation?.params).toEqual({ frozen: 'original' });
  expect(imported.activeOperation?.requestDigest).toBe('original-digest');
  expect(imported.activeOperation?.externalRunId).toBe('original-native-run');
  expect(imported.activeOperation?.stopRequested).toBe(true);
  expect(imported.activeOperation?.processTreeExited).toBeUndefined();
  expect(imported.activeOperation?.launchFenced).toBeUndefined();
  expect(imported.activeOperation?.legacyImport?.operation.rpcRequestId).toBe(
    'original-native-rpc',
  );
  expect(await readFile(f.snapshot)).toEqual(before);
  expect(f.calls).toEqual([]);
});

for (const slot of ['activeOperation', 'failedOperation'] as const) {
  test(`repeated legacy import preserves ${slot}, cancellation and quarantined inventory without dispatch`, async () => {
    const f = await fixture();
    const operation = {
      ...required(f.run.activeOperation),
      stopRequested: true,
      cancellationDeliveryError: {
        message: 'Stop acknowledgement missing',
        observedAt: 1,
      },
    };
    const quarantine = {
      id: '11111111-1111-4111-8111-111111111111',
      generation: 0,
      operation: { ...operation, operationId: 'quarantined-operation' },
      repositoryRoot: f.root,
      cwd: join(f.root, 'old-checkout'),
      branch: 'old-feature',
      planPath: join(f.root, 'old-checkout', 'plan.md'),
      inventory: join(f.root, 'inventory.json'),
      inventoryEntries: 0,
      ignoredEntries: 0,
      observedHead: 'a'.repeat(40),
      baseline: 'a'.repeat(40),
      commitDelta: '',
      quarantinedAt: 1,
    };
    await writeFile(quarantine.inventory, '[]');
    const planContent = '### Task 1: Fixture\n- [ ] Work\n';
    const seed: PlanExecRun = {
      ...f.run,
      planHash: parsePlan(required(f.run.planPath), planContent).hash,
      executionGeneration: 1,
      isolationRecovery: {
        id: quarantine.id,
        state: 'active',
        generation: 1,
        stopGeneration: 0,
        target: f.root,
        sourceRoot: quarantine.cwd,
        branch: 'feature',
        worktreeRelativePath: '',
        planRelativePath: 'plan.md',
        planContent,
        authorName: 'Fixture',
        authorEmail: 'fixture@example.test',
        requestedBy: 'owner',
        taskId: 1,
        taskTitle: 'Fixture',
        taskItems: ['Work'],
        bootstrapCommands: [],
        intentDigest: 'fixture-intent',
        baseline: quarantine.baseline,
        requestedAt: 1,
      },
      status: slot === 'failedOperation' ? 'failed' : 'paused',
      [slot]: operation,
      quarantinedExecutions: [quarantine],
    };
    if (slot === 'failedOperation') delete seed.activeOperation;
    const seeded = await f.registry.update(seed);
    await writeLegacyJournal(f.snapshot, f.binding, {
      cancel_requested: 1,
      stop_receipt_state: 'stopping',
    });
    const source = await readFile(f.snapshot);
    const first = await f.controller.importLegacyJournal(
      f.run.id,
      'owner',
      f.snapshot,
    );
    const second = await f.controller.importLegacyJournal(
      f.run.id,
      'owner',
      f.snapshot,
    );
    expect(second.status).toBe(seeded.status);
    expect(second.userStopped).toBe(true);
    expect(second[slot]?.params).toEqual(operation.params);
    expect(second[slot]?.requestDigest).toBe(operation.requestDigest);
    expect(second[slot]?.externalRunId).toBe(first[slot]?.externalRunId);
    expect(second[slot]?.legacyImport?.operation).toEqual(
      first[slot]?.legacyImport?.operation,
    );
    expect(second[slot]?.cancellationDeliveryError).toEqual(
      operation.cancellationDeliveryError,
    );
    expect(second[slot]?.stopRequested).toBe(true);
    expect(second.quarantinedExecutions).toEqual(seeded.quarantinedExecutions);
    expect(second.lease).toEqual(seeded.lease);
    expect(await readFile(quarantine.inventory, 'utf8')).toBe('[]');
    expect(await readFile(f.snapshot)).toEqual(source);
    expect(f.calls).toEqual([]);
  });
}

for (const scenario of [
  'missing',
  'absent-row',
  'mismatch',
  'corrupt',
  'unsupported',
  'conflict',
] as const) {
  test(`legacy ${scenario} snapshot cannot change operation identity or authorize dispatch`, async () => {
    const f = await fixture();
    if (scenario === 'absent-row')
      await writeLegacyJournal(f.snapshot, {
        ...f.binding,
        operationId: 'other-operation',
      });
    else if (scenario === 'corrupt') await writeFile(f.snapshot, 'not sqlite');
    else if (scenario === 'unsupported') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(f.snapshot);
      db.exec('PRAGMA user_version=6');
      db.close();
    } else if (scenario === 'mismatch')
      await writeLegacyJournal(f.snapshot, {
        ...f.binding,
        requestDigest: 'foreign',
      });
    if (scenario === 'conflict') {
      await f.registry.updateLatest(f.run.id, (run) => ({
        ...run,
        activeOperation: {
          ...required(run.activeOperation),
          externalRunId: 'already-recorded',
        },
      }));
      await writeLegacyJournal(f.snapshot, f.binding);
    }
    const before = await readFile(f.registry.authorizationPath(f.run.id));
    await expect(
      f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot),
    ).rejects.toThrow(/Legacy snapshot/);
    expect(await readFile(f.registry.authorizationPath(f.run.id))).toEqual(
      before,
    );
    expect(
      (
        await f.registry.claim(
          required(await f.registry.get(f.run.id)),
          'second-session',
        )
      ).lease?.sessionId,
    ).toBe('second-session');
    expect((await f.registry.get(f.run.id))?.activeOperation).toEqual(
      scenario === 'conflict'
        ? { ...f.run.activeOperation, externalRunId: 'already-recorded' }
        : f.run.activeOperation,
    );
    expect(f.calls).toEqual([]);
  });
}

test('abandonment, foreign lease and changed cancellation generation win over import', async () => {
  const f = await fixture();
  await writeLegacyJournal(f.snapshot, f.binding);
  await f.registry.claim(f.run, 'other');
  await expect(
    f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot),
  ).rejects.toThrow(/another active/);
  const changed = await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    stopGeneration: 1,
  }));
  expect(
    await f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot, 0),
  ).toEqual(changed);
  await f.registry.abandon(f.run.id, 'other');
  const before = await readFile(f.registry.authorizationPath(f.run.id));
  await expect(
    f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot),
  ).rejects.toThrow(/Abandoned/);
  expect(await readFile(f.registry.authorizationPath(f.run.id))).toEqual(
    before,
  );
});

test('fresh CAS import preserves newer stop intent instead of overwriting a concurrent cancellation', async () => {
  const f = await fixture();
  await writeLegacyJournal(f.snapshot, f.binding);
  const update = f.registry.updateIfCurrent.bind(f.registry);
  let intercept = true;
  vi.spyOn(f.registry, 'updateIfCurrent').mockImplementation(
    async (...args) => {
      if (intercept && args[0].activeOperation?.legacyImport) {
        intercept = false;
        const current = required(await f.registry.get(f.run.id));
        await update(
          {
            ...current,
            status: 'cancel_pending',
            stopGeneration: 1,
            userStopped: true,
          },
          current.updatedAt,
        );
      }
      return update(...args);
    },
  );
  const result = await f.controller.importLegacyJournal(
    f.run.id,
    'owner',
    f.snapshot,
  );
  expect(result.status).toBe('cancel_pending');
  expect(result.activeOperation?.legacyImport).toBeUndefined();
  expect(result.activeOperation?.requestDigest).toBe('original-digest');
  expect(f.calls).toEqual([]);
});

test('resume fences an unresolved failed historical operation before touching the missing workspace', async () => {
  const f = await fixture();
  const failed = {
    ...f.run,
    status: 'failed' as const,
    failedOperation: required(f.run.activeOperation),
  };
  delete failed.activeOperation;
  await f.registry.update(failed);
  const resumed = await f.controller.resume(f.run.id, 'owner');
  expect(resumed.activeOperation?.operationId).toBe('original-operation');
  expect(resumed.activeOperation?.requestDigest).toBe('original-digest');
  expect(resumed.error).toContain(
    `--legacy-journal /absolute/path/to/snapshot.sqlite`,
  );
  expect(f.calls).toEqual([]);
});

test('an import cannot overwrite a native binding that arrived after its initial snapshot', async () => {
  const f = await fixture();
  await writeLegacyJournal(f.snapshot, f.binding);
  const get = f.registry.get.bind(f.registry);
  let reads = 0;
  vi.spyOn(f.registry, 'get').mockImplementation(async (...args) => {
    if (++reads === 2)
      await f.registry.updateLatest(f.run.id, (run) => ({
        ...run,
        activeOperation: {
          ...required(run.activeOperation),
          externalRunId: 'newer-exact-binding',
        },
      }));
    return get(...args);
  });
  await expect(
    f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot),
  ).rejects.toThrow(/newer recorded native binding/);
  const current = required(await f.registry.get(f.run.id));
  expect(current.activeOperation?.externalRunId).toBe('newer-exact-binding');
  expect(current.activeOperation?.legacyImport).toBeUndefined();
  expect(current.activeOperation?.params).toEqual(
    f.run.activeOperation?.params,
  );
  expect(f.calls).toEqual([]);
});

test('invalid import preserves a preexisting legitimate lease byte for byte', async () => {
  const f = await fixture();
  await f.registry.claim(f.run, 'owner');
  const before = await readFile(f.registry.authorizationPath(f.run.id));
  await expect(
    f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot),
  ).rejects.toThrow(/Legacy snapshot/);
  expect(await readFile(f.registry.authorizationPath(f.run.id))).toEqual(
    before,
  );
});

test('legacy import publication EACCES preserves registry and SQLite bytes and retries the same identity', async () => {
  const f = await fixture();
  await writeLegacyJournal(f.snapshot, f.binding);
  const record = f.registry.authorizationPath(f.run.id);
  const before = await readFile(record);
  const snapshot = await readFile(f.snapshot);
  await chmod(dirname(record), 0o555);
  try {
    await expect(
      f.controller.importLegacyJournal(f.run.id, 'owner', f.snapshot),
    ).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    await chmod(dirname(record), 0o755);
  }
  expect(await readFile(record)).toEqual(before);
  expect(await readFile(f.snapshot)).toEqual(snapshot);
  expect(f.calls).toEqual([]);
  const imported = await f.controller.importLegacyJournal(
    f.run.id,
    'owner',
    f.snapshot,
  );
  expect(imported.activeOperation?.operationId).toBe(f.binding.operationId);
  expect(imported.activeOperation?.requestDigest).toBe(f.binding.requestDigest);
  expect(imported.activeOperation?.params).toEqual(
    f.run.activeOperation?.params,
  );
  expect(imported.lease).toBeUndefined();
  expect(await readFile(f.snapshot)).toEqual(snapshot);
  expect(f.calls).toEqual([]);
});
