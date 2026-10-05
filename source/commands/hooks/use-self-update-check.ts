/**
 * Self-update notifier hook.
 *
 * Reads the 24h npm cache after first paint, and never calls npm itself
 * (#285): a fresh outdated answer becomes the banner on the next render,
 * and a stale or missing cache starts a detached refresh child
 * (`spawnSelfUpdateRefresh`) that writes the cache for the next run. The
 * first frame the user sees is therefore banner-less, and no command waits
 * on the network. `cacheRead` tells status when it may exit: once the local
 * read is done, so a cached banner always renders on the fast command.
 *
 * Sources of suppression (any one returns `info: null` without reading
 * the cache or starting a refresh):
 *   1. `updateCheck === false` — the `--no-update-check` flag.
 *   2. `process.env.SHARDMIND_NO_UPDATE_CHECK` non-empty.
 *   3. `process.env.CI` non-empty — standard CI-runner heuristic.
 *   4. `process.stdout.isTTY` falsy AND no
 *      `process.env.SHARDMIND_SELF_UPDATE_FORCE_TTY` override — the
 *      banner is interactive UX; piped runs (`shardmind | wc -l`)
 *      shouldn't see it. The force-TTY env var is a test-only escape
 *      hatch so flow tests can exercise the rendering path under
 *      ink-testing-library's non-TTY fake stdout without polluting
 *      production with a hidden flag.
 *
 * Invalid `currentVersion` (not a valid semver) is NOT pre-filtered
 * here; `readSelfUpdateCache` returns `null` on its own, so the banner
 * stays suppressed and no refresh starts.
 *
 * The `disposed` flag keeps an unmounted command from setting state. A
 * refresh child already started is detached and unref'd, and it outlives
 * the command by design (at most about 5 s, §4.19).
 *
 * Spec: ROADMAP §0.1.x Foundation #113.
 */

import { useEffect, useState } from 'react';
import { readSelfUpdateCache, spawnSelfUpdateRefresh } from '../../core/self-update-check.js';

export interface UseSelfUpdateCheckInput {
  /** The command's `updateCheck` option: `false` when `--no-update-check` was passed. */
  updateCheck: boolean;
  /** The CLI's own version string from package.json. */
  currentVersion: string;
}

export interface SelfUpdateBannerInfo {
  current: string;
  latest: string;
}

export interface UseSelfUpdateCheckOutput {
  info: SelfUpdateBannerInfo | null;
  /** The cache read is done (at once when suppressed): status may exit. */
  cacheRead: boolean;
}

/**
 * Returns `true` if the test-only force-TTY escape hatch is set in
 * env. Production code never sets this — it only exists to let
 * Layer 1 flow tests, which run under ink-testing-library's
 * non-TTY fake stdout, exercise the rendering path.
 */
function shouldForceTty(): boolean {
  const v = process.env['SHARDMIND_SELF_UPDATE_FORCE_TTY'];
  return v !== undefined && v.length > 0;
}

function isSuppressed(updateCheck: boolean): boolean {
  if (!updateCheck) return true;
  const noEnv = process.env['SHARDMIND_NO_UPDATE_CHECK'];
  if (noEnv && noEnv.length > 0) return true;
  const ciEnv = process.env['CI'];
  if (ciEnv && ciEnv.length > 0) return true;
  if (!process.stdout.isTTY && !shouldForceTty()) return true;
  return false;
}

export function useSelfUpdateCheck(
  input: UseSelfUpdateCheckInput,
): UseSelfUpdateCheckOutput {
  const { updateCheck, currentVersion } = input;
  const [info, setInfo] = useState<SelfUpdateBannerInfo | null>(null);
  const [cacheRead, setCacheRead] = useState(() => isSuppressed(updateCheck));

  useEffect(() => {
    if (isSuppressed(updateCheck)) {
      setCacheRead(true);
      return;
    }

    let disposed = false;
    // Defer past first paint so the banner never lands in the first frame,
    // even when the cache read resolves at once.
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const read = await readSelfUpdateCache({ currentVersion });
          if (read && !read.fresh) {
            // Detached and unref'd: the command never waits for npm, and the
            // child's cache write is for the next run (#285).
            spawnSelfUpdateRefresh({ currentVersion });
          } else if (read?.outdated && !disposed) {
            setInfo({ current: currentVersion, latest: read.latest });
          }
        } catch {
          // readSelfUpdateCache swallows; this catch is defensive against a
          // future change. The banner stays suppressed silently.
        } finally {
          if (!disposed) setCacheRead(true);
        }
      })();
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(handle);
    };
    // currentVersion and updateCheck are stable per command instance;
    // the dep array is here for lint cleanliness.
  }, [updateCheck, currentVersion]);

  return { info, cacheRead };
}
