import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import { expect, onTestFinished, test } from 'vitest';
import { NativeRuntimeClient } from '../src/native-runtime.js';
import { RunRegistry } from '../src/registry.js';
import { required } from '../src/required.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../src/types.js';

const execute = promisify(execFile);
const OLD_RELEASE = 'bc5fb6ef800b6e88f3edeef542869bbd84a9ed3a';

test('S53 frozen 1.8.0 accepts native records, guards reservations, but old cleanup deletes native history and unreadable ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-rollback-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const oldSource = join(root, 'frozen-executor');
  await mkdir(oldSource);
  const archive = join(root, 'old-src.tar');
  await execute('git', [
    'archive',
    '--format=tar',
    `--output=${archive}`,
    OLD_RELEASE,
    'src',
  ]);
  await execute('tar', ['-xf', archive, '-C', oldSource]);
  const expectedSource = await execute('git', [
    'show',
    `${OLD_RELEASE}:src/registry.ts`,
  ]);
  expect(await readFile(join(oldSource, 'src/registry.ts'), 'utf8')).toBe(
    expectedSource.stdout,
  );
  const jiti = createJiti(import.meta.url);
  const frozen = (await jiti.import(join(oldSource, 'src/registry.ts'))) as {
    RunRegistry: typeof RunRegistry;
  };
  const { rollbackPreflight } = (await jiti.import(
    '../src/rollback-preflight.mjs',
  )) as {
    rollbackPreflight(
      directory: string,
    ): Promise<{ safe: boolean; blockers: string[] }>;
  };
  const directory = join(root, 'registry');
  const registry = new RunRegistry(directory);
  let run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    worktreeCwd: root,
    planPath: join(root, 'plan.md'),
    planHash: 'fixture',
    branch: 'feature',
    defaultBranch: 'main',
    status: 'running',
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
  });
  const client = new NativeRuntimeClient(
    {
      on() {
        return () => {};
      },
      emit() {
        throw new Error('Rollback fixture cannot launch');
      },
    },
    registry,
    () =>
      ({
        sessionManager: {
          getSessionId: () => 'fixture',
          getSessionFile: () => undefined,
        },
      }) as ExtensionContext,
  );
  onTestFinished(() => client.dispose());
  const op = await client.prepare(run, {
    operationId: 'native-intent',
    kind: 'implementation',
    agent: 'worker',
    task: 'Never dispatch this fixture',
  });
  run = await registry.update({ ...run, activeOperation: op });
  const before = await readFile(registry.authorizationPath(run.id));
  const check = await rollbackPreflight(directory);
  expect(check.safe).toBe(false);
  expect(await readFile(registry.authorizationPath(run.id))).toEqual(before);
  const old = new frozen.RunRegistry(directory);
  expect((await old.get(run.id))?.activeOperation?.service).toBe('native'); // Old parser does not discriminate the new format.
  await expect(
    old.assertExclusive({ ...run, id: '11111111-1111-4111-8111-111111111111' }),
  ).rejects.toThrow();
  expect(await readFile(registry.authorizationPath(run.id))).toEqual(before);
  await expect(old.remove(run.id)).rejects.toThrow(
    /unconfirmed|only a terminal/,
  );
  // Terminal history still contains native artifacts, but the old cleanup knows no such gate.
  const terminal = { ...run, status: 'completed' as const };
  delete terminal.activeOperation;
  await registry.update(terminal);
  expect((await rollbackPreflight(directory)).safe).toBe(false);
  expect((await old.get(run.id))?.status).toBe('completed');
  expect(await old.remove(run.id)).toBe(true);
  await expect(
    readFile(registry.authorizationPath(run.id)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await rollbackPreflight(directory)).toMatchObject({ safe: true });

  // Terminal history and native artifacts still block the supported preflight.
  const historical = join(directory, '.abandoned', run.id);
  await mkdir(historical, { recursive: true });
  await writeFile(
    join(historical, 'run.json'),
    JSON.stringify({ ...run, status: 'abandoned' }),
  );
  expect((await rollbackPreflight(directory)).safe).toBe(false);
  await rm(historical, { recursive: true });
  await mkdir(join(directory, run.id, 'native', 'retained'), {
    recursive: true,
  });
  await writeFile(
    join(directory, run.id, 'run.json'),
    JSON.stringify({ ...run, status: 'completed', activeOperation: undefined }),
  );
  expect((await rollbackPreflight(directory)).safe).toBe(false);
  await rm(join(directory, run.id, 'native'), { recursive: true });
  const legacy = {
    ...run,
    status: 'completed',
    activeOperation: {
      ...required(run.activeOperation),
      service: 'bridge',
      native: undefined,
    },
  };
  await writeFile(join(directory, run.id, 'run.json'), JSON.stringify(legacy));
  expect((await rollbackPreflight(directory)).safe).toBe(true);
  await writeFile(join(directory, run.id, 'run.json'), '{corrupt');
  expect((await rollbackPreflight(directory)).safe).toBe(false);
  // Separately label the corrupt-data hazard, not a native-format parser refusal.
  await expect(old.get(run.id)).rejects.toThrow();
  await expect(
    old.assertExclusive({ ...run, id: '11111111-1111-4111-8111-111111111111' }),
  ).rejects.toThrow();
  expect(await old.remove(run.id)).toBe(true);
  await expect(
    readFile(registry.authorizationPath(run.id)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rollback preflight refuses non-directory roots, symlinks and unreadable inspection without writes', async () => {
  const { rollbackPreflight } = (await createJiti(import.meta.url).import(
    '../src/rollback-preflight.mjs',
  )) as {
    rollbackPreflight(
      directory: string,
    ): Promise<{ safe: boolean; blockers: string[] }>;
  };
  const root = await mkdtemp(join(tmpdir(), 'rollback-limits-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'legacy.json');
  await writeFile(file, '{}');
  expect((await rollbackPreflight(file)).safe).toBe(false);
  expect((await rollbackPreflight(join(root, 'missing'))).safe).toBe(false);
  await symlink(file, join(root, 'alias.json'));
  expect((await rollbackPreflight(root)).safe).toBe(false);
  expect(await readFile(file, 'utf8')).toBe('{}');
});

test('rollback preflight refuses a non-regular JSON source without opening it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rollback-special-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await execute('mkfifo', [join(root, 'record.json')]);
  await expect(
    execute(
      process.execPath,
      [
        fileURLToPath(
          new URL('../src/rollback-preflight.mjs', import.meta.url),
        ),
        '--registry',
        root,
      ],
      { timeout: 3000 },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('"safe": false'),
  });
});
