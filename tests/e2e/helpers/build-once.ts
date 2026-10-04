/**
 * Build guard for the suites that spawn `dist/cli.js` (E2E, Layer 2 PTY, and
 * the Layer 1 flow tests through `createInstalledVault`).
 *
 * `dist/` is built once per vitest run, in the main process, before any worker
 * starts: `tests/global-setup.ts` calls `buildIfStale()`, and again before each
 * watch-mode rerun. Workers call `ensureBuilt()`, which only checks that the
 * artifacts exist and never writes `dist/`.
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

/** The artifacts the tests spawn or import, under a repo root. */
function distPaths(root: string): { cli: string; runtime: string } {
  return {
    cli: path.join(root, 'dist', 'cli.js'),
    runtime: path.join(root, 'dist', 'runtime', 'index.js'),
  };
}

export const DIST_CLI = distPaths(REPO_ROOT).cli;

/**
 * Worker-side check: resolves when `dist/` holds the artifacts the tests
 * spawn, rejects otherwise. Never builds — see the file header.
 */
export async function ensureBuilt(root: string = REPO_ROOT): Promise<void> {
  const { cli, runtime } = distPaths(root);
  for (const artifact of [cli, runtime]) {
    if (!(await pathExists(artifact))) {
      throw new Error(
        `${artifact} is missing. The vitest global setup (tests/global-setup.ts) builds dist/ ` +
          'before any worker starts; run the tests through vitest with the repo config, or run `npm run build`.',
      );
    }
  }
}

// Build-input files outside `source/` that change the generated `dist/`.
// Forgetting these in the mtime set means editing tsup.config.ts or
// tsconfig.json won't trigger a local-dev rebuild, and the E2E suite
// will spawn a stale `dist/cli.js` with the old toolchain settings.
const BUILD_CONFIG_FILES = ['tsup.config.ts', 'tsconfig.json', 'package.json'];

/** One build attempt; `capture` pipes the output instead of streaming it. */
export type BuildRunner = (capture: boolean) => BuildResult;

/**
 * Builds `dist/` if any build input is newer than it, or if a `dist/` artifact is
 * missing, else returns instantly. Called only from the global setup, in the
 * main process, so exactly one build runs at a time.
 */
export async function buildIfStale(
  root: string = REPO_ROOT,
  run: BuildRunner = (capture) => runBuild(root, capture),
): Promise<void> {
  const { cli, runtime } = distPaths(root);
  const distMtime = await latestMtime([cli, runtime]);
  const configPaths = BUILD_CONFIG_FILES.map((f) => path.join(root, f));
  const srcMtime = await latestMtime([...(await walkSources(root)), ...configPaths]);

  // Cache hit requires EVERY required artifact to exist on disk — not
  // just that something in dist/ is newer than source. Using
  // latestMtime's max means one missing required file (e.g. dist/cli.js)
  // can still produce a fresh-enough timestamp if a sibling
  // happens to be recent. Verify both artifacts exist before skipping the
  // build, so ensureBuilt() in the workers always finds them.
  const allExist = (await pathExists(cli)) && (await pathExists(runtime));
  if (allExist && distMtime !== null && srcMtime !== null && distMtime >= srcMtime) {
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
    throw new Error(describeBuildFailure(result));
  }

  // Sanity: dist/cli.js must exist now.
  await fs.access(cli);
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
