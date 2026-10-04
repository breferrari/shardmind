import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/component/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'tests/ui-kit/**/*.test.{ts,tsx}',
      'tests/cli-kit/**/*.test.{ts,tsx}',
    ],
    // Builds dist/ once, before any worker spawns dist/cli.js (#176).
    globalSetup: ['tests/global-setup.ts'],
    // Clears the caller's FORCE_COLOR / NO_COLOR in every worker (#159).
    setupFiles: ['tests/setup/color-env.ts'],
    testTimeout: 30000, // integration/e2e tests may download tarballs
    passWithNoTests: true,
    // `npm run test:coverage` (#267): a report only, no thresholds yet.
    coverage: {
      provider: 'v8',
      include: ['source/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
