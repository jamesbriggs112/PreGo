import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript source, so tests never need a build first.
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    // Browser-driven tests need room; individual tests set longer timeouts where needed.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Audits launch real browsers, so keep files from fighting over CPU.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
