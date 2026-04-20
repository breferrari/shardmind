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

async function doBuild(): Promise<void> {
  const distMtime = await latestMtime([DIST_CLI, DIST_RUNTIME]);
  const srcMtime = await latestMtime(await walkSources());

  if (distMtime !== null && srcMtime !== null && distMtime >= srcMtime) {
    return; // cache hit
  }

  const result = spawnSync('npx', ['tsup'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // On Windows, `npx` is a cmd shim — spawn must use `shell: true` to
    // invoke it. On POSIX, shell adds no overhead worth avoiding here.
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`tsup build failed with exit code ${result.status}`);
  }

  // Sanity: dist/cli.js must exist now.
  await fs.access(DIST_CLI);
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
