/**
 * The coverage provider module for `npm run test:coverage` (#293): vitest's
 * v8 module, whose profiling runs in every worker, with `getProvider`
 * swapped for the subclass that also counts the spawned CLI
 * (subprocess-coverage-provider.ts). vitest imports this module in each
 * worker too, so the subclass, and the report stack it pulls in, loads only
 * when `getProvider` runs, in the main process.
 */

import v8Module from '@vitest/coverage-v8';
import type { CoverageProviderModule } from 'vitest/node';

const mod: CoverageProviderModule = {
  ...v8Module,
  getProvider: async () => {
    const { SubprocessCoverageProvider } = await import('./subprocess-coverage-provider.js');
    return new SubprocessCoverageProvider();
  },
};
export default mod;
