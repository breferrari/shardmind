/**
 * Detached self-update refresh (#285, IMPLEMENTATION §4.19).
 *
 * Spawned by `spawnSelfUpdateRefresh` when a command finds the npm cache
 * stale: `node self-update-refresh.js <currentVersion> <cacheDir>`. It runs
 * `checkSelfUpdate`, which writes the cache atomically, removes the refresh
 * marker and exits. The command that spawned it never waits for it, and it
 * exits at `REFRESH_HARD_CAP_MS` whatever npm does.
 *
 * NOT public API. Imported by nothing in `source/`; only spawned.
 */

import {
  checkSelfUpdate,
  getConfiguredFetchTimeoutMs,
  releaseRefreshMarker,
  REFRESH_HARD_CAP_MS,
} from '../core/self-update-check.js';

const [currentVersion, cacheDir] = process.argv.slice(2);

if (currentVersion && cacheDir) {
  setTimeout(() => {
    releaseRefreshMarker(cacheDir);
    process.exit(0);
  }, REFRESH_HARD_CAP_MS).unref();
  try {
    // The fetch gives up before the hard cap, so the normal path ends it.
    await checkSelfUpdate({
      currentVersion,
      cacheDir,
      fetchTimeoutMs: Math.min(getConfiguredFetchTimeoutMs(), REFRESH_HARD_CAP_MS - 500),
    });
  } finally {
    releaseRefreshMarker(cacheDir);
  }
}
