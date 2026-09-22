import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    include: ['test/**/*.test.ts'],
    // index.test.ts keeps node:test: its session-lifecycle mocks rely on
    // node:test's timer/mock semantics that Vitest does not reproduce yet.
    exclude: ['**/node_modules/**', '.pi/**', 'test/index.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/support/vitest-setup.ts'],
  },
});
