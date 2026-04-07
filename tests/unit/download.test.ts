import path from 'node:path';
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

  beforeEach(() => {
    cleanupFns = [];
  });

  afterEach(async () => {
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
    expect(result.manifest).toBe(path.join(result.tempDir, 'shard.yaml'));
    expect(result.schema).toBe(path.join(result.tempDir, 'shard-schema.yaml'));
  });

  it('extracted files exist on disk', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));

    const result = await downloadShard('https://example.com/tarball');
    cleanupFns.push(result.cleanup);

    const manifestStat = await fs.stat(result.manifest);
    expect(manifestStat.isFile()).toBe(true);

    const schemaStat = await fs.stat(result.schema);
    expect(schemaStat.isFile()).toBe(true);

    // Templates should also be extracted
    const templatesDir = path.join(result.tempDir, 'templates');
    const templatesStat = await fs.stat(templatesDir);
    expect(templatesStat.isDirectory()).toBe(true);
  });

  it('cleanup() removes the temp directory', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));

    const result = await downloadShard('https://example.com/tarball');
    const { tempDir } = result;

    await result.cleanup();

    await expect(fs.access(tempDir)).rejects.toThrow();
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
    await fs.mkdir(innerDir, { recursive: true });
    await fs.writeFile(path.join(innerDir, 'shard-schema.yaml'), 'schema_version: 1');
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

  it('includes Authorization header when GITHUB_TOKEN is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(FIXTURE_TARBALL));
    globalThis.fetch = mockFetch;

    const originalToken = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'test-token-123';

    try {
      const result = await downloadShard('https://example.com/tarball');
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
});
