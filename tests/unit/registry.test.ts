import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { resolve } from '../../source/core/registry.js';
import { ShardMindError } from '../../source/runtime/types.js';

const REGISTRY_URL = 'https://raw.githubusercontent.com/shardmind/registry/main/index.json';

function indexResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function jsonResponse(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function headOk(): Response {
  return new Response(null, { status: 200 });
}

function headNotFound(): Response {
  return new Response(null, { status: 404 });
}

function rateLimited(): Response {
  return new Response('rate limited', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  });
}

interface ReleaseFixture {
  tag_name: string;
  prerelease: boolean;
}

/**
 * Build the JSON body returned by GitHub's `/repos/:o/:r/releases`. Mirrors
 * the on-the-wire shape the real API serves: an array of release objects
 * sorted by `created_at` descending. Tests only need the two fields the
 * engine reads; extras would just be noise.
 */
function releasesResponse(entries: ReleaseFixture[], status = 200): Response {
  return jsonResponse(entries, status);
}

/** Convenience for "latest stable v1.0.0" cases. */
function singleStableRelease(tag = 'v1.0.0'): Response {
  return releasesResponse([{ tag_name: tag, prerelease: false }]);
}

/** True iff this URL is the `/releases?per_page=...` listing endpoint. */
function isReleasesListing(u: string): boolean {
  return /\/releases\?per_page=\d+$/.test(u);
}

describe('registry.resolve', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env['GITHUB_TOKEN'];

  beforeEach(() => {
    delete process.env['GITHUB_TOKEN'];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken !== undefined) {
      process.env['GITHUB_TOKEN'] = originalToken;
    } else {
      delete process.env['GITHUB_TOKEN'];
    }
  });

  describe('parsing', () => {
    it('rejects invalid shard references', async () => {
      await expect(resolve('notashard')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
      await expect(resolve('')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
      await expect(resolve('namespace//name')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
    });

    it('rejects uppercase refs (enforces lowercase identifiers)', async () => {
      await expect(resolve('Breferrari/obsidian-mind')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
      await expect(resolve('github:Acme/Widget')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
    });

    it('rejects refs with combined @version and #ref', async () => {
      // Either pin a tag or pin a commit-ref — never both. The regex
      // makes the alternation mutually exclusive at parse time.
      await expect(resolve('github:acme/widget@1.0.0#main')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
      await expect(resolve('github:acme/widget#main@1.0.0')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
    });

    it('rejects refs with embedded whitespace', async () => {
      await expect(resolve('github:acme/widget#with space')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
    });

    it('rejects an empty ref after the # delimiter', async () => {
      await expect(resolve('github:acme/widget#')).rejects.toMatchObject({
        code: 'REGISTRY_INVALID_REF',
      });
    });

    it('rejects #<ref> in registry mode (no github: prefix)', async () => {
      // Registry-mode entries have no per-branch metadata; ref pinning
      // requires committing to the direct flow with its different
      // update semantics (re-resolve HEAD on every update).
      const err = await resolve('acme/widget#main').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('REGISTRY_INVALID_REF');
      expect(err.hint).toContain('github:');
    });
  });

  describe('ref installs (#<ref>)', () => {
    /** 40-char hex SHA used across the ref-install test suite. */
    const SHA = 'deadbeef00112233445566778899aabbccddeeff';

    it('resolves #main to the commit SHA via /commits/main', async () => {
      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        seen.push(u);
        if (u.endsWith('/commits/main')) return jsonResponse({ sha: SHA });
        if (u.includes(`/tarball/${SHA}`) && init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget#main');
      expect(result.ref).toEqual({ name: 'main', commit: SHA });
      expect(result.tarballUrl).toBe(
        `https://api.github.com/repos/acme/widget/tarball/${SHA}`,
      );
      // resolved.version is the short SHA (display).
      expect(result.version).toBe(SHA.slice(0, 7));
      // No /releases call — ref installs skip the latest-version lookup.
      expect(seen.some((u) => u.includes('/releases'))).toBe(false);
    });

    it('URL-encodes refs that contain a slash (feature/foo)', async () => {
      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        seen.push(u);
        if (u.endsWith('/commits/feature%2Ffoo')) return jsonResponse({ sha: SHA });
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget#feature/foo');
      expect(result.ref?.name).toBe('feature/foo');
      expect(seen.some((u) => u.includes('/commits/feature%2Ffoo'))).toBe(true);
    });

    it('accepts uppercase ref names (refs are case-sensitive on GitHub)', async () => {
      // Owner / repo are lowercase-only by the existing regex, but ref
      // names can carry case (`HEAD`, `Feature-1`, …).
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.endsWith('/commits/Feature')) return jsonResponse({ sha: SHA });
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget#Feature');
      expect(result.ref?.name).toBe('Feature');
    });

    it('throws REF_NOT_FOUND when /commits returns 404', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return new Response(null, { status: 404 });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget#bogus').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('REF_NOT_FOUND');
      expect(err.hint).toContain('bogus');
    });

    it('throws REF_NOT_FOUND with an "ambiguous SHA" hint on 422', async () => {
      // GitHub returns 422 when a SHA prefix matches multiple commits.
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return new Response('ambiguous', { status: 422 });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget#abc1').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('REF_NOT_FOUND');
      expect(err.hint).toMatch(/ambiguous|longer|prefix/i);
    });

    it('maps GitHub rate limit on /commits to REGISTRY_RATE_LIMITED', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return rateLimited();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget#main')).rejects.toMatchObject({
        code: 'REGISTRY_RATE_LIMITED',
      });
    });

    it('maps a /commits network failure to REGISTRY_NETWORK', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('network offline');
      }) as typeof fetch;

      await expect(resolve('github:acme/widget#main')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('rejects a /commits response missing the sha field', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return jsonResponse({ message: 'no sha' });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget#main')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('rejects a /commits response with a non-40-hex sha', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return jsonResponse({ sha: 'not-a-sha' });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget#main')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('throws REF_NOT_FOUND when the SHA-tarball HEAD returns 404', async () => {
      // Rare but possible: the SHA resolved fine, but the tarball isn't
      // fetchable — typically a force-push between the two API calls.
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
        if (init?.method === 'HEAD') return headNotFound();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget#main').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('REF_NOT_FOUND');
      expect(err.hint).toContain('main');
    });

    it('sends GITHUB_TOKEN on /commits when set', async () => {
      process.env['GITHUB_TOKEN'] = 'tok_ref';
      const seen: Array<{ url: string; auth: string | null }> = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url: u, auth: headers['Authorization'] ?? null });
        if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolve('github:acme/widget#main');

      const commitsCall = seen.find((c) => c.url.includes('/commits/'));
      expect(commitsCall?.auth).toBe('Bearer tok_ref');
    });

    it('returns ResolvedShard.ref undefined for tag installs', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return singleStableRelease('v1.0.0');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.ref).toBeUndefined();
    });

    it('property: arbitrary non-whitespace, no-`@` ref strings round-trip through resolve()', async () => {
      // The ref string the user types is recorded verbatim in
      // `state.ref` and forwarded to `/commits/<encoded>`. No matter
      // what shape we accept (slashes, dots, mixed case, hyphens,
      // numbers), the `parsed.ref.name` should equal the user's input
      // and the encoded URL should round-trip via `decodeURIComponent`.
      // The character class below mirrors what the regex's `[^@\s]+`
      // accepts (anything but `@` and whitespace), constrained to
      // visible ASCII so the property doesn't trip on UTF-8 cases the
      // engine doesn't support yet.
      const refChars = fc
        .stringMatching(/^[A-Za-z0-9./_-]+$/)
        .filter((s) => s.length > 0 && s.length <= 60);

      await fc.assert(
        fc.asyncProperty(refChars, async (refName) => {
          let captured: string | null = null;
          globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const u = typeof url === 'string' ? url : url.toString();
            const m = /\/commits\/([^?]+)$/.exec(u);
            if (m) {
              captured = decodeURIComponent(m[1]!);
              return jsonResponse({ sha: SHA });
            }
            if (init?.method === 'HEAD') return headOk();
            throw new Error(`Unexpected fetch: ${u}`);
          }) as typeof fetch;

          const result = await resolve(`github:acme/widget#${refName}`);
          expect(result.ref?.name).toBe(refName);
          expect(captured).toBe(refName);
        }),
        { numRuns: 50 },
      );
    });

    it('lowercases the resolved SHA so state.resolvedSha is canonicalized', async () => {
      // GitHub returns SHAs lowercase, but a hand-stubbed test or future
      // upstream change shouldn't be able to leak mixed case into state.
      const upper = SHA.toUpperCase();
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/commits/')) return jsonResponse({ sha: upper });
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget#main');
      expect(result.ref?.commit).toBe(SHA);
    });
  });

  describe('registry mode', () => {
    it('resolves namespace/name to latest version', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u === REGISTRY_URL) {
          return indexResponse({
            shards: {
              'breferrari/obsidian-mind': {
                repo: 'breferrari/obsidian-mind',
                latest: '3.5.0',
                versions: ['3.5.0', '3.4.0'],
              },
            },
          });
        }
        if (u.includes('/tarball/v3.5.0') && init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('breferrari/obsidian-mind');
      expect(result).toEqual({
        namespace: 'breferrari',
        name: 'obsidian-mind',
        version: '3.5.0',
        source: 'github:breferrari/obsidian-mind',
        tarballUrl: 'https://api.github.com/repos/breferrari/obsidian-mind/tarball/v3.5.0',
      });
    });

    it('resolves namespace/name@version to that exact version', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u === REGISTRY_URL) {
          return indexResponse({
            shards: {
              'breferrari/obsidian-mind': {
                repo: 'breferrari/obsidian-mind',
                latest: '3.5.0',
                versions: ['3.5.0', '3.4.0'],
              },
            },
          });
        }
        if (u.includes('/tarball/v3.4.0') && init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('breferrari/obsidian-mind@3.4.0');
      expect(result.version).toBe('3.4.0');
      expect(result.tarballUrl).toContain('/tarball/v3.4.0');
    });

    it('throws SHARD_NOT_FOUND when shard is missing from registry', async () => {
      globalThis.fetch = vi.fn(async () => indexResponse({ shards: {} })) as typeof fetch;

      await expect(resolve('ghost/shard')).rejects.toMatchObject({
        code: 'SHARD_NOT_FOUND',
      });
    });

    it('builds tarball URL from entry.repo when it differs from shard key', async () => {
      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        seen.push(u);
        if (u === REGISTRY_URL) {
          return indexResponse({
            shards: {
              'breferrari/obsidian-mind': {
                repo: 'other-owner/mirror-repo',
                latest: '3.5.0',
                versions: ['3.5.0'],
              },
            },
          });
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('breferrari/obsidian-mind');
      expect(result.tarballUrl).toBe(
        'https://api.github.com/repos/other-owner/mirror-repo/tarball/v3.5.0',
      );
      expect(result.source).toBe('github:other-owner/mirror-repo');
      expect(result.namespace).toBe('breferrari');
      expect(result.name).toBe('obsidian-mind');
      expect(seen.some((u) => u.includes('/other-owner/mirror-repo/tarball/v3.5.0'))).toBe(true);
    });

    it('rejects registry entries with malformed repo field', async () => {
      globalThis.fetch = vi.fn(async () =>
        indexResponse({
          shards: {
            'ns/name': { repo: 'broken', latest: '1.0.0', versions: ['1.0.0'] },
          },
        }),
      ) as typeof fetch;

      await expect(resolve('ns/name')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('rejects registry responses where shards is null', async () => {
      globalThis.fetch = vi.fn(async () => indexResponse({ shards: null })) as typeof fetch;

      await expect(resolve('ns/name')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('rejects registry responses where shards is an array', async () => {
      globalThis.fetch = vi.fn(async () => indexResponse({ shards: [] })) as typeof fetch;

      await expect(resolve('ns/name')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('throws VERSION_NOT_FOUND when requested version is not in index', async () => {
      globalThis.fetch = vi.fn(async () =>
        indexResponse({
          shards: {
            'breferrari/obsidian-mind': {
              repo: 'breferrari/obsidian-mind',
              latest: '3.5.0',
              versions: ['3.5.0', '3.4.0'],
            },
          },
        }),
      ) as typeof fetch;

      const err = await resolve('breferrari/obsidian-mind@9.9.9').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('VERSION_NOT_FOUND');
      expect(err.message).toContain('3.5.0');
      expect(err.message).toContain('3.4.0');
    });
  });

  describe('direct mode', () => {
    it('skips registry and uses GitHub /releases when no version', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return singleStableRelease('v2.1.0');
        if (u.includes('/tarball/v2.1.0') && init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.namespace).toBe('acme');
      expect(result.name).toBe('widget');
      expect(result.version).toBe('2.1.0');
      expect(result.source).toBe('github:acme/widget');
    });

    it('strips v prefix from tag_name', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return singleStableRelease('v4.0.0');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.version).toBe('4.0.0');
    });

    it('strips a leading `v` from explicit @version (matches latest-resolution normalization)', async () => {
      // `fetchLatestRelease` already strips a leading `v` from the
      // tag GitHub returns. Without the same strip on the
      // user-supplied `@v1.2.3`, the tarball URL ends up
      // `tarball/vv1.2.3` and HEAD-404s with a confusing
      // VERSION_NOT_FOUND. Pin both shapes to `tarball/v1.2.3`.
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const withV = await resolve('github:acme/widget@v1.2.3');
      const withoutV = await resolve('github:acme/widget@1.2.3');
      expect(withV.version).toBe('1.2.3');
      expect(withoutV.version).toBe('1.2.3');
      expect(withV.tarballUrl).toBe(
        'https://api.github.com/repos/acme/widget/tarball/v1.2.3',
      );
      expect(withV.tarballUrl).toBe(withoutV.tarballUrl);
    });

    it('uses explicit version without fetching releases', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push(u);
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget@1.2.3');
      expect(result.version).toBe('1.2.3');
      expect(calls.some((u) => u.includes('/releases'))).toBe(false);
    });

    it('throws SHARD_NOT_FOUND when /releases returns 404 (repo missing)', async () => {
      // `/releases` 404 means the repo doesn't exist (or is private to
      // an unauthenticated client). Distinct from a 200 with empty array,
      // which means the repo exists but has no releases yet.
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return new Response(null, { status: 404 });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('SHARD_NOT_FOUND');
      expect(err.hint).toContain('GITHUB_TOKEN');
    });
  });

  describe('/releases listing semantics', () => {
    /**
     * The default-stable filter replaces the v0.1 `/releases/latest` call,
     * which 404s for repos that publish only prereleases. The listing
     * endpoint returns the same data without that quirk and lets us
     * surface a `--include-prerelease` hint when a beta-only repo is
     * encountered.
     */
    it('default skips prereleases and picks the newest stable', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) {
          return releasesResponse([
            { tag_name: 'v2.0.0-beta.1', prerelease: true },
            { tag_name: 'v1.0.0', prerelease: false },
            { tag_name: 'v0.9.0', prerelease: false },
          ]);
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.version).toBe('1.0.0');
    });

    it('NO_RELEASES_PUBLISHED with --include-prerelease hint when only prereleases exist', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) {
          return releasesResponse([
            { tag_name: 'v2.0.0-beta.1', prerelease: true },
            { tag_name: 'v2.0.0-alpha.1', prerelease: true },
          ]);
        }
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('NO_RELEASES_PUBLISHED');
      expect(err.hint).toContain('--include-prerelease');
    });

    it('NO_RELEASES_PUBLISHED with no-flag hint on a 200-empty response', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return releasesResponse([]);
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget').catch((e) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('NO_RELEASES_PUBLISHED');
      // No prereleases exist either, so the --include-prerelease hint
      // would be misleading. The hint points at the actual remediations.
      expect(err.hint).not.toContain('--include-prerelease');
      expect(err.hint).toContain('@version');
    });

    it('--include-prerelease widens to the newest release of any kind', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) {
          return releasesResponse([
            { tag_name: 'v2.0.0-beta.1', prerelease: true },
            { tag_name: 'v1.0.0', prerelease: false },
          ]);
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget', { includePrerelease: true });
      expect(result.version).toBe('2.0.0-beta.1');
    });

    it('--include-prerelease still throws when the repo has zero releases', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return releasesResponse([]);
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const err = await resolve('github:acme/widget', { includePrerelease: true }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ShardMindError);
      expect(err.code).toBe('NO_RELEASES_PUBLISHED');
    });

    it('skips entries with empty / whitespace-only tag_name', async () => {
      // A whitespace-only tag would produce a useless `tarball/v   ` URL
      // downstream. Defensive against a malformed upstream response — the
      // canonical GitHub API never emits this, but we don't want a
      // misbehaving mirror or third-party proxy to wedge resolution.
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) {
          return jsonResponse([
            { tag_name: '', prerelease: false },
            { tag_name: '   ', prerelease: false },
            { tag_name: '\t\n', prerelease: false },
            { tag_name: 'v1.0.0', prerelease: false },
          ]);
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.version).toBe('1.0.0');
    });

    it('skips malformed entries (missing tag_name / non-boolean prerelease)', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) {
          return jsonResponse([
            // Missing tag_name — drop.
            { prerelease: false },
            // tag_name is empty string — drop.
            { tag_name: '', prerelease: false },
            // prerelease is not a boolean — drop (we can't classify it).
            { tag_name: 'v3.0.0', prerelease: 'no' },
            // First valid entry wins.
            { tag_name: 'v2.0.0', prerelease: false },
            { tag_name: 'v1.0.0', prerelease: false },
          ]);
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.version).toBe('2.0.0');
    });

    it('rejects a non-array response body with REGISTRY_NETWORK', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return jsonResponse({ message: 'Not an array' });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('rejects malformed JSON with REGISTRY_NETWORK', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return new Response('not json', { status: 200 });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('uses per_page=100 to widen the single-page coverage', async () => {
      // A first-page that returned only ~30 entries could miss a stable
      // release for repos that have a long beta tail. per_page=100 is
      // GitHub's documented per-page cap; bumping the cap requires
      // pagination, which is documented as out-of-scope for v0.1.
      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        seen.push(u);
        if (isReleasesListing(u)) return singleStableRelease('v1.0.0');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolve('github:acme/widget');
      expect(seen.some((u) => u.includes('/releases?per_page=100'))).toBe(true);
    });
  });

  describe('tag verification', () => {
    it('accepts a HEAD 302 as valid (GitHub tarball redirect)', async () => {
      // GitHub's /tarball/v<ver> 302s to codeload.github.com; verifyTag's
      // `response.ok || response.status === 302` branch pins this contract.
      // Never covered until now — a silent regression here would break
      // every real install against the public API.
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return singleStableRelease('v1.0.0');
        if (init?.method === 'HEAD') return new Response(null, { status: 302 });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.version).toBe('1.0.0');
      expect(result.tarballUrl).toContain('/tarball/v1.0.0');
    });

    it('throws VERSION_NOT_FOUND when HEAD returns 404', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u === REGISTRY_URL) {
          return indexResponse({
            shards: {
              'breferrari/obsidian-mind': {
                repo: 'breferrari/obsidian-mind',
                latest: '3.5.0',
                versions: ['3.5.0'],
              },
            },
          });
        }
        if (init?.method === 'HEAD') return headNotFound();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('breferrari/obsidian-mind')).rejects.toMatchObject({
        code: 'VERSION_NOT_FOUND',
      });
    });
  });

  describe('env overrides', () => {
    // Module-level constants (GITHUB_API_BASE, REGISTRY_INDEX_URL) are read
    // once at import. Prove the override path by resetting the module cache,
    // setting the env var, and dynamic-importing a fresh registry module.
    const originalApiBase = process.env['SHARDMIND_GITHUB_API_BASE'];
    const originalIndexUrl = process.env['SHARDMIND_REGISTRY_INDEX_URL'];

    afterEach(() => {
      if (originalApiBase === undefined) delete process.env['SHARDMIND_GITHUB_API_BASE'];
      else process.env['SHARDMIND_GITHUB_API_BASE'] = originalApiBase;
      if (originalIndexUrl === undefined) delete process.env['SHARDMIND_REGISTRY_INDEX_URL'];
      else process.env['SHARDMIND_REGISTRY_INDEX_URL'] = originalIndexUrl;
    });

    it('SHARDMIND_GITHUB_API_BASE reroutes release + tarball calls', async () => {
      process.env['SHARDMIND_GITHUB_API_BASE'] = 'http://127.0.0.1:12345';
      vi.resetModules();
      const { resolve: resolveFresh } = await import('../../source/core/registry.js');

      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        seen.push(u);
        if (isReleasesListing(u)) return singleStableRelease('v1.2.3');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolveFresh('github:acme/widget');
      expect(result.tarballUrl).toBe('http://127.0.0.1:12345/repos/acme/widget/tarball/v1.2.3');
      expect(seen.every((u) => u.startsWith('http://127.0.0.1:12345'))).toBe(true);
      expect(seen.some((u) => u.includes('api.github.com'))).toBe(false);
    });

    it('strips trailing slashes from SHARDMIND_GITHUB_API_BASE', async () => {
      process.env['SHARDMIND_GITHUB_API_BASE'] = 'http://127.0.0.1:12345///';
      vi.resetModules();
      const { resolve: resolveFresh } = await import('../../source/core/registry.js');

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        expect(u.startsWith('http://127.0.0.1:12345/')).toBe(true);
        expect(u.includes('//repos')).toBe(false);
        if (isReleasesListing(u)) return singleStableRelease('v1.0.0');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolveFresh('github:acme/widget');
    });

    it('trims whitespace around SHARDMIND_GITHUB_API_BASE', async () => {
      // Env values copied from docs / CI secret stores frequently pick up
      // leading newlines or trailing spaces. Untrimmed, they produce URLs
      // like `\n http://host\n/repos/...`, which makes `new URL(url).host`
      // inside `safeFetch`'s error path throw a second, unrelated error.
      process.env['SHARDMIND_GITHUB_API_BASE'] = '  \n http://127.0.0.1:12345  \n';
      vi.resetModules();
      const { resolve: resolveFresh } = await import('../../source/core/registry.js');

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        expect(u).toBe(
          init?.method === 'HEAD'
            ? 'http://127.0.0.1:12345/repos/acme/widget/tarball/v1.0.0'
            : 'http://127.0.0.1:12345/repos/acme/widget/releases?per_page=100',
        );
        if (isReleasesListing(u)) return singleStableRelease('v1.0.0');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolveFresh('github:acme/widget');
    });

    it('trims whitespace around SHARDMIND_REGISTRY_INDEX_URL', async () => {
      process.env['SHARDMIND_REGISTRY_INDEX_URL'] = '  http://127.0.0.1:12345/index.json\n';
      vi.resetModules();
      const { resolve: resolveFresh } = await import('../../source/core/registry.js');

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u === 'http://127.0.0.1:12345/index.json') {
          return indexResponse({
            shards: {
              'ns/name': { repo: 'ns/name', latest: '1.0.0', versions: ['1.0.0'] },
            },
          });
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolveFresh('ns/name');
    });

    it('SHARDMIND_REGISTRY_INDEX_URL reroutes registry index lookup', async () => {
      process.env['SHARDMIND_REGISTRY_INDEX_URL'] = 'http://127.0.0.1:12345/index.json';
      vi.resetModules();
      const { resolve: resolveFresh } = await import('../../source/core/registry.js');

      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        seen.push(u);
        if (u === 'http://127.0.0.1:12345/index.json') {
          return indexResponse({
            shards: {
              'ns/name': { repo: 'ns/name', latest: '1.0.0', versions: ['1.0.0'] },
            },
          });
        }
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolveFresh('ns/name');
      expect(seen[0]).toBe('http://127.0.0.1:12345/index.json');
      expect(seen.some((u) => u.includes('raw.githubusercontent.com'))).toBe(false);
    });
  });

  describe('error mapping', () => {
    it('maps fetch rejection to REGISTRY_NETWORK', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('network offline');
      }) as typeof fetch;

      await expect(resolve('breferrari/obsidian-mind')).rejects.toMatchObject({
        code: 'REGISTRY_NETWORK',
      });
    });

    it('maps GitHub rate limit to REGISTRY_RATE_LIMITED', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (isReleasesListing(u)) return rateLimited();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget')).rejects.toMatchObject({
        code: 'REGISTRY_RATE_LIMITED',
      });
    });

    it('sends GITHUB_TOKEN on api.github.com requests when set', async () => {
      process.env['GITHUB_TOKEN'] = 'tok_abc';
      const seen: Array<{ url: string; auth: string | null }> = [];

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url: u, auth: headers['Authorization'] ?? null });
        if (isReleasesListing(u)) return singleStableRelease('v1.0.0');
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await resolve('github:acme/widget');

      const apiCalls = seen.filter((c) => c.url.includes('api.github.com'));
      expect(apiCalls.length).toBeGreaterThan(0);
      for (const call of apiCalls) {
        expect(call.auth).toBe('Bearer tok_abc');
      }
    });
  });
});
