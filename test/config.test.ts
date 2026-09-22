import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseRunConfig } from '../src/config.js';

test('autonomous defaults require one reviewer and explicit unbounded lifetime', () => {
  const config = parseRunConfig({});
  assert.deepEqual(config.executionLifetime, { mode: 'unbounded' });
  assert.equal(config.reviewBackend, 'subagent');
  assert.equal(config.reviewRequired, true);
  assert.equal(config.reviewEnabled, true);
  assert.deepEqual(config.reviewFallback, []);
  assert.equal(config.statsEnabled, false);
});

test('bounded compatibility is an explicit frozen choice', () => {
  const config = parseRunConfig({
    executionLifetime: { mode: 'bounded', timeoutMs: 60_000 },
    reviewBackend: 'fusion',
  });
  assert.deepEqual(config.executionLifetime, {
    mode: 'bounded',
    timeoutMs: 60_000,
  });
  assert.equal(config.reviewBackend, 'fusion');
});

test('invalid or misleading lifetime policies fail before dispatch', () => {
  for (const executionLifetime of [
    0,
    null,
    {},
    { mode: 'bounded', timeoutMs: 0 },
    { mode: 'bounded', timeoutMs: Infinity },
    { mode: 'bounded', timeoutMs: 2_147_483_648 },
    { mode: 'unbounded', timeoutMs: 1 },
  ])
    assert.throws(
      () => parseRunConfig({ executionLifetime }),
      /executionLifetime/,
    );
});

test('config rejects silently ignored settings and contradictory required review', () => {
  assert.throws(
    () => parseRunConfig({ reviewRequired: true, reviewEnabled: false }),
    /cannot be disabled/,
  );
  assert.throws(() => parseRunConfig({ reviewBackend: 'unknown' }), /backend/);
  assert.throws(() => parseRunConfig({ timeout: 0 }), /Unknown/);
  assert.throws(
    () => parseRunConfig({ requiredChecks: ['npm test'] }),
    /command argument arrays/,
  );
});
