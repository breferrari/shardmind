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
    // Clears the caller's FORCE_COLOR / NO_COLOR in every worker (#159), and
    // in a coverage run points the spawned CLI's V8 coverage at the provider (#293).
    setupFiles: ['tests/setup/color-env.ts', 'tests/setup/subprocess-coverage.ts'],
    testTimeout: 30000, // integration/e2e tests may download tarballs
    passWithNoTests: true,
    // `npm run test:coverage` (#267): a report only, no thresholds yet. The
    // provider adds what the spawned CLI ran to the workers' coverage (#293).
    // The script caps the workers at 4: instrumented, the suite timed out at
    // full parallelism on a loaded machine.
    coverage: {
      provider: 'custom',
      customProviderModule: './tests/coverage-run/subprocess-provider.ts',
      // A report even when a test fails: a timeout must not cost the whole report.
      reportOnFailure: true,
      include: ['source/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
