import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/component/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
    ],
    testTimeout: 30000, // integration/e2e tests may download tarballs
    passWithNoTests: true,
  },
});
