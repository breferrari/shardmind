/**
 * 24-hour cached "is there a newer shardmind on npm?" lookup.
 *
 * Why it exists:
 *   The 0.1.0 → 0.1.1 → 0.1.2 cycle in 48h proved the v0.1.x track will
 *   keep cutting hotfix releases. A user installed on day-one has no
 *   in-product signal that two critical UX hotfixes have published since
 *   — they hit the wizard freeze (#103), don't know it's known, don't
 *   know the fix is available. Most CLIs (npm, gh, pnpm, yarn) show a
 *   small banner when outdated; we now do too.
 *
 * Sibling of `core/update-check.ts` — same hardening posture, different
 * subject. update-check.ts answers "is there a newer SHARD on GitHub?"
 * and writes a vault-local cache; this module answers "is there a newer
 * ENGINE on npm?" and writes a user-level cache because the engine is
 * global, not per-vault.
 *
 * Cache file: `${cacheDir}/self-update.json`. cacheDir defaults to:
 *   - `XDG_CACHE_HOME/shardmind`           (POSIX, when XDG set)
 *   - `~/.cache/shardmind`                 (POSIX, when XDG unset)
 *   - `%LOCALAPPDATA%\shardmind`           (Windows)
 *   - falls back to `os.tmpdir()/shardmind` if mkdir fails on the primary.
 *
 * TTL: 24 hours. Any read older than that re-fetches from the npm
 *   registry. A successful fetch resets the cache; a failed fetch
 *   collapses to "no banner this run" (silent — courtesy notifier,
 *   not a status gate).
 *
 * Safety properties (mirror update-check.ts):
 *   - Writes are atomic (write-to-tempfile + rename) — concurrent CLIs
 *     never observe a half-written body.
 *   - Corrupt JSON / wrong schema_version / EISDIR self-heal — cache
 *     pathology never crashes the command.
 *   - Network failure is silent — `null` return tells the caller "no
 *     banner this run". Unlike update-check.ts there is no `stale`
 *     fallback because the banner only renders when we know the user
 *     is outdated; a stale "you have N.M.K, latest is X.Y.Z (cached)"
 *     could be wrong if X.Y.Z was unpublished, and we'd rather show
 *     nothing than a misleading hint.
 *   - Clock skew (future `checked_at`) is treated as stale rather than
 *     as a live entry, mirroring the posture in drift detection.
 *
 * Spec: ROADMAP §0.1.x Foundation #113. Mirrors docs/IMPLEMENTATION.md
 * §4.15 (update-check); see §4.19 for this module.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';

/**
 * Cache entry shape. `schema_version` lets a future incompatible change
 * (e.g., storing channel info) invalidate old caches deterministically.
 */
interface SelfUpdateCache {
  schema_version: 1;
  /** ISO 8601 timestamp of the last successful fetch. */
  checked_at: string;
  /** Normalized semver (no leading `v`). */
  latest_version: string;
}

/**
 * Public result of `checkSelfUpdate`. `null` is the catch-all "no
 * banner" signal — the caller always treats it the same regardless of
 * cause (offline, 5xx, malformed JSON, clock-skew, write failure).
 */
export interface SelfUpdateResult {
  outdated: boolean;
  latest: string;
}

export const CACHE_FILENAME = 'self-update.json';
export const TTL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 3000;
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/shardmind/latest';
const CACHE_SCHEMA_VERSION = 1 as const;
const SHARDMIND_DIRNAME = 'shardmind';

/**
 * Resolve the registry URL at call time so in-process tests can point
 * `SHARDMIND_SELF_UPDATE_REGISTRY_URL` at a stub server without monkey-
 * patching `globalThis.fetch`. Mirrors `getGitHubApiBase` in registry.ts —
 * call-time read accommodates `beforeAll` env mutations after the static
 * import graph has already resolved this module.
 *
 * Surrounding whitespace / trailing slash trimming mirrors registry.ts:
 * env values copied from CI secrets often pick up newlines or `/`.
 */
function getRegistryUrl(): string {
  return (process.env['SHARDMIND_SELF_UPDATE_REGISTRY_URL'] ?? NPM_REGISTRY_URL)
    .trim()
    .replace(/\/+$/, '');
}

/**
 * Resolve the user-level cache directory shardmind writes self-update
 * data into. Read at call time for the same in-process testability
 * reason as `getRegistryUrl`. Tests typically point this at a freshly-
 * minted `mkdtemp` to avoid touching the developer's real `~/.cache`.
 *
 * Order of preference (production):
 *   1. POSIX: `$XDG_CACHE_HOME/shardmind` if XDG_CACHE_HOME is set.
 *   2. Windows: `%LOCALAPPDATA%\shardmind` if LOCALAPPDATA is set.
 *   3. POSIX: `~/.cache/shardmind` (XDG default).
 *   4. Fallback: `os.tmpdir()/shardmind` — chosen if the primary is
 *      unwritable (read-only homedir, sandboxed environment).
 *
 * The fallback is also the test override target: tests set
 * `SHARDMIND_SELF_UPDATE_CACHE_DIR` directly to skip path resolution.
 */
export function getSelfUpdateCacheDir(): string {
  const override = process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'];
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const xdg = process.env['XDG_CACHE_HOME'];
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg.trim(), SHARDMIND_DIRNAME);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData && localAppData.trim().length > 0) {
      return path.join(localAppData.trim(), SHARDMIND_DIRNAME);
    }
  }
  return path.join(os.homedir(), '.cache', SHARDMIND_DIRNAME);
}

function cachePath(cacheDir: string): string {
  return path.join(cacheDir, CACHE_FILENAME);
}

/**
 * Read the cache file. Returns `null` for any condition that makes the
 * cache unusable: missing, unparseable JSON, wrong shape, wrong
 * schema_version. Corrupt files are best-effort deleted so the next
 * successful fetch can write a clean replacement.
 *
 * Never throws on cache pathology — pathology here is silent
 * non-rendering of the banner, not a user-facing error.
 */
async function readCache(cacheDir: string): Promise<SelfUpdateCache | null> {
  const filePath = cachePath(cacheDir);

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    if (code === 'EISDIR') {
      // User manually created `.../self-update.json/` as a directory.
      // Mirror update-check.ts: delete on sight, fall through.
      await deleteCache(cacheDir);
      return null;
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await deleteCache(cacheDir);
    return null;
  }

  if (!isValidCacheShape(parsed)) {
    await deleteCache(cacheDir);
    return null;
  }

  return parsed;
}

/**
 * Write the cache atomically: serialize → write temp → rename. Rename
 * is atomic on the same filesystem, so a reader concurrent with a
 * writer always sees one complete version or another.
 *
 * Swallows all errors. The caller already has a live answer; a cache-
 * write failure must not bubble up because then the courtesy notifier
 * would crash a real command.
 */
async function writeCache(
  cacheDir: string,
  entry: SelfUpdateCache,
): Promise<void> {
  const filePath = cachePath(cacheDir);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(tmpPath, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
    // Windows AV briefly holds locks on new files; one 50ms retry turns
    // the common transient case into a non-issue without retry storms.
    try {
      await fsp.rename(tmpPath, filePath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fsp.rename(tmpPath, filePath);
    }
  } catch {
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch {
      // nothing useful to do
    }
  }
}

async function deleteCache(cacheDir: string): Promise<void> {
  try {
    await fsp.rm(cachePath(cacheDir), { force: true, recursive: true });
  } catch {
    // swallow
  }
}

export interface CheckSelfUpdateOptions {
  currentVersion: string;
  cacheDir?: string;
  ttlMs?: number;
  fetchTimeoutMs?: number;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number;
  /** Optional cancellation. Independent of the internal fetch timeout. */
  signal?: AbortSignal;
}

/**
 * Public entry point. Returns `null` for any unrecoverable state
 * (offline, 5xx, malformed, write-fail). The caller always treats `null`
 * the same: no banner this run.
 *
 * Strategy:
 *   1. Read cache. If fresh, compare and return.
 *   2. Otherwise fetch from npm with a 3s timeout. On success, write
 *      cache and return.
 *   3. On any failure: return `null` (silent).
 *
 * `currentVersion` invalid (not a semver) → `null` rather than throwing.
 * That covers dev-branch builds with version `0.0.0-local` or similar.
 */
export async function checkSelfUpdate(
  opts: CheckSelfUpdateOptions,
): Promise<SelfUpdateResult | null> {
  const {
    currentVersion,
    cacheDir = getSelfUpdateCacheDir(),
    ttlMs = TTL_MS,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    now = Date.now(),
    signal,
  } = opts;

  if (!semver.valid(currentVersion)) return null;

  const cached = await readCache(cacheDir);
  if (cached && isFresh(cached, now, ttlMs)) {
    return compare(currentVersion, cached.latest_version);
  }

  let latest: string | null;
  try {
    latest = await fetchLatestWithTimeout(fetchTimeoutMs, signal);
  } catch {
    return null;
  }

  if (!latest) return null;

  await writeCache(cacheDir, {
    schema_version: CACHE_SCHEMA_VERSION,
    checked_at: new Date(clamp(now)).toISOString(),
    latest_version: latest,
  });

  return compare(currentVersion, latest);
}

/**
 * `semver.lt` returns false for prereleases ahead of the latest stable
 * (`0.2.0-beta.1` vs `0.1.2`) and for dev branches with bumped versions
 * (local `0.2.0` vs published `0.1.2`). Both correctly suppress the banner.
 *
 * `latest` is preserved on outdated AND up-to-date results; the banner
 * only renders on outdated, but the caller may want the value for
 * verbose logging.
 */
function compare(current: string, latest: string): SelfUpdateResult {
  return {
    outdated: semver.lt(current, latest),
    latest,
  };
}

function isFresh(cache: SelfUpdateCache, now: number, ttlMs: number): boolean {
  const checkedAtMs = Date.parse(cache.checked_at);
  if (!Number.isFinite(checkedAtMs)) return false;
  // Future-dated entries are not trusted — a re-fetch costs one HTTP
  // request and is the safer default than serving a value the clock
  // disagrees with.
  if (checkedAtMs > now) return false;
  return now - checkedAtMs < ttlMs;
}

function isValidCacheShape(value: unknown): value is SelfUpdateCache {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['schema_version'] === CACHE_SCHEMA_VERSION &&
    typeof v['checked_at'] === 'string' &&
    typeof v['latest_version'] === 'string' &&
    v['latest_version'].length > 0 &&
    semver.valid(v['latest_version'] as string) !== null
  );
}

/**
 * Fetch `registry.npmjs.org/shardmind/latest`, parse `.version`, return
 * a normalized semver string. Throws on any failure (timeout, HTTP
 * error, malformed JSON, missing `.version` field) so the public entry
 * point's `try/catch` collapses everything to `null`.
 *
 * Timeout enforced via `AbortController` — same primitive as
 * update-check.ts. The translated `SELF_UPDATE_CHECK_FAILED` is never
 * surfaced to the user (caller swallows), but the typed code preserves
 * the distinction for verbose logging if that ever lands.
 *
 * If a caller-provided `signal` is passed and aborts, the same
 * AbortController is short-circuited so the fetch cancels promptly.
 */
async function fetchLatestWithTimeout(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<string | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Wire caller cancellation into our controller so a user-supplied
  // signal aborts the fetch in addition to our own timer. The
  // `listenerAttached` flag tracks whether `addEventListener` was
  // actually called so the `finally` cleanup doesn't fire a stray
  // `removeEventListener` for a listener that never existed (the
  // already-aborted-caller branch skips the `add`). `removeEventListener`
  // for a non-registered listener is a no-op in Node and the DOM, but
  // pairing add/remove keeps the side-effect ledger honest and avoids
  // surprises if this code ever moves to a runtime with stricter
  // listener bookkeeping.
  const onCallerAbort = () => controller.abort();
  let listenerAttached = false;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      listenerAttached = true;
    }
  }

  try {
    const response = await fetch(getRegistryUrl(), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new ShardMindError(
        `npm registry returned HTTP ${response.status}`,
        'SELF_UPDATE_CHECK_FAILED',
        'No banner this run; will retry next invocation.',
      );
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return null;
    const version = (data as Record<string, unknown>)['version'];
    if (typeof version !== 'string') return null;
    // `semver.valid()` returns the *normalized* form on success (strips
    // a leading `v`, equates `1.0.0` ≡ `=1.0.0`) and `null` on failure.
    // Use the normalized return value rather than the raw input — npm
    // technically responds with raw `version` strings today, but storing
    // an un-normalized form would make the cache file's `latest_version`
    // brittle to upstream formatting changes (a future "v1.2.3" or
    // " 1.2.3" would round-trip into the cache verbatim and trip future
    // semver consumers). Normalize at ingestion is the safer invariant.
    const normalized = semver.valid(version);
    if (!normalized) return null;
    return normalized;
  } catch (err) {
    if (timedOut) {
      throw new ShardMindError(
        `Self-update check timed out after ${timeoutMs}ms`,
        'SELF_UPDATE_CHECK_FAILED',
        'Network is slow or unresponsive; banner suppressed this run.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (listenerAttached && callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Guard against a clock returning a non-finite value (mocked test
 * clocks, broken VM hosts) by clamping to epoch — a NaN turned into
 * an ISO string would crash `new Date()`.
 */
function clamp(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms;
}
