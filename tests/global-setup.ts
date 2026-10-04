/**
 * Vitest global setup: builds `dist/` once per run, in the main process,
 * before any worker spawns `dist/cli.js` (#176). Workers only check that it
 * exists — see tests/e2e/helpers/build-once.ts.
 *
 * A build failure is provided to the workers rather than thrown. Thrown, it
 * would abort the whole run, so a type error mid-edit would block unit tests
 * that never touch `dist/`; provided, it fails only the tests that spawn the
 * CLI, through `ensureBuilt()`.
 */

import type { TestProject } from 'vitest/node';
import { BUILD_ERROR_KEY, buildForRun } from './e2e/helpers/build-once.js';

/** The part of vitest's `TestProject` the setup uses. */
export type SetupProject = Pick<TestProject, 'provide' | 'onTestsRerun'>;

export function createSetup(build: () => Promise<string | null> = () => buildForRun()) {
  return async function setup(project: SetupProject): Promise<void> {
    project.provide(BUILD_ERROR_KEY, await build());
    // Watch mode: rebuild after an edit, still before the rerun's workers start.
    project.onTestsRerun(async () => {
      project.provide(BUILD_ERROR_KEY, await build());
    });
  };
}

export default createSetup();
