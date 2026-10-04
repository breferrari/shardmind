/**
 * Vitest global setup: builds `dist/` once per run, in the main process,
 * before any worker spawns `dist/cli.js` (#176). Workers only check that it
 * exists — see tests/e2e/helpers/build-once.ts.
 */

import type { TestProject } from 'vitest/node';
import { buildIfStale } from './e2e/helpers/build-once.js';

export default async function setup(project: TestProject): Promise<void> {
  await buildIfStale();
  // Watch mode: rebuild after an edit, still before the rerun's workers start.
  project.onTestsRerun(() => buildIfStale());
}
