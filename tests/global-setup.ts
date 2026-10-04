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
  async function buildAndProvide(project: SetupProject): Promise<void> {
    const error = await build();
    // A run that spawns nothing never reaches ensureBuilt(), so say it here.
    if (error !== null) console.warn(`tests/global-setup.ts could not build dist/:
${error}`);
    project.provide(BUILD_ERROR_KEY, error);
  }

  return async function setup(project: SetupProject): Promise<void> {
    await buildAndProvide(project);
    // Watch mode: rebuild after an edit, still before the rerun's workers start.
    project.onTestsRerun(() => buildAndProvide(project));
  };
}

export default createSetup();
