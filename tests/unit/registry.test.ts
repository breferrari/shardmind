import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    it('skips registry and uses GitHub releases/latest when no version', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.endsWith('/releases/latest')) {
          return jsonResponse({ tag_name: 'v2.1.0' });
        }
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
        if (u.endsWith('/releases/latest')) return jsonResponse({ tag_name: 'v4.0.0' });
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget');
      expect(result.version).toBe('4.0.0');
    });

    it('uses explicit version without fetching releases/latest', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push(u);
        if (init?.method === 'HEAD') return headOk();
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      const result = await resolve('github:acme/widget@1.2.3');
      expect(result.version).toBe('1.2.3');
      expect(calls.some((u) => u.includes('/releases/latest'))).toBe(false);
    });

    it('throws VERSION_NOT_FOUND when direct mode repo has no releases', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.endsWith('/releases/latest')) return new Response(null, { status: 404 });
        throw new Error(`Unexpected fetch: ${u}`);
      }) as typeof fetch;

      await expect(resolve('github:acme/widget')).rejects.toMatchObject({
        code: 'VERSION_NOT_FOUND',
      });
    });
  });

  describe('tag verification', () => {
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
        if (u.endsWith('/releases/latest')) return rateLimited();
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
        if (u.endsWith('/releases/latest')) return jsonResponse({ tag_name: 'v1.0.0' });
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
