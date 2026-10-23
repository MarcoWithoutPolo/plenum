import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Brain tests drive real git repos; slower CI runners (Windows) need more than 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./vitest.setup.ts'],
  },
});
