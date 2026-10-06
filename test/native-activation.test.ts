import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
for (const mode of ['plan', 'goal', 'fix']) {
  test(`production native ${mode} completes detached worker and required readonly reviewer`, {
    timeout: 90_000,
  }, async () => {
    const result = await execute(
      process.execPath,
      ['test/fixtures/native-activation.mjs', mode],
      { timeout: 85_000, maxBuffer: 2_000_000 },
    );
    expect(result.stdout).toContain('"status":"completed"');
    expect(result.stdout).toContain('"detached":true');
  });
}
