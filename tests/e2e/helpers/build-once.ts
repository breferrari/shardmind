/**
 * Build guard for the suites that spawn `dist/cli.js` (E2E, Layer 2 PTY, and
 * the Layer 1 flow tests through `createInstalledVault`).
 *
 * `dist/` is built once per vitest run, in the main process, before any worker
 * starts: `tests/global-setup.ts` calls `buildForRun()`, and again before each
 * watch-mode rerun. A build failure does not abort the run: the setup provides
 * it to the workers, and `ensureBuilt()` throws it in the tests that spawn the
 * CLI. Workers call `ensureBuilt()`, which only checks that the artifacts
 * exist and never writes `dist/`.
 *
 * Workers must not build (#176). Vitest runs each test file in its own worker,
 * so a per-process memo still let every E2E file run `tsup` at once on a stale
 * tree, and tsup's `clean: true` emptied `dist/` under any test that was
 * spawning the CLI at that moment.
 *
 * CI runs `npm run build` before `npm test` (see .github/workflows/ci.yml), so
 * the global setup finds `dist/` fresh there and skips the build.
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from '../../../source/core/fs-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Every file the spawned CLI loads, relative to the repo root: the entry, the
 * Pastel command files it routes to, the runtime hook scripts import, and the
 * hook-runner it spawns. One per entry in tsup.config.ts.
 */
export const DIST_ARTIFACTS: readonly string[] = [
  'dist/cli.js',
  'dist/commands/index.js',
  'dist/commands/install.js',
  'dist/commands/update.js',
  'dist/commands/adopt.js',
  'dist/commands/validate.js',
  'dist/runtime/index.js',
  'dist/internal/hook-runner.js',
];

export const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

/** Absolute paths of the artifacts in `DIST_ARTIFACTS` that are not on disk. */
async function missingArtifacts(root: string): Promise<string[]> {
  const missing: string[] = [];
  for (const rel of DIST_ARTIFACTS) {
    const full = path.join(root, rel);
    if (!(await pathExists(full))) missing.push(full);
  }
  return missing;
}

/** Key under which the global setup hands its build failure to the workers. */
export const BUILD_ERROR_KEY = 'distBuildError';

declare module 'vitest' {
  export interface ProvidedContext {
    distBuildError: string | null;
  }
}

/**
 * Worker-side check: resolves when `dist/` holds every artifact the CLI loads,
 * rejects otherwise. Never builds — see the file header. `buildError` is the
 * global setup's failure; by default it is read from vitest's provided
 * context, which describes the repo's own `dist/` only.
 */
export async function ensureBuilt(
  root: string = REPO_ROOT,
  buildError?: string | null,
): Promise<void> {
  if (buildError === undefined) {
    const { inject } = await import('vitest');
    buildError = root === REPO_ROOT ? (inject(BUILD_ERROR_KEY) ?? null) : null;
  }
  if (buildError !== null) {
    throw new Error(`The vitest global setup (tests/global-setup.ts) could not build dist/:
${buildError}`);
  }
  const [missing] = await missingArtifacts(root);
  if (missing !== undefined) {
    throw new Error(
      `${missing} is missing. The vitest global setup (tests/global-setup.ts) builds dist/ ` +
        'before any worker starts; run the tests through vitest with the repo config, or run `npm run build`.',
    );
  }
}

// Build-input files outside `source/` that change the generated `dist/`.
// Forgetting these in the mtime set means editing tsup.config.ts or
// tsconfig.json won't trigger a local-dev rebuild, and the E2E suite
// will spawn a stale `dist/cli.js` with the old toolchain settings.
const BUILD_CONFIG_FILES = ['tsup.config.ts', 'tsconfig.json', 'package.json'];

/** tsup failed, or succeeded without writing every artifact. */
class BuildFailure extends Error {}

/** One build attempt; `capture` pipes the output instead of streaming it. */
export type BuildRunner = (capture: boolean) => BuildResult;

/**
 * Builds `dist/` if any build input is newer than it, or if a `dist/` artifact is
 * missing, else returns instantly. Throws `BuildFailure` when tsup fails twice.
 * Reached only through `buildForRun()` from the global setup, in the main
 * process, so exactly one build runs at a time.
 */
export async function buildIfStale(
  root: string = REPO_ROOT,
  run: BuildRunner = (capture) => runBuild(root, capture),
): Promise<void> {
  const distMtime = await earliestMtime(DIST_ARTIFACTS.map((rel) => path.join(root, rel)));
  const configPaths = BUILD_CONFIG_FILES.map((f) => path.join(root, f));
  const srcMtime = await latestMtime([...(await walkSources(root)), ...configPaths]);

  // Cache hit requires the OLDEST artifact to be newer than every input;
  // earliestMtime is null when any artifact is missing. An interrupted build
  // can leave a fresh cli.js beside a stale or missing command file, so
  // neither the newest artifact nor cli.js alone can stand for dist/.
  if (distMtime !== null && srcMtime !== null && distMtime >= srcMtime) {
    return; // cache hit
  }

  // First attempt streams to the terminal so a local `npm test` still shows
  // live build progress. The retry captures instead, so a real failure can
  // report why rather than just an exit code.
  let result = run(false);

  if (!buildSucceeded(result)) {
    // Retry once. `tsup` here is deterministic and idempotent, so a retry
    // cannot mask a genuine breakage — a broken build fails twice. What it
    // absorbs is contention: a CPU-starved build failure here fails the whole
    // run (#144). `npm run build` succeeds standalone every time.
    result = run(true);
  }

  if (!buildSucceeded(result)) {
    throw new BuildFailure(describeBuildFailure(result));
  }

  // Sanity: a zero exit must have produced every artifact the workers check
  // for, so a gap fails here, in the setup, rather than in every worker.
  const missing = await missingArtifacts(root);
  if (missing.length > 0) {
    throw new BuildFailure(`tsup exited 0 but did not write: ${missing.join(', ')}`);
  }
}

/**
 * The global setup's entry: builds if stale and returns the failure message
 * instead of throwing. A throw from the setup would abort the whole run, unit
 * tests included; returned, it reaches only the tests that spawn the CLI,
 * through `ensureBuilt()`.
 */
export async function buildForRun(
  root: string = REPO_ROOT,
  run?: BuildRunner,
): Promise<string | null> {
  try {
    await buildIfStale(root, run);
    return null;
  } catch (err) {
    // A build failure's message says all there is; anything else is a bug in
    // this guard, so keep its stack.
    if (err instanceof BuildFailure) return err.message;
    return err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
}

/**
 * Wall-clock cap for a single build attempt. Generous — a cold tsup run on a
 * loaded CI box is a few seconds, so anything approaching this is wedged rather
 * than slow. Without it a hung `npx` blocks until the suite-level timeout and
 * reports nothing useful.
 */
const BUILD_TIMEOUT_MS = 180_000;

/**
 * Tied to the options `runBuild()` actually passes.
 *
 * `ReturnType<typeof spawnSync>` resolves against the LAST overload in Node's
 * typings, so it drifts across `@types/node` upgrades and can disagree with the
 * `encoding: 'utf-8'` option below — which is what decides whether `stdout` and
 * `stderr` are `string` or `Buffer`.
 */
type BuildResult = SpawnSyncReturns<string>;

function runBuild(root: string, capture: boolean): BuildResult {
  return spawnSync('npx', ['tsup'], {
    cwd: root,
    stdio: capture ? 'pipe' : 'inherit',
    // On Windows, `npx` is a cmd shim — spawn must use `shell: true` to
    // invoke it. On POSIX, shell adds no overhead worth avoiding here.
    shell: true,
    timeout: BUILD_TIMEOUT_MS,
    encoding: 'utf-8',
  });
}

function buildSucceeded(result: BuildResult): boolean {
  return result.error === undefined && result.signal === null && result.status === 0;
}

/**
 * Distinguish the three ways this can fail. The previous message reported only
 * `status`, which is `null` for a timeout or signal kill — so the most common
 * real failure printed "exit code null".
 */
function describeBuildFailure(result: BuildResult): string {
  const tail = (s: string | null | undefined): string => {
    const text = (s ?? '').trim();
    if (text === '') return '';
    const lines = text.split('\n');
    return `\n${lines.slice(-20).join('\n')}`;
  };

  if (result.error !== undefined) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return timedOut
      ? `tsup build timed out after ${BUILD_TIMEOUT_MS}ms (retried once)${tail(result.stderr)}`
      : `tsup build could not be spawned: ${result.error.message}`;
  }
  if (result.signal !== null) {
    return `tsup build was killed by ${result.signal} (retried once)${tail(result.stderr)}`;
  }
  return `tsup build failed with exit code ${result.status} (retried once)${tail(result.stderr)}`;
}

async function walkSources(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [path.join(root, 'source')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

async function earliestMtime(paths: string[]): Promise<number | null> {
  let earliest: number | null = null;
  for (const p of paths) {
    try {
      const ms = (await fs.stat(p)).mtimeMs;
      if (earliest === null || ms < earliest) earliest = ms;
    } catch {
      return null; // a missing artifact is never fresh
    }
  }
  return earliest;
}

async function latestMtime(paths: string[]): Promise<number | null> {
  let latest: number | null = null;
  for (const p of paths) {
    try {
      const stat = await fs.stat(p);
      const ms = stat.mtimeMs;
      if (latest === null || ms > latest) latest = ms;
    } catch {
      // missing file — pass-through; the caller decides whether that's
      // a cache miss (dist) or a no-op (source — shouldn't happen).
    }
  }
  return latest;
}
