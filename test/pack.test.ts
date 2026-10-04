import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const hostPackages = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
  '@sinclair/typebox',
  'typebox',
];

for (const packageName of hostPackages) {
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies',
  ]) {
    test(`pack rejects host package ${packageName} in ${field}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'plan-exec-pack-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'invalid-extension',
          version: '1.0.0',
          [field]: field.startsWith('bundle')
            ? [packageName]
            : { [packageName]: '^0.1.0' },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/check-pack.mjs')],
        {
          cwd: directory,
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1);
      assert.ok(
        result.stderr.includes(`${field}: ${packageName}`),
        result.stderr,
      );
      assert.ok(
        result.stderr.includes('peerDependencies with the tested host range'),
        result.stderr,
      );
    });
  }
}

test('imported host packages use tested peers, never private runtime copies', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  for (const name of [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
  ]) {
    assert.equal(
      manifest.peerDependencies[name],
      name === '@earendil-works/pi-coding-agent' ? '^1.0.2' : '*',
    );
  }
  for (const name of hostPackages) {
    assert.equal(manifest.dependencies?.[name], undefined);
    assert.equal(manifest.optionalDependencies?.[name], undefined);
    if (manifest.peerDependencies[name] !== undefined)
      assert.equal(
        manifest.peerDependencies[name],
        name === '@earendil-works/pi-coding-agent' ? '^1.0.2' : '*',
      );
  }
});

test('pack accepts the tested host peer without private runtime copies', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'plan-exec-pack-home-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/check-pack.mjs')],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: home },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@alexeiled\/pi-plan-exec@/);
});

test('package manifest ships only plan-exec resources, needs no runtime dependency, and requires v2 bridge peers', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as {
    pi: { extensions: string[]; skills: string[] };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bundledDependencies?: string[];
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };
  assert.deepEqual(manifest.pi.extensions, ['./src/index.ts']);
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.equal(manifest.dependencies?.['pi-subagents'], undefined);
  assert.equal(
    manifest.dependencies?.['@alexeiled/pi-subagents-bridge'],
    undefined,
  );
  assert.match(
    manifest.devDependencies?.['pi-subagents'] ?? '',
    /^\^0\.73\.1$/,
  );
  assert.equal(manifest.peerDependencies['pi-subagents'], undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  for (const packageName of ['@alexeiled/pi-fusion', '@tintinweb/pi-tasks']) {
    assert.equal(
      manifest.peerDependencies[packageName],
      packageName === '@alexeiled/pi-fusion'
        ? '>=0.9.3 <1.0.0'
        : '>=0.9.0 <0.10.0',
    );
    assert.equal(manifest.peerDependenciesMeta[packageName]?.optional, true);
  }
  assert.equal(
    manifest.peerDependencies['@alexeiled/pi-subagents-bridge'],
    '>=0.5.0 <0.6.0',
  );
  assert.equal(
    manifest.peerDependenciesMeta['@alexeiled/pi-subagents-bridge']?.optional,
    true,
  );
  assert.match(
    await readFile(
      join(root, 'skills', 'exec-plan', 'references', 'recovery.md'),
      'utf8',
    ),
    /Resume the plan run ID, not the child\s+ID/,
  );
});
