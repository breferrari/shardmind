import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadShard } from '../../source/core/download.js';

const FIXTURE_TARBALL = path.resolve('tests/fixtures/shards/minimal-shard.tar.gz');

function createMockResponse(filePath: string, status = 200): Response {
  const stream = createReadStream(filePath);
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
  });
  return new Response(webStream, {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
  });
}

describe('downloadShard', () => {
  const originalFetch = globalThis.fetch;
  let cleanupFns: Array<() => Promise<void>>;

  // A private temp dir, so the leftover checks below see only this suite's
  // downloads, not other suites' `shardmind-*` dirs created in parallel.
  const savedTmp = { TMPDIR: process.env['TMPDIR'], TEMP: process.env['TEMP'], TMP: process.env['TMP'] };
  let privateTmp = '';

  beforeEach(async () => {
    cleanupFns = [];
    privateTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-test-'));
    process.env['TMPDIR'] = privateTmp;
    process.env['TEMP'] = privateTmp;
    process.env['TMP'] = privateTmp;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedTmp)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(privateTmp, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    for (const fn of cleanupFns) {
      await fn().catch(() => {});
    }
  });

  it('downloads and extracts a valid tarball', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));

    const result = await downloadShard('https://example.com/tarball');
    cleanupFns.push(result.cleanup);

    expect(result.tempDir).toBeTruthy();
    expect(result.manifest).toBe(path.join(result.tempDir, '.shardmind', 'shard.yaml'));
    expect(result.schema).toBe(path.join(result.tempDir, '.shardmind', 'shard-schema.yaml'));
  });

  it('extracted files exist on disk', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));

    const result = await downloadShard('https://example.com/tarball');
    cleanupFns.push(result.cleanup);

    const manifestStat = await fs.stat(result.manifest);
    expect(manifestStat.isFile()).toBe(true);

    const schemaStat = await fs.stat(result.schema);
    expect(schemaStat.isFile()).toBe(true);

    // v6 layout: vault content lives at the shard root, no templates/ dir.
    // Sample-check a known file from the migrated minimal-shard.
    const homeStat = await fs.stat(path.join(result.tempDir, 'Home.md.njk'));
    expect(homeStat.isFile()).toBe(true);
  });

  it('cleanup() removes the temp directory', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));

    const result = await downloadShard('https://example.com/tarball');
    const { tempDir } = result;

    await result.cleanup();

    await expect(fs.access(tempDir)).rejects.toThrow();
  });

  it('hands over a cleanup that stops a download in flight and removes its dir (#57)', async () => {
    let handedOver: (() => Promise<void>) | undefined;
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => (fetchStarted = r));
    // A body that sends nothing until aborted: the download is in flight.
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      fetchStarted();
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const download = downloadShard('https://example.com/tarball', (cleanup) => {
      handedOver = cleanup;
    }).catch((e: unknown) => e);
    await started;
    expect(handedOver).toBeTypeOf('function');
    expect((await fs.readdir(privateTmp)).filter((n) => n.startsWith('shardmind-'))).toHaveLength(1);
    await handedOver!();
    const err = await download;
    expect((err as Error).name).toBe('DownloadCancelledError');
    expect((await fs.readdir(privateTmp)).filter((n) => n.startsWith('shardmind-'))).toEqual([]);
  });

  it('removes its temp dir when the callback throws', async () => {
    globalThis.fetch = vi.fn();
    const err = await downloadShard('https://example.com/tarball', () => {
      throw new Error('callback failed');
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('callback failed');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await fs.readdir(privateTmp)).toEqual([]);
  });

  it('throws DOWNLOAD_HTTP_ERROR on non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    const err = await downloadShard('https://example.com/tarball').catch(e => e);
    expect(err.code).toBe('DOWNLOAD_HTTP_ERROR');
    expect(err.message).toContain('404');
  });

  it('throws DOWNLOAD_HTTP_ERROR on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const err = await downloadShard('https://example.com/tarball').catch(e => e);
    expect(err.code).toBe('DOWNLOAD_HTTP_ERROR');
    expect(err.message).toContain('fetch failed');
  });

  it('throws DOWNLOAD_MISSING_MANIFEST when shard.yaml is missing', async () => {
    // Create a tarball without shard.yaml
    const os = await import('node:os');
    const tar = await import('tar');
    const crypto = await import('node:crypto');
    const tmpTarball = path.join(os.tmpdir(), `test-tarball-${crypto.randomUUID()}.tar.gz`);
    const tmpSrc = path.join(os.tmpdir(), `test-src-${crypto.randomUUID()}`);
    const innerDir = path.join(tmpSrc, 'owner-repo-abc');
    await fs.mkdir(path.join(innerDir, '.shardmind'), { recursive: true });
    await fs.writeFile(path.join(innerDir, '.shardmind', 'shard-schema.yaml'), 'schema_version: 1');
    await tar.c({ gzip: true, file: tmpTarball, cwd: tmpSrc }, ['owner-repo-abc']);

    try {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(tmpTarball));
      const err = await downloadShard('https://example.com/tarball').catch(e => e);
      expect(err.code).toBe('DOWNLOAD_MISSING_MANIFEST');
    } finally {
      await fs.rm(tmpTarball, { force: true });
      await fs.rm(tmpSrc, { recursive: true, force: true });
    }
  });

  it('throws DOWNLOAD_MISSING_SCHEMA when shard-schema.yaml is missing', async () => {
    const os = await import('node:os');
    const tar = await import('tar');
    const crypto = await import('node:crypto');
    const tmpTarball = path.join(os.tmpdir(), `test-tarball-${crypto.randomUUID()}.tar.gz`);
    const tmpSrc = path.join(os.tmpdir(), `test-src-${crypto.randomUUID()}`);
    const innerDir = path.join(tmpSrc, 'owner-repo-abc');
    await fs.mkdir(path.join(innerDir, '.shardmind'), { recursive: true });
    await fs.writeFile(path.join(innerDir, '.shardmind', 'shard.yaml'), 'apiVersion: v1');
    await tar.c({ gzip: true, file: tmpTarball, cwd: tmpSrc }, ['owner-repo-abc']);

    try {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(tmpTarball));
      const err = await downloadShard('https://example.com/tarball').catch(e => e);
      expect(err.code).toBe('DOWNLOAD_MISSING_SCHEMA');
    } finally {
      await fs.rm(tmpTarball, { force: true });
      await fs.rm(tmpSrc, { recursive: true, force: true });
    }
  });

  it('includes Authorization header for GitHub URLs when GITHUB_TOKEN is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));
    globalThis.fetch = mockFetch;

    const originalToken = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'test-token-123';

    try {
      const result = await downloadShard('https://api.github.com/repos/owner/repo/tarball/v1.0.0');
      cleanupFns.push(result.cleanup);

      const callArgs = mockFetch.mock.calls[0]!;
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-token-123');
    } finally {
      if (originalToken === undefined) {
        delete process.env['GITHUB_TOKEN'];
      } else {
        process.env['GITHUB_TOKEN'] = originalToken;
      }
    }
  });

  it('does not include Authorization header for non-GitHub URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));
    globalThis.fetch = mockFetch;

    const originalToken = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'test-token-123';

    try {
      const result = await downloadShard('https://example.com/tarball');
      cleanupFns.push(result.cleanup);

      const callArgs = mockFetch.mock.calls[0]!;
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    } finally {
      if (originalToken === undefined) {
        delete process.env['GITHUB_TOKEN'];
      } else {
        process.env['GITHUB_TOKEN'] = originalToken;
      }
    }
  });
});
