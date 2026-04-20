/**
 * 24-hour cached "what's the latest version of this shard on GitHub?" lookup.
 *
 * Why it exists:
 *   The status command (`shardmind`) and the update command (`shardmind update`)
 *   both need to answer "is there a newer version available?". Status runs
 *   ambiently — a user may invoke it many times a day — so every run making a
 *   fresh GitHub API call would burn the 60-req/hr unauthenticated rate limit
 *   and add seconds of latency to a command that should feel instant. Update
 *   already pays for a full `resolve()` + tarball download, so it's a natural
 *   cache writer: after it learns the latest version, it leaves the answer
 *   in the cache for the next status invocation to read for free.
 *
 * Cache file: `.shardmind/update-check.json` (vault-local, next to state.json).
 *
 * TTL: 24 hours. Any read older than that re-fetches from GitHub, succeeds or
 *   falls back to the stale value. This matches ROADMAP.md v0.2 item #51 — the
 *   status command depends on this cache to be useful, so it's built here.
 *
 * Safety properties:
 *   - Writes are atomic (write-to-tempfile + rename) so a crashed or concurrent
 *     writer cannot leave a half-written JSON for the next reader to parse.
 *   - Corrupt JSON is treated as absent and deleted on sight — no exception
 *     leaks to the caller because status must never fail on cache pathology.
 *   - Source mismatch (user reinstalled from a different repo under the same
 *     vault) invalidates the cache automatically — `latest_version` for repo A
 *     must not be reported as the latest for repo B.
 *   - Network failure with a previous cache entry returns the stale entry
 *     marked `stale: true`; the caller can decide whether to show it. Network
 *     failure with no entry returns `null` so the caller can render "unknown"
 *     rather than invent a version.
 *   - Clock skew (future `checked_at`, impossible age) is treated as stale
 *     rather than as a live entry, mirroring the posture in drift detection.
 *
 * See docs/IMPLEMENTATION.md §4.15 for the full contract.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ShardMindError } from '../runtime/types.js';
import { SHARDMIND_DIR } from '../runtime/vault-paths.js';
import { errnoCode } from '../runtime/errno.js';
import { fetchLatestVersion } from './registry.js';

/**
 * Cache entry shape. `schema_version` is tracked so a future incompatible
 * change (e.g., storing a list of candidate versions) can invalidate old
 * caches deterministically instead of accidentally mis-parsing them.
 */
interface UpdateCheck {
  schema_version: 1;
  /** ISO 8601 timestamp of the last successful fetch. */
  checked_at: string;
  /** The `state.source` string the answer was fetched for. Mismatches invalidate. */
  source: string;
  /** Normalized semver (no leading `v`). */
  latest_version: string;
}

/**
 * Result of `getLatestVersion`. Callers use the discriminant to decide whether
 * to present the answer as authoritative (`fresh`), cached-but-known-stale
 * (`stale` — network currently down), or unavailable (`unknown` — no cache
 * and the network is unreachable).
 *
 * `cacheHealed` is set when the previous cache entry was found corrupt
 * (bad JSON, wrong shape, or a directory at the cache path) and the
 * reader self-healed by deleting it. Verbose-mode callers can surface
 * this as a diagnostic (`UPDATE_CHECK_CACHE_CORRUPT`) so a user
 * investigating flakiness can see their cache was transiently broken.
 * Every other caller ignores the flag — the healing already happened.
 */
export type UpdateCheckResult = (
  | { kind: 'fresh'; latest_version: string; checked_at: string }
  | { kind: 'stale'; latest_version: string; checked_at: string; reason: 'no-network' }
  | { kind: 'unknown'; reason: 'no-network' | 'unsupported-source' }
) & {
  cacheHealed?: boolean;
};

/**
 * Result of `readCache`. `cache` is the parsed entry or `null` for any
 * unusable condition. `corruptHealed` signals that a pre-existing file
 * was deleted because it was unparseable — the next write will repopulate.
 */
export interface ReadCacheResult {
  cache: UpdateCheck | null;
  corruptHealed: boolean;
}

export const CACHE_FILENAME = 'update-check.json';
export const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const CACHE_SCHEMA_VERSION = 1 as const;

function cachePath(vaultRoot: string): string {
  return path.join(vaultRoot, SHARDMIND_DIR, CACHE_FILENAME);
}

/**
 * Read the cache file. Returns `null` for any condition that makes the cache
 * unusable: missing, unparseable JSON, wrong shape, wrong schema_version. A
 * corrupt file is best-effort deleted so the next successful fetch can write
 * a clean replacement — we can't leave it there because a half-written file
 * from a crashed process would keep resurfacing.
 *
 * Never throws on cache pathology — pathology here is a status-UX degradation,
 * not a user-facing failure mode.
 */
export async function readCache(vaultRoot: string): Promise<ReadCacheResult> {
  const filePath = cachePath(vaultRoot);

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return { cache: null, corruptHealed: false };
    // If the cache path is a directory (user manually created
    // `.shardmind/update-check.json/` as a folder — rare but possible), a
    // plain read returns EISDIR and recurs forever unless we heal it. Unlike
    // permission-denied, which the user has to fix themselves, a stale
    // directory at our cache path is safe to delete on sight. Flag as
    // corruption-healed so the verbose status view can surface it.
    if (code === 'EISDIR') {
      await deleteCache(vaultRoot);
      return { cache: null, corruptHealed: true };
    }
    // Permission / other I/O error on a file that exists: treat as absent.
    // The user can still use the command; status just won't know the latest
    // version until the next successful write happens.
    return { cache: null, corruptHealed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await deleteCache(vaultRoot);
    return { cache: null, corruptHealed: true };
  }

  if (!isValidCacheShape(parsed)) {
    await deleteCache(vaultRoot);
    return { cache: null, corruptHealed: true };
  }

  return { cache: parsed, corruptHealed: false };
}

/**
 * Write the cache atomically: serialize → write temp → rename into place.
 * Rename is atomic on the same filesystem, which is the only case we care
 * about here (cache lives next to state.json, same directory). This means a
 * reader concurrent with a writer either sees the previous full file or the
 * new full file — never a half-written body.
 *
 * Swallows all errors. The caller shouldn't be told the cache write failed:
 * the fetch itself succeeded, the user gets the live answer, and the next
 * invocation will just re-fetch.
 */
export async function writeCache(vaultRoot: string, entry: UpdateCheck): Promise<void> {
  const filePath = cachePath(vaultRoot);
  const dir = path.dirname(filePath);
  // Temp name includes pid to avoid collisions with a second writer in the
  // same millisecond. Rename is atomic: concurrent writers can't produce an
  // interleaved file — readers always see one complete version or another.
  // Last-rename-wins ordering is acceptable because any live fetch answer
  // is, by definition, current as of seconds ago.
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmpPath, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
    // Windows antivirus scanners briefly hold write-locks on new files;
    // a first-try rename can fail with EPERM/EBUSY. One 50 ms retry turns
    // the common transient case into a non-issue without retry storms.
    try {
      await fsp.rename(tmpPath, filePath);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
      await fsp.rename(tmpPath, filePath);
    }
  } catch {
    // Best-effort: clean up the tmp if it got created.
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch {
      // nothing useful to do
    }
  }
}

/**
 * Remove the cache entry. Used after a corrupt-JSON read or when the cache
 * path resolves to a directory (EISDIR self-heal). `recursive` covers the
 * directory case; `force` covers the already-gone case. Swallows errors so
 * cleanup failures can't fail a command.
 */
async function deleteCache(vaultRoot: string): Promise<void> {
  try {
    await fsp.rm(cachePath(vaultRoot), { force: true, recursive: true });
  } catch {
    // swallow
  }
}

/**
 * Public entry point used by the status command.
 *
 * Strategy:
 *   1. Read cache. If fresh and source matches, return `fresh`.
 *   2. Otherwise fetch from GitHub with a 4s timeout. On success, write the
 *      cache and return `fresh`.
 *   3. On fetch failure:
 *        a. If we have a previous cache entry (regardless of staleness),
 *           return it as `stale` so the user still sees useful information.
 *        b. Otherwise return `unknown`.
 *
 * `source` is the `state.source` string (`"github:owner/repo"`). Unsupported
 * source shapes short-circuit to `unknown` rather than throwing — a user on
 * an experimental source type shouldn't have status blow up on them.
 *
 * `now` is injectable for tests. Defaults to `Date.now()`.
 */
export async function getLatestVersion(
  vaultRoot: string,
  source: string,
  now: number = Date.now(),
): Promise<UpdateCheckResult> {
  if (!source.startsWith('github:')) {
    return { kind: 'unknown', reason: 'unsupported-source' };
  }

  const { cache: cached, corruptHealed } = await readCache(vaultRoot);

  // `attachHealed` stamps the corruption-healed flag onto any result we
  // return, so a one-time corrupt read surfaces in verbose status output
  // exactly once — the next invocation reads the clean replacement and
  // reports no healing.
  const attachHealed = <T extends UpdateCheckResult>(result: T): T =>
    corruptHealed ? { ...result, cacheHealed: true } : result;

  if (cached && cached.source === source && isFresh(cached, now)) {
    return attachHealed({
      kind: 'fresh',
      latest_version: cached.latest_version,
      checked_at: cached.checked_at,
    });
  }

  let latest: string;
  try {
    latest = await fetchWithTimeout(source);
  } catch {
    // Network failed. Fall back to the cached entry only when it was
    // written for the SAME source — reporting a latest_version from a
    // different repo after a reinstall would directly contradict the
    // source-mismatch invariant stated at the top of this module and
    // would mislead offline users. A mismatched-source entry degrades
    // to `unknown` just like a missing cache would.
    if (cached && cached.source === source) {
      return attachHealed({
        kind: 'stale',
        latest_version: cached.latest_version,
        checked_at: cached.checked_at,
        reason: 'no-network',
      });
    }
    return attachHealed({ kind: 'unknown', reason: 'no-network' });
  }

  const checked_at = new Date(clamp(now)).toISOString();
  await writeCache(vaultRoot, {
    schema_version: CACHE_SCHEMA_VERSION,
    checked_at,
    source,
    latest_version: latest,
  });

  return attachHealed({ kind: 'fresh', latest_version: latest, checked_at });
}

/**
 * Called by the update command after `resolve()` succeeds. Lets update's
 * existing network call warm the cache so the next `shardmind` invocation
 * is instant. Swallows errors — a priming failure must not cascade into an
 * update failure. Non-github sources are a no-op.
 */
export async function primeLatestVersion(
  vaultRoot: string,
  source: string,
  latest_version: string,
  now: number = Date.now(),
): Promise<void> {
  if (!source.startsWith('github:')) return;
  if (!latest_version || typeof latest_version !== 'string') return;

  await writeCache(vaultRoot, {
    schema_version: CACHE_SCHEMA_VERSION,
    checked_at: new Date(clamp(now)).toISOString(),
    source,
    latest_version,
  });
}

function isFresh(cache: UpdateCheck, now: number): boolean {
  const checkedAtMs = Date.parse(cache.checked_at);
  if (!Number.isFinite(checkedAtMs)) return false;
  // Clock-skew guard: if `checked_at` is in the future by any amount, treat
  // the cache as stale — we don't trust future-dated entries and a re-fetch
  // costs one API call. Same posture as drift's installed_at handling.
  if (checkedAtMs > now) return false;
  return now - checkedAtMs < TTL_MS;
}

function isValidCacheShape(value: unknown): value is UpdateCheck {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['schema_version'] === CACHE_SCHEMA_VERSION &&
    typeof v['checked_at'] === 'string' &&
    typeof v['source'] === 'string' &&
    typeof v['latest_version'] === 'string' &&
    v['latest_version'].length > 0 &&
    v['source'].length > 0
  );
}

/**
 * Invoke the registry lookup with a wall-clock timeout so a hanging TCP
 * connection can't stall status for longer than the user is willing to wait.
 *
 * The timeout is enforced by `AbortController` — the signal threads down
 * through `fetchLatestVersion` → `fetchLatestRelease` → `safeFetch` → `fetch`
 * so an expired budget actually cancels the socket. A previous implementation
 * used `Promise.race` around the fetch, which resolved the caller but left
 * the underlying `fetch` running until the OS closed the socket (minutes on
 * a poorly-terminated connection). `AbortController` is the correct primitive.
 */
async function fetchWithTimeout(source: string): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    return await fetchLatestVersion(source, { signal: controller.signal });
  } catch (err) {
    // Translate a budget-exceeded abort into a typed, user-recognizable error.
    // Without this the upstream fetch chain wraps the DOMException "AbortError"
    // as a generic REGISTRY_NETWORK "Could not reach api.github.com", which is
    // true but hides the specific cause (our budget, not the server's fault).
    // The caller (`getLatestVersion`) still catches this and degrades to stale
    // or unknown — UPDATE_CHECK_FAILED is visible only if verbose surfacing is
    // ever wired up, but the typed code preserves the distinction.
    if (timedOut) {
      throw new ShardMindError(
        `Update check timed out after ${FETCH_TIMEOUT_MS}ms`,
        'UPDATE_CHECK_FAILED',
        'Network is slow or unresponsive; status will fall back to cached data.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Guard against a clock returning a non-finite value (mocked test clocks,
 * broken VM hosts) by clamping to epoch. An absent/zero time is fine; a NaN
 * turned into an ISO string would crash.
 */
function clamp(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms;
}
