/**
 * Idempotent build guard for the E2E suite.
 *
 * The E2E tests run `dist/cli.js` as a subprocess, which means the build
 * artifact must exist before any test spawns. `ensureBuilt()` is called
 * once in `beforeAll` and short-circuits when the on-disk artifact is
 * newer than every source file — so repeated test runs on an untouched
 * tree don't pay the ~3s tsup cost.
 *
 * CI runs `npm run build` explicitly before `npm test` (see
 * .github/workflows/ci.yml). This guard exists for the local
 * developer flow where running `npm test` after an edit should Just Work.
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
export const DIST_RUNTIME = path.join(REPO_ROOT, 'dist', 'runtime', 'index.js');

let builtOncePromise: Promise<void> | null = null;

/**
 * Builds `dist/` if any source file is newer than `dist/cli.js`, else
 * returns instantly. Memoized per-process so parallel test workers don't
 * race on tsup invocations.
 */
export function ensureBuilt(): Promise<void> {
  if (!builtOncePromise) builtOncePromise = doBuild();
  return builtOncePromise;
}

// Build-input files outside `source/` that change the generated `dist/`.
// Forgetting these in the mtime set means editing tsup.config.ts or
// tsconfig.json won't trigger a local-dev rebuild, and the E2E suite
// will spawn a stale `dist/cli.js` with the old toolchain settings.
const BUILD_CONFIG_FILES = ['tsup.config.ts', 'tsconfig.json', 'package.json'];

async function doBuild(): Promise<void> {
  const distMtime = await latestMtime([DIST_CLI, DIST_RUNTIME]);
  const configPaths = BUILD_CONFIG_FILES.map((f) => path.join(REPO_ROOT, f));
  const srcMtime = await latestMtime([...(await walkSources()), ...configPaths]);

  // Cache hit requires EVERY required artifact to exist on disk — not
  // just that something in dist/ is newer than source. Using
  // latestMtime's max means one missing required file (e.g. dist/cli.js)
  // can still produce a fresh-enough timestamp if a sibling
  // (dist/runtime/index.js) happens to be recent. Verify DIST_CLI
  // explicitly before skipping the build.
  const cliExists = await fs
    .access(DIST_CLI)
    .then(() => true)
    .catch(() => false);
  if (cliExists && distMtime !== null && srcMtime !== null && distMtime >= srcMtime) {
    return; // cache hit
  }

  // First attempt streams to the terminal so a local `npm test` still shows
  // live build progress. The retry captures instead, so a real failure can
  // report why rather than just an exit code.
  let result = runBuild(false);

  if (!buildSucceeded(result)) {
    // Retry once. `tsup` here is deterministic and idempotent, so a retry
    // cannot mask a genuine breakage — a broken build fails twice. What it
    // absorbs is contention: this runs inside `beforeAll`, so one CPU-starved
    // build failure skips every test in the file (#144), and the skip count is
    // the only symptom. `npm run build` succeeds standalone every time.
    result = runBuild(true);
  }

  if (!buildSucceeded(result)) {
    throw new Error(describeBuildFailure(result));
  }

  // Sanity: dist/cli.js must exist now.
  await fs.access(DIST_CLI);
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

function runBuild(capture: boolean): BuildResult {
  return spawnSync('npx', ['tsup'], {
    cwd: REPO_ROOT,
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

async function walkSources(): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [path.join(REPO_ROOT, 'source')];
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
