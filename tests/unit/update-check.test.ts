/**
 * Unit tests for `core/update-check.ts`.
 *
 * Covers the five classes of behavior the status + update commands
 * depend on:
 *   1. Fresh-cache short-circuit (no network, no write).
 *   2. Stale / source-mismatched / missing cache → refetch + write.
 *   3. Corrupt-JSON recovery (delete + fall through).
 *   4. Network-failure fallback to stale cache, or `unknown` if no cache.
 *   5. `primeLatestVersion` round-trip + non-github no-op.
 *
 * Network calls are stubbed via `globalThis.fetch` — matches the pattern
 * used in `tests/unit/registry.test.ts` (the real `fetchLatestVersion`
 * goes through `fetchLatestRelease` → `fetch`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getLatestVersion,
  primeLatestVersion,
  readCache,
  writeCache,
  CACHE_FILENAME,
  TTL_MS,
} from '../../source/core/update-check.js';
import { SHARDMIND_DIR } from '../../source/runtime/vault-paths.js';

const SOURCE = 'github:breferrari/obsidian-mind';

function releaseResponse(tag: string): Response {
  return new Response(JSON.stringify({ tag_name: tag }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function networkError(): never {
  throw new TypeError('fetch failed');
}

async function createVault(): Promise<string> {
  const vault = path.join(os.tmpdir(), `shardmind-update-check-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(vault, SHARDMIND_DIR), { recursive: true });
  return vault;
}

async function readRawCache(vault: string): Promise<string | null> {
  try {
    return await fsp.readFile(path.join(vault, SHARDMIND_DIR, CACHE_FILENAME), 'utf-8');
  } catch {
    return null;
  }
}

describe('update-check', () => {
  const originalFetch = globalThis.fetch;
  let vault: string;

  beforeEach(async () => {
    vault = await createVault();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fsp.rm(vault, { recursive: true, force: true });
  });

  describe('cache freshness', () => {
    it('returns cached value within TTL without hitting the network', async () => {
      globalThis.fetch = vi.fn(() => {
        throw new Error('fetch must not be called on a fresh cache');
      });

      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now - 1000).toISOString(),
        source: SOURCE,
        latest_version: '3.5.0',
      });

      const result = await getLatestVersion(vault, SOURCE, now);
      expect(result).toEqual({
        kind: 'fresh',
        latest_version: '3.5.0',
        checked_at: new Date(now - 1000).toISOString(),
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refetches when cache is older than TTL', async () => {
      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now - (TTL_MS + 60_000)).toISOString(),
        source: SOURCE,
        latest_version: '3.4.0',
      });

      globalThis.fetch = vi.fn(async () => releaseResponse('v4.0.0'));

      const result = await getLatestVersion(vault, SOURCE, now);
      expect(result).toEqual({
        kind: 'fresh',
        latest_version: '4.0.0',
        checked_at: new Date(now).toISOString(),
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const reread = await readCache(vault);
      expect(reread.cache?.latest_version).toBe('4.0.0');
      expect(reread.corruptHealed).toBe(false);
    });

    it('invalidates cache on source mismatch (user reinstalled from a different repo)', async () => {
      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now - 1000).toISOString(),
        source: 'github:someone/else',
        latest_version: '9.9.9',
      });

      globalThis.fetch = vi.fn(async () => releaseResponse('v1.0.0'));

      const result = await getLatestVersion(vault, SOURCE, now);
      expect(result.kind).toBe('fresh');
      if (result.kind === 'fresh') expect(result.latest_version).toBe('1.0.0');
    });

    it('treats future-dated checked_at as stale and refetches', async () => {
      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now + 60 * 60 * 1000).toISOString(), // +1h
        source: SOURCE,
        latest_version: '0.1.0',
      });

      globalThis.fetch = vi.fn(async () => releaseResponse('v0.2.0'));

      const result = await getLatestVersion(vault, SOURCE, now);
      expect(result.kind).toBe('fresh');
      if (result.kind === 'fresh') expect(result.latest_version).toBe('0.2.0');
    });

    it('treats wrong schema_version as invalid cache', async () => {
      await fsp.writeFile(
        path.join(vault, SHARDMIND_DIR, CACHE_FILENAME),
        JSON.stringify({
          schema_version: 99,
          checked_at: new Date().toISOString(),
          source: SOURCE,
          latest_version: '3.5.0',
        }),
        'utf-8',
      );

      const reread = await readCache(vault);
      expect(reread.cache).toBeNull();
      expect(reread.corruptHealed).toBe(true);
      expect(await readRawCache(vault)).toBeNull(); // deleted by readCache
    });
  });

  describe('corrupt cache recovery', () => {
    it('deletes a corrupt JSON file and falls through to the network', async () => {
      await fsp.writeFile(
        path.join(vault, SHARDMIND_DIR, CACHE_FILENAME),
        '{not-valid-json',
        'utf-8',
      );

      globalThis.fetch = vi.fn(async () => releaseResponse('v3.5.0'));

      const result = await getLatestVersion(vault, SOURCE, Date.now());
      expect(result.kind).toBe('fresh');
      // UPDATE_CHECK_CACHE_CORRUPT signal: readCache detected the bad
      // file, deleted it, and flagged the healing on the result so
      // verbose callers can surface a diagnostic.
      expect(result.cacheHealed).toBe(true);
      const contents = await readRawCache(vault);
      expect(contents).toContain('"latest_version": "3.5.0"');
    });

    it('returns an empty read result when the cache file is absent', async () => {
      const reread = await readCache(vault);
      expect(reread.cache).toBeNull();
      expect(reread.corruptHealed).toBe(false);
    });
  });

  describe('network failures', () => {
    it('returns stale cached value when network fails', async () => {
      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now - (TTL_MS + 60_000)).toISOString(),
        source: SOURCE,
        latest_version: '2.0.0',
      });

      globalThis.fetch = vi.fn(() => networkError());

      const result = await getLatestVersion(vault, SOURCE, now);
      expect(result).toMatchObject({
        kind: 'stale',
        latest_version: '2.0.0',
        reason: 'no-network',
      });
    });

    it('returns unknown when network fails and no cache exists', async () => {
      globalThis.fetch = vi.fn(() => networkError());

      const result = await getLatestVersion(vault, SOURCE, Date.now());
      expect(result).toEqual({ kind: 'unknown', reason: 'no-network' });
    });

    it('returns unknown for non-github sources without hitting the network', async () => {
      globalThis.fetch = vi.fn(() => {
        throw new Error('must not be called');
      });

      const result = await getLatestVersion(vault, 'registry:foo/bar', Date.now());
      expect(result).toEqual({ kind: 'unknown', reason: 'unsupported-source' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns unknown on HTTP 404 (tag deleted) and no prior cache', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response('', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const result = await getLatestVersion(vault, SOURCE, Date.now());
      expect(result.kind).toBe('unknown');
    });

    it('invalidates cache when the source changes and a re-fetch succeeds', async () => {
      // Prime the cache for one repo.
      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now - 1000).toISOString(),
        source: 'github:old/repo',
        latest_version: '9.9.9',
      });

      // Now request a lookup for a DIFFERENT repo — the cached answer must
      // be invalidated (mismatched source) and a real fetch must happen.
      globalThis.fetch = vi.fn(async () => releaseResponse('v2.0.0'));

      const result = await getLatestVersion(vault, 'github:new/repo', now);
      expect(result.kind).toBe('fresh');
      if (result.kind === 'fresh') expect(result.latest_version).toBe('2.0.0');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('self-heals when the cache path is a directory (EISDIR)', async () => {
      // Pathological but possible: user manually created
      // `.shardmind/update-check.json/` as a directory. The first read
      // must detect EISDIR, delete the directory, and fall through to
      // the network as if the cache were absent.
      await fsp.mkdir(path.join(vault, SHARDMIND_DIR, CACHE_FILENAME), { recursive: true });

      globalThis.fetch = vi.fn(async () => releaseResponse('v3.0.0'));

      const result = await getLatestVersion(vault, SOURCE, Date.now());
      expect(result.kind).toBe('fresh');
      // Directory was replaced with a normal file.
      const rawEntry = await fsp.stat(
        path.join(vault, SHARDMIND_DIR, CACHE_FILENAME),
      );
      expect(rawEntry.isFile()).toBe(true);
    });

    it('honors the AbortSignal so a hanging fetch cancels within the budget', async () => {
      // `fetch` stub that resolves based on the abort signal, so a real
      // timeout cancels this. Without AbortController wiring, this test
      // would wait the full 4s FETCH_TIMEOUT_MS and eventually time out at
      // vitest's default 5s — with wiring it resolves as soon as abort fires.
      globalThis.fetch = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const started = Date.now();
      const result = await getLatestVersion(vault, SOURCE, Date.now());
      const elapsed = Date.now() - started;

      // Budget is 4s; we must finish within a generous bound (<8s to be
      // resilient to CI jitter but clearly below a full hang).
      expect(elapsed).toBeLessThan(8000);
      expect(result.kind).toBe('unknown');
    }, 10_000);

    it('returns stale when the budget expires and a prior cache entry exists', async () => {
      const now = Date.now();
      await writeCache(vault, {
        schema_version: 1,
        checked_at: new Date(now - (TTL_MS + 60_000)).toISOString(),
        source: SOURCE,
        latest_version: '2.0.0',
      });

      globalThis.fetch = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const result = await getLatestVersion(vault, SOURCE, now);
      expect(result).toMatchObject({
        kind: 'stale',
        latest_version: '2.0.0',
        reason: 'no-network',
      });
    }, 10_000);
  });

  describe('primeLatestVersion', () => {
    it('writes a full entry that a follow-up read returns as fresh', async () => {
      const now = Date.now();
      await primeLatestVersion(vault, SOURCE, '3.5.0', now);

      const cached = await readCache(vault);
      expect(cached.cache).toMatchObject({
        schema_version: 1,
        source: SOURCE,
        latest_version: '3.5.0',
      });

      // A follow-up getLatestVersion call with fetch disabled should
      // hit the primed cache.
      globalThis.fetch = vi.fn(() => {
        throw new Error('should not fetch — cache was primed');
      });
      const result = await getLatestVersion(vault, SOURCE, now + 60_000);
      expect(result.kind).toBe('fresh');
    });

    it('is a no-op for non-github sources', async () => {
      await primeLatestVersion(vault, 'registry:foo/bar', '1.0.0');
      const reread = await readCache(vault);
      expect(reread.cache).toBeNull();
      expect(reread.corruptHealed).toBe(false);
    });

    it('is a no-op when given an empty version', async () => {
      await primeLatestVersion(vault, SOURCE, '');
      const reread = await readCache(vault);
      expect(reread.cache).toBeNull();
      expect(reread.corruptHealed).toBe(false);
    });
  });

  describe('atomic writes', () => {
    it('writeCache never produces a partial file (temp+rename)', async () => {
      // Repeat writes to try to catch any visible half-written state.
      const now = Date.now();
      for (let i = 0; i < 20; i++) {
        await writeCache(vault, {
          schema_version: 1,
          checked_at: new Date(now + i).toISOString(),
          source: SOURCE,
          latest_version: `1.${i}.0`,
        });
        const raw = await readRawCache(vault);
        expect(raw).toBeTruthy();
        // Every intermediate read must parse to a complete object, not a
        // truncated body — this would catch a naive writeFile race.
        const parsed = JSON.parse(raw!);
        expect(typeof parsed.latest_version).toBe('string');
      }
    });
  });
});
