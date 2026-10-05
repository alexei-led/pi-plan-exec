import assert from 'node:assert/strict';
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
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { onTestFinished, test } from 'vitest';

const execute = promisify(execFile);

test('visible recovery fixture rejects existing and checkout-contained sandboxes before mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-path-guard-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bridge = join(root, 'bridge');
  await mkdir(bridge);
  const sentinel = join(root, 'keep.txt');
  await writeFile(sentinel, 'do not modify');
  const alias = join(root, 'checkout-alias');
  await symlink(resolve('.'), alias);
  for (const sandbox of [
    root,
    resolve('src', 'forbidden-fixture'),
    join(bridge, 'inside-bridge'),
    join(alias, 'forbidden-fixture'),
  ]) {
    await assert.rejects(
      execute(
        process.execPath,
        [resolve('test/recovery-agterm.mjs'), sandbox, bridge, '--server-only'],
        { timeout: 5_000 },
      ),
      /new sandbox outside both checkouts/,
    );
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'do not modify');
});
