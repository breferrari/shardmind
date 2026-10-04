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
    // Builds dist/ once, before any worker spawns dist/cli.js (#176).
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30000, // integration/e2e tests may download tarballs
    passWithNoTests: true,
  },
});
