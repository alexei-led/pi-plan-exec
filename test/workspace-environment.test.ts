import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  workspaceCommand,
  workspaceEnvironment,
} from '../src/workspace-environment.js';

test('workspace launch removes repository routing while preserving identity and authentication', () => {
  const inherited = {
    PATH: '/bin',
    GIT_DIR: '/other/.git',
    GIT_WORK_TREE: '/other',
    GIT_INDEX_FILE: '/other/index',
    GIT_COMMON_DIR: '/other/.git',
    GIT_OBJECT_DIRECTORY: '/other/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/other/objects',
    GIT_CONFIG: '/other/config',
    GIT_CONFIG_PARAMETERS: 'injected',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: '/other',
    GIT_NAMESPACE: 'other',
    GIT_GRAFT_FILE: '/other/grafts',
    GIT_SHALLOW_FILE: '/other/shallow',
    GIT_PREFIX: 'old/',
    GIT_IMPLICIT_WORK_TREE: '0',
    GIT_REPLACE_REF_BASE: 'refs/other/',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_SSH_COMMAND: 'ssh -F /fixture/config',
    GIT_ASKPASS: '/fixture/askpass',
    GIT_TERMINAL_PROMPT: '0',
    OPTIONAL: undefined,
  };
  const cleaned = workspaceEnvironment(inherited);
  assert.deepEqual(cleaned, {
    PATH: '/bin',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_SSH_COMMAND: 'ssh -F /fixture/config',
    GIT_ASKPASS: '/fixture/askpass',
    GIT_TERMINAL_PROMPT: '0',
  });
  assert.equal(inherited.GIT_DIR, '/other/.git');
  assert.equal(workspaceCommand('git', ['status'], {}).command, 'git');
  assert.deepEqual(workspaceCommand('node', ['check.mjs'], inherited), {
    command: 'node',
    args: ['check.mjs'],
  });
});

test('the production Git invocation honors its target despite inherited hook selectors', async (_t) => {
  const base = resolve('.pi/workspace-environment-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const clean = workspaceEnvironment();
  for (const directory of [first, second])
    execFileSync('git', ['init', '--quiet', directory], {
      cwd: root,
      env: clean,
    });
  const poisoned = {
    ...clean,
    GIT_DIR: join(first, '.git'),
    GIT_WORK_TREE: first,
    GIT_COMMON_DIR: join(first, '.git'),
    GIT_INDEX_FILE: join(first, 'hook-index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: first,
  };
  const inspect = workspaceCommand(
    'git',
    ['rev-parse', '--show-toplevel'],
    poisoned,
  );
  assert.equal(
    execFileSync(inspect.command, inspect.args, {
      cwd: second,
      env: poisoned,
      encoding: 'utf8',
    }).trim(),
    second,
  );
  const write = workspaceCommand(
    'git',
    ['config', '--local', 'fixture.target', 'second'],
    poisoned,
  );
  execFileSync(write.command, write.args, { cwd: second, env: poisoned });
  assert.equal(
    execFileSync('git', ['config', '--local', '--get', 'fixture.target'], {
      cwd: second,
      env: clean,
      encoding: 'utf8',
    }).trim(),
    'second',
  );
  assert.equal(
    spawnSync('git', ['config', '--local', '--get', 'fixture.target'], {
      cwd: first,
      env: clean,
    }).status,
    1,
  );
});

test('controller observations do not run fsmonitor hooks or refresh the Git index', async (_t) => {
  const base = resolve('.pi/workspace-environment-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'hooks-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repository');
  const marker = join(root, 'invoked');
  const hook = join(root, 'fsmonitor.mjs');
  const env = {
    ...workspaceEnvironment(),
    PI_PLAN_EXEC_FSMONITOR_MARKER: marker,
  };
  execFileSync('git', ['init', '--quiet', cwd], { cwd: root, env });
  await writeFile(join(cwd, 'file.txt'), 'fixture\n');
  execFileSync('git', ['add', 'file.txt'], { cwd, env });
  await writeFile(
    hook,
    '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.PI_PLAN_EXEC_FSMONITOR_MARKER, "called"); process.stdout.write("token\\0/\\0");\n',
    { mode: 0o700 },
  );
  execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd, env });
  execFileSync('git', ['status', '--porcelain'], { cwd, env });
  assert.equal(await readFile(marker, 'utf8'), 'called');
  await rm(marker);
  const index = await readFile(join(cwd, '.git', 'index'));
  const changed = new Date(Date.now() + 1_000);
  await utimes(join(cwd, 'file.txt'), changed, changed);
  const invocation = workspaceCommand('git', ['status', '--porcelain'], env);
  execFileSync(invocation.command, invocation.args, { cwd, env });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(cwd, '.git', 'index')), index);
});
