/**
 * Unit tests for `core/self-update-check.ts`.
 *
 * Mirrors the structure of `tests/unit/update-check.test.ts` because
 * the modules are siblings — same hardening posture, different subject.
 * Test categories:
 *   1. Cache freshness (hit / stale / future-dated / wrong schema).
 *   2. Corruption recovery (bad JSON / EISDIR / wrong-shape).
 *   3. Network failures (timeout / 5xx / 404 / DNS / malformed body).
 *   4. Semver edge cases (equal / dev-ahead / prerelease vs stable).
 *   5. Atomic writes (race smoke).
 *   6. Cache directory resolution (XDG / LOCALAPPDATA / fallback).
 *   7. Spec acceptance: silent on every failure mode the issue lists.
 *
 * Network calls are stubbed via `globalThis.fetch` — same pattern as
 * update-check.test.ts and registry.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  checkSelfUpdate,
  getSelfUpdateCacheDir,
  CACHE_FILENAME,
  TTL_MS,
} from '../../source/core/self-update-check.js';

function npmLatestResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function networkError(): never {
  throw new TypeError('fetch failed');
}

async function makeCacheDir(): Promise<string> {
  // crypto.randomUUID rather than Date.now keeps parallel test workers
  // from colliding within the same millisecond — same lesson as the
  // update-check.test.ts + spawn-cli flake hunt.
  return await fsp.mkdtemp(
    path.join(os.tmpdir(), `shardmind-self-update-${crypto.randomUUID()}-`),
  );
}

async function readRawCache(cacheDir: string): Promise<string | null> {
  try {
    return await fsp.readFile(path.join(cacheDir, CACHE_FILENAME), 'utf-8');
  } catch {
    return null;
  }
}

async function writeCacheRaw(
  cacheDir: string,
  body: unknown,
): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(
    path.join(cacheDir, CACHE_FILENAME),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf-8',
  );
}

describe('self-update-check', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await makeCacheDir();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    // Restore env keys we may have set.
    for (const k of [
      'SHARDMIND_SELF_UPDATE_CACHE_DIR',
      'SHARDMIND_SELF_UPDATE_REGISTRY_URL',
      'XDG_CACHE_HOME',
      'LOCALAPPDATA',
    ]) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  // ───── 1. Cache freshness ─────────────────────────────────────────

  describe('cache freshness', () => {
    it('returns cached value within TTL without hitting the network', async () => {
      globalThis.fetch = vi.fn(() => {
        throw new Error('fetch must not be called on a fresh cache');
      });

      const now = Date.now();
      await writeCacheRaw(cacheDir, {
        schema_version: 1,
        checked_at: new Date(now - 1000).toISOString(),
        latest_version: '99.0.0',
      });

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now,
      });
      expect(result).toEqual({ outdated: true, latest: '99.0.0' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refetches when cache is older than TTL', async () => {
      const now = Date.now();
      await writeCacheRaw(cacheDir, {
        schema_version: 1,
        checked_at: new Date(now - (TTL_MS + 60_000)).toISOString(),
        latest_version: '0.9.0',
      });

      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now,
      });
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const reread = await readRawCache(cacheDir);
      expect(reread).toContain('"latest_version": "1.0.0"');
    });

    it('treats future-dated checked_at as stale and refetches', async () => {
      const now = Date.now();
      await writeCacheRaw(cacheDir, {
        schema_version: 1,
        checked_at: new Date(now + 60 * 60 * 1000).toISOString(),
        latest_version: '0.1.0',
      });

      globalThis.fetch = vi.fn(async () => npmLatestResponse('0.2.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now,
      });
      expect(result).toEqual({ outdated: true, latest: '0.2.0' });
    });

    it('treats wrong schema_version as invalid cache', async () => {
      await writeCacheRaw(cacheDir, {
        schema_version: 99,
        checked_at: new Date().toISOString(),
        latest_version: '99.0.0',
      });

      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      // Wrong-schema cache discarded → re-fetch picked up `1.0.0`.
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
      // Bad cache file replaced with a clean one.
      const raw = await readRawCache(cacheDir);
      expect(raw).toContain('"schema_version": 1');
      expect(raw).toContain('"latest_version": "1.0.0"');
    });

    it('treats malformed-shape cache as invalid', async () => {
      // schema_version present but latest_version is not a valid semver.
      await writeCacheRaw(cacheDir, {
        schema_version: 1,
        checked_at: new Date().toISOString(),
        latest_version: 'not-a-version',
      });

      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
    });
  });

  // ───── 2. Corruption recovery ─────────────────────────────────────

  describe('corrupt cache recovery', () => {
    it('deletes a corrupt JSON file and falls through to the network', async () => {
      await writeCacheRaw(cacheDir, '{not-valid-json');
      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
      const contents = await readRawCache(cacheDir);
      expect(contents).toContain('"latest_version": "1.0.0"');
    });

    it('handles a fresh cache miss (no file) cleanly', async () => {
      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('self-heals when the cache path is a directory (EISDIR)', async () => {
      // Pathological but possible: user manually created
      // `shardmind/self-update.json/` as a directory. The first read
      // must detect EISDIR, delete it, and fall through to the network.
      await fsp.mkdir(path.join(cacheDir, CACHE_FILENAME), { recursive: true });

      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
      const stat = await fsp.stat(path.join(cacheDir, CACHE_FILENAME));
      expect(stat.isFile()).toBe(true);
    });
  });

  // ───── 3. Network failures ────────────────────────────────────────

  describe('network failures', () => {
    it('returns null when network fails and no cache exists', async () => {
      globalThis.fetch = vi.fn(() => networkError());

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
    });

    it('returns null on HTTP 404', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response('', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
    });

    it('returns null on HTTP 5xx', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response('Service Unavailable', {
            status: 503,
            headers: { 'content-type': 'text/plain' },
          }),
      );

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
    });

    it('returns null on JSON missing the version field', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ name: 'shardmind' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
    });

    it('returns null on JSON with invalid semver in version field', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ version: 'not-a-version' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
    });

    it('returns null on malformed JSON body', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response('not-json-at-all', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
    });

    it('honors the AbortSignal so a hanging fetch cancels within budget', async () => {
      // fetch stub that never resolves except on abort. Without
      // AbortController wiring, this would wait the full budget and
      // exceed vitest's per-test timeout.
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
      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        fetchTimeoutMs: 200,
        now: Date.now(),
      });
      const elapsed = Date.now() - started;

      expect(result).toBeNull();
      // Budget is 200ms; clear bound for CI jitter is well under
      // vitest's default 5s. The point is "we cancelled, didn't hang".
      expect(elapsed).toBeLessThan(3000);
    }, 10_000);

    it('honors a caller-provided AbortSignal', async () => {
      const controller = new AbortController();
      globalThis.fetch = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      // Fire abort 50ms after the call starts.
      setTimeout(() => controller.abort(), 50);
      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        fetchTimeoutMs: 5000,
        signal: controller.signal,
        now: Date.now(),
      });
      expect(result).toBeNull();
    }, 10_000);
  });

  // ───── 4. Semver comparison ───────────────────────────────────────

  describe('semver comparison', () => {
    it('returns outdated: false when current === latest', async () => {
      globalThis.fetch = vi.fn(async () => npmLatestResponse('0.1.2'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: false, latest: '0.1.2' });
    });

    it('returns outdated: true when current < latest', async () => {
      globalThis.fetch = vi.fn(async () => npmLatestResponse('0.1.3'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: true, latest: '0.1.3' });
    });

    it('returns outdated: false when current > latest (dev branch ahead)', async () => {
      globalThis.fetch = vi.fn(async () => npmLatestResponse('0.1.2'));

      const result = await checkSelfUpdate({
        currentVersion: '0.2.0',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: false, latest: '0.1.2' });
    });

    it('returns outdated: false when current is a prerelease ahead of stable latest', async () => {
      // semver.lt('0.2.0-beta.1', '0.1.2') is false because the prerelease
      // version's major.minor.patch is `0.2.0`, which is > `0.1.2`. The
      // banner suppresses correctly.
      globalThis.fetch = vi.fn(async () => npmLatestResponse('0.1.2'));

      const result = await checkSelfUpdate({
        currentVersion: '0.2.0-beta.1',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toEqual({ outdated: false, latest: '0.1.2' });
    });

    it('returns null when currentVersion is not a valid semver', async () => {
      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: 'not-a-version',
        cacheDir,
        now: Date.now(),
      });
      expect(result).toBeNull();
      // No fetch should fire — invalid semver short-circuits before the cache read.
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // ───── 5. Atomic writes ───────────────────────────────────────────

  describe('atomic writes', () => {
    it('write never produces a partial file across rapid invocations', async () => {
      // Repeatedly re-fetch (TTL set to 0) so writeCache fires on each
      // call. Every intermediate read must parse to a complete object,
      // not a truncated body — this would catch a naive writeFile race.
      let i = 0;
      globalThis.fetch = vi.fn(async () => npmLatestResponse(`1.${i++}.0`));

      for (let n = 0; n < 20; n++) {
        const result = await checkSelfUpdate({
          currentVersion: '0.1.2',
          cacheDir,
          ttlMs: 0,
          now: Date.now(),
        });
        expect(result?.outdated).toBe(true);
        const raw = await readRawCache(cacheDir);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!);
        expect(typeof parsed.latest_version).toBe('string');
      }
    });
  });

  // ───── 6. Cache directory resolution ──────────────────────────────

  describe('cache directory resolution', () => {
    it('honors the SHARDMIND_SELF_UPDATE_CACHE_DIR override', () => {
      process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'] = '/tmp/explicit';
      expect(getSelfUpdateCacheDir()).toBe('/tmp/explicit');
    });

    it('uses XDG_CACHE_HOME/shardmind on POSIX when XDG is set', () => {
      delete process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'];
      process.env['XDG_CACHE_HOME'] = '/xdg-cache';
      expect(getSelfUpdateCacheDir()).toBe(path.join('/xdg-cache', 'shardmind'));
    });

    it('uses LOCALAPPDATA/shardmind on Windows when set (suite-side guard)', () => {
      // Skip when not Windows because the LOCALAPPDATA branch only runs
      // when `process.platform === 'win32'`. On other platforms the XDG
      // and homedir branches are correct and tested above.
      if (process.platform !== 'win32') return;
      delete process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'];
      delete process.env['XDG_CACHE_HOME'];
      process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
      expect(getSelfUpdateCacheDir()).toBe(
        path.join('C:\\Users\\test\\AppData\\Local', 'shardmind'),
      );
    });

    it('falls back to ~/.cache/shardmind on POSIX when no env is set', () => {
      if (process.platform === 'win32') return;
      delete process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'];
      delete process.env['XDG_CACHE_HOME'];
      const got = getSelfUpdateCacheDir();
      expect(got).toBe(path.join(os.homedir(), '.cache', 'shardmind'));
    });
  });

  // ───── 7. Registry URL override ───────────────────────────────────

  describe('registry URL override', () => {
    it('hits the override URL when SHARDMIND_SELF_UPDATE_REGISTRY_URL is set', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        calls.push(typeof input === 'string' ? input : input.toString());
        return npmLatestResponse('1.0.0');
      });

      process.env['SHARDMIND_SELF_UPDATE_REGISTRY_URL'] =
        'http://localhost:9999/test/latest';

      await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(calls.length).toBe(1);
      expect(calls[0]).toBe('http://localhost:9999/test/latest');
    });

    it('strips trailing slashes and whitespace from the override URL', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        calls.push(typeof input === 'string' ? input : input.toString());
        return npmLatestResponse('1.0.0');
      });

      process.env['SHARDMIND_SELF_UPDATE_REGISTRY_URL'] =
        '  http://localhost:9999/test///  ';

      await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir,
        now: Date.now(),
      });
      expect(calls[0]).toBe('http://localhost:9999/test');
    });
  });

  // ───── 8. Cache write failure (silent) ────────────────────────────

  describe('cache write failure', () => {
    it('returns the live answer even when cacheDir cannot be created', async () => {
      // Point at a path that mkdir cannot create. On POSIX, attempting
      // to mkdir under a regular file fails with ENOTDIR.
      const blocker = path.join(cacheDir, 'blocker');
      await fsp.writeFile(blocker, '', 'utf-8');
      const unwritable = path.join(blocker, 'subdir');

      globalThis.fetch = vi.fn(async () => npmLatestResponse('1.0.0'));

      const result = await checkSelfUpdate({
        currentVersion: '0.1.2',
        cacheDir: unwritable,
        now: Date.now(),
      });
      // Live answer still returned despite the cache write failure.
      expect(result).toEqual({ outdated: true, latest: '1.0.0' });
    });
  });
});
