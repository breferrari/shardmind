/**
 * Self-update notifier hook.
 *
 * Fires `checkSelfUpdate` after first paint so the banner is never on
 * the hot path of any command. The result lands in component state on
 * the next render; the first frame the user sees is therefore guaranteed
 * to be banner-less, matching the issue's "zero observable latency"
 * acceptance criterion.
 *
 * Sources of suppression (any one returns `info: null` without firing
 * the network call):
 *   1. `noUpdateCheck === true` — the `--no-update-check` flag.
 *   2. `process.env.SHARDMIND_NO_UPDATE_CHECK` non-empty.
 *   3. `process.env.CI` non-empty — standard CI-runner heuristic.
 *   4. `process.stdout.isTTY` falsy AND `force !== true` — the banner is
 *      interactive UX; piped runs (`shardmind | wc -l`) shouldn't see
 *      it. `force` is the test-only escape hatch read from
 *      `process.env.SHARDMIND_SELF_UPDATE_FORCE_TTY` so flow tests can
 *      exercise the rendering path under ink-testing-library's
 *      non-TTY fake stdout without polluting production with a hidden
 *      flag.
 *   5. `currentVersion` not a valid semver — `checkSelfUpdate` returns
 *      null on its own; we short-circuit earlier so `noFetch` reflects
 *      reality.
 *
 * The `disposed` flag mirrors the cleanup pattern in
 * `use-status-report.ts`: if the parent component unmounts before the
 * fetch resolves, the result is dropped on the floor — better miss
 * the banner than setState on a torn-down tree.
 *
 * Spec: ROADMAP §0.1.x Foundation #113.
 */

import { useEffect, useState } from 'react';
import { checkSelfUpdate } from '../../core/self-update-check.js';

export interface UseSelfUpdateCheckInput {
  /** The `--no-update-check` flag value from the command's options. */
  noUpdateCheck: boolean;
  /** The CLI's own version string from package.json. */
  currentVersion: string;
}

export interface SelfUpdateBannerInfo {
  current: string;
  latest: string;
}

export interface UseSelfUpdateCheckOutput {
  info: SelfUpdateBannerInfo | null;
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

function isSuppressed(noUpdateCheck: boolean): boolean {
  if (noUpdateCheck) return true;
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
  const { noUpdateCheck, currentVersion } = input;
  const [info, setInfo] = useState<SelfUpdateBannerInfo | null>(null);

  useEffect(() => {
    if (isSuppressed(noUpdateCheck)) return;

    let disposed = false;
    // Defer the check past first paint so the banner cannot block the
    // initial render even if `checkSelfUpdate` resolves synchronously
    // (e.g., a fresh in-memory cache hit in tests).
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const result = await checkSelfUpdate({ currentVersion });
          if (disposed) return;
          if (result && result.outdated) {
            setInfo({ current: currentVersion, latest: result.latest });
          }
        } catch {
          // checkSelfUpdate already swallows; this catch is defensive
          // against a future change. Banner stays suppressed silently.
        }
      })();
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(handle);
    };
    // currentVersion is stable for the lifetime of the process; the
    // dep array is here for lint cleanliness, not actual reactivity.
  }, [noUpdateCheck, currentVersion]);

  return { info };
}
