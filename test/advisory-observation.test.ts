import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseAdvisoryObservation } from '../src/advisory-observation.js';

const now = 100_000;
const valid = {
  version: 1,
  source: 'pi-subagents.async-status-snapshot',
  runId: 'native-1',
  generatedAt: now,
  activity: { currentTool: 'read', toolCount: 3, lastActivityAt: now - 1 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
};
test('advisory boundary validates exact binding and preserves omission flags', () => {
  assert.deepEqual(parseAdvisoryObservation(valid, 'native-1', now), valid);
});
for (const [name, patch] of [
  ['foreign', { runId: 'other' }],
  ['future', { generatedAt: now + 1 }],
  ['stale', { generatedAt: now - 30_001 }],
  ['control text', { activity: { currentTool: 'read\u001b[31m' } }],
  ['bad count', { activity: { turnCount: -1 } }],
  ['future activity', { activity: { lastActivityAt: now + 1 } }],
  ['missing omissions', { omitted: undefined }],
] as const)
  test(`advisory boundary rejects ${name}`, () => {
    assert.equal(
      parseAdvisoryObservation({ ...valid, ...patch }, 'native-1', now),
      undefined,
    );
  });
