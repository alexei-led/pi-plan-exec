import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
for (const mode of ['plan', 'goal', 'fix']) {
  test(`released native ${mode}: detached worker, typed review, owned evidence and Git acceptance`, {
    timeout: 90000,
  }, async () => {
    const result = await execute(
      process.execPath,
      ['test/fixtures/native-activation.mjs', mode],
      { timeout: 85000, maxBuffer: 2000000 },
    );
    assert.match(result.stdout, /"status":"completed"/);
    assert.match(result.stdout, /"detached":true/);
  });
}
