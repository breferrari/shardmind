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
import { BUILD_ERROR_KEY, buildForRun, type BuildOptions } from './e2e/helpers/build-once.js';
import { SUBPROCESS_COVERAGE_DIR_KEY, SUBPROCESS_COVERAGE_DIR } from './coverage-run/coverage-run.js';
import { PTY_CAPABILITIES_KEY, probePtyCapabilities, type PtyCapabilities } from './e2e/tui/helpers/pty-capability.js';

/** The part of vitest's `TestProject` the setup uses. */
export type SetupProject = Pick<TestProject, 'provide' | 'onTestsRerun'> & {
  config: { coverage: { enabled: boolean } };
};

export function createSetup(
  build: (opts: BuildOptions) => Promise<string | null> = (opts) => buildForRun(undefined, undefined, opts),
  probe: () => Promise<PtyCapabilities> = () => probePtyCapabilities(),
) {
  async function buildAndProvide(project: SetupProject): Promise<void> {
    // A coverage run builds with sourcemaps, for the spawned CLI's coverage (#293).
    const error = await build({ sourcemap: project.config.coverage.enabled });
    // A run that spawns nothing never reaches ensureBuilt(), so say it here.
    if (error !== null) console.warn(`tests/global-setup.ts could not build dist/:
${error}`);
    project.provide(BUILD_ERROR_KEY, error);
  }

  return async function setup(project: SetupProject): Promise<void> {
    // What the PTY can do, for the Layer 2 gates (#174): probed, not assumed
    // from the platform.
    project.provide(PTY_CAPABILITIES_KEY, await probe());
    // Where the workers' children write their coverage, in a coverage run
    // only (tests/setup/subprocess-coverage.ts, #293).
    project.provide(SUBPROCESS_COVERAGE_DIR_KEY, project.config.coverage.enabled ? SUBPROCESS_COVERAGE_DIR : null);
    await buildAndProvide(project);
    // Watch mode: rebuild after an edit, still before the rerun's workers start.
    project.onTestsRerun(() => buildAndProvide(project));
  };
}

export default createSetup();
