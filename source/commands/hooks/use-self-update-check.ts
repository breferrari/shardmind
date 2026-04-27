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
 *   4. `process.stdout.isTTY` falsy AND no
 *      `process.env.SHARDMIND_SELF_UPDATE_FORCE_TTY` override — the
 *      banner is interactive UX; piped runs (`shardmind | wc -l`)
 *      shouldn't see it. The force-TTY env var is a test-only escape
 *      hatch so flow tests can exercise the rendering path under
 *      ink-testing-library's non-TTY fake stdout without polluting
 *      production with a hidden flag.
 *
 * Invalid `currentVersion` (not a valid semver) is NOT pre-filtered
 * here; `checkSelfUpdate` returns `null` on its own and the banner
 * stays suppressed. Mentioning it in the suppression list above would
 * misrepresent where the short-circuit lives.
 *
 * The `disposed` flag and the AbortController together mirror the
 * cleanup pattern in `use-status-report.ts`: if the parent unmounts
 * before the fetch resolves, the disposed flag suppresses any
 * post-resolution `setState`, AND the controller aborts the in-flight
 * `fetch` so the socket closes promptly instead of dangling until the
 * 3-second timeout. Better to miss the banner than to keep network
 * handles alive past the command's lifetime.
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
    const controller = new AbortController();
    // Defer the check past first paint so the banner cannot block the
    // initial render even if `checkSelfUpdate` resolves synchronously
    // (e.g., a fresh in-memory cache hit in tests).
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const result = await checkSelfUpdate({
            currentVersion,
            signal: controller.signal,
          });
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
      // Abort the in-flight fetch so an unmounted command doesn't keep
      // a TCP connection open until the 3s timeout expires.
      controller.abort();
    };
    // currentVersion and noUpdateCheck are stable per command instance;
    // the dep array is here for lint cleanliness. Closure isolation
    // means a hypothetical re-run still won't leak: the previous run's
    // `disposed` and `controller` are captured locally.
  }, [noUpdateCheck, currentVersion]);

  return { info };
}
