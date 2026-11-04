import assert from 'node:assert/strict';
import { test } from 'vitest';
import { missingPackedLinks } from '../scripts/packed-links.js';

const files = new Set([
  'README.md',
  'LICENSE',
  'skills/exec-plan/SKILL.md',
  'skills/exec-plan/references/runtime-contracts.md',
]);

test('packed Markdown checks shipped targets including parent paths and fragments', () => {
  assert.deepEqual(
    missingPackedLinks(
      'skills/exec-plan/SKILL.md',
      '[contract](references/runtime-contracts.md#retirement) [home](../../README.md)',
      files,
    ),
    [],
  );
  assert.deepEqual(
    missingPackedLinks(
      'README.md',
      '[license](LICENSE) [skill](skills/exec-plan/)',
      files,
    ),
    [],
  );
});

test('a source-checkout document omitted from the tarball is still a broken link', () => {
  assert.deepEqual(
    missingPackedLinks('README.md', '[guide](docs/guide.md)', files),
    ['docs/guide.md'],
  );
  assert.deepEqual(
    missingPackedLinks(
      'skills/exec-plan/SKILL.md',
      '[bad](../../../private.md)',
      files,
    ),
    ['../../../private.md'],
  );
});

test('reference-style links are checked but examples, anchors and web URLs are not file links', () => {
  const text = [
    '[contract]: skills/exec-plan/references/runtime-contracts.md',
    '[bad]: missing.md',
    '[web](https://example.test/docs) [section](#section)',
    '```md',
    '[example](not-a-real-file.md)',
    '```',
    'Inline `[example](also-not-real.md)`.',
  ].join('\n');
  assert.deepEqual(missingPackedLinks('README.md', text, files), [
    'missing.md',
  ]);
});

test('malformed encoding and absolute file destinations do not pass', () => {
  assert.deepEqual(
    missingPackedLinks('README.md', '[bad](%ZZ) [absolute](/tmp/file)', files),
    ['%ZZ', '/tmp/file'],
  );
});
