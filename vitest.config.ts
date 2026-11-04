import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    // Serial Git/process-heavy files avoid the reproduced 60s/180s contention failures.
    maxWorkers: 1,
    include: ['test/**/*.test.ts'],
    // index.test.ts keeps node:test: its session-lifecycle mocks rely on
    // node:test's timer/mock semantics that Vitest does not reproduce yet.
    exclude: ['**/node_modules/**', '.pi/**', 'test/index.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/support/vitest-setup.ts'],
  },
});
