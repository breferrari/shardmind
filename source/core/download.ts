import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { TempShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { SHARD_MANIFEST_FILE, SHARD_SCHEMA_FILE } from '../runtime/vault-paths.js';

export async function downloadShard(tarballUrl: string): Promise<TempShard> {
  const tempDir = path.join(os.tmpdir(), `shardmind-${crypto.randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  // Fetch tarball
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
  };
  if (process.env['GITHUB_TOKEN'] && isGitHubUrl(tarballUrl)) {
    headers['Authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
  }

  let response: Response;
  try {
    response = await fetch(tarballUrl, { headers });
  } catch (err) {
    await safeCleanup(tempDir);
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Failed to download: ${message}`,
      'DOWNLOAD_HTTP_ERROR',
      'Check the tarball URL and your internet connection.',
    );
  }

  if (!response.ok) {
    await safeCleanup(tempDir);
    throw new ShardMindError(
      `Failed to download: HTTP ${response.status}`,
      'DOWNLOAD_HTTP_ERROR',
      'Check the tarball URL and your internet connection.',
    );
  }

  if (!response.body) {
    await safeCleanup(tempDir);
    throw new ShardMindError(
      'Failed to download: empty response body',
      'DOWNLOAD_HTTP_ERROR',
      'The server returned an empty response.',
    );
  }

  // Extract tarball and hash the bytes in the same pass.
  const hasher = crypto.createHash('sha256');
  try {
    const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const hashTap = new Transform({
      transform(chunk, _enc, cb) {
        hasher.update(chunk);
        cb(null, chunk);
      },
    });
    const extractor = tar.x({ strip: 1, C: tempDir });
    await pipeline(nodeStream, hashTap, extractor);
  } catch (err) {
    await safeCleanup(tempDir);
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Downloaded archive is not a valid tarball: ${message}`,
      'DOWNLOAD_INVALID_TARBALL',
      'The downloaded file is not a valid tar archive.',
    );
  }

  // Verify required files
  const manifestPath = path.join(tempDir, SHARD_MANIFEST_FILE);
  const schemaPath = path.join(tempDir, SHARD_SCHEMA_FILE);

  try {
    await fs.access(manifestPath);
  } catch {
    await safeCleanup(tempDir);
    throw new ShardMindError(
      'Not a valid shard: shard.yaml not found',
      'DOWNLOAD_MISSING_MANIFEST',
      'Ensure the shard repository includes shard.yaml in its root.',
    );
  }

  try {
    await fs.access(schemaPath);
  } catch {
    await safeCleanup(tempDir);
    throw new ShardMindError(
      'Not a valid shard: shard-schema.yaml not found',
      'DOWNLOAD_MISSING_SCHEMA',
      'Ensure the shard repository includes shard-schema.yaml in its root.',
    );
  }

  return {
    tempDir,
    manifest: manifestPath,
    schema: schemaPath,
    tarball_sha256: hasher.digest('hex'),
    cleanup: () => cleanup(tempDir),
  };
}

function isGitHubUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'api.github.com' || host === 'codeload.github.com';
  } catch {
    return false;
  }
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function safeCleanup(dir: string): Promise<void> {
  try {
    await cleanup(dir);
  } catch {
    // Best-effort — don't mask the original error
  }
}
