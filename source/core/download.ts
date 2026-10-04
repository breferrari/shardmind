import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { TempShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import {
  SHARD_MANIFEST_FILE,
  SHARD_SCHEMA_FILE,
  SHARD_SOURCE_DIR,
} from '../runtime/vault-paths.js';

/**
 * Fetch and extract a shard tarball into a fresh temp dir. `onTempDir`
 * receives the dir's cleanup as soon as the dir exists, before the fetch,
 * so a command's Ctrl+C handler can remove it mid-download, which
 * `TempShard.cleanup`, only returned once the download finishes, cannot
 * (#57). That cleanup first aborts the fetch and the extraction and waits
 * for them to stop, so the removal does not race tar still writing into
 * the dir.
 */
export async function downloadShard(
  tarballUrl: string,
  onTempDir?: (cleanup: () => Promise<void>) => void,
): Promise<TempShard> {
  const tempDir = path.join(os.tmpdir(), `shardmind-${crypto.randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const controller = new AbortController();
  let inFlight: Promise<unknown> = Promise.resolve();
  const dispose = async (): Promise<void> => {
    controller.abort();
    await inFlight.catch(() => {});
    await cleanup(tempDir);
  };
  try {
    onTempDir?.(dispose);
  } catch (err) {
    await safeCleanup(tempDir);
    throw err;
  }

  const work = fetchAndExtract(tarballUrl, tempDir, controller.signal, dispose);
  inFlight = work;
  return work;
}

async function fetchAndExtract(
  tarballUrl: string,
  tempDir: string,
  signal: AbortSignal,
  dispose: () => Promise<void>,
): Promise<TempShard> {
  // Fetch tarball
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
  };
  if (process.env['GITHUB_TOKEN'] && isGitHubUrl(tarballUrl)) {
    headers['Authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
  }

  let response: Response;
  try {
    response = await fetch(tarballUrl, { headers, signal });
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
    await pipeline(nodeStream, hashTap, extractor, { signal });
  } catch (err) {
    await safeCleanup(tempDir);
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Downloaded archive is not a valid tarball: ${message}`,
      'DOWNLOAD_INVALID_TARBALL',
      'The downloaded file is not a valid tar archive.',
    );
  }

  // Verify required files (v6: manifest + schema live under .shardmind/)
  const manifestPath = path.join(tempDir, SHARD_SOURCE_DIR, SHARD_MANIFEST_FILE);
  const schemaPath = path.join(tempDir, SHARD_SOURCE_DIR, SHARD_SCHEMA_FILE);

  try {
    await fs.access(manifestPath);
  } catch {
    await safeCleanup(tempDir);
    throw new ShardMindError(
      `Not a valid shard: ${SHARD_SOURCE_DIR}/${SHARD_MANIFEST_FILE} not found`,
      'DOWNLOAD_MISSING_MANIFEST',
      `Ensure the shard repository includes ${SHARD_SOURCE_DIR}/${SHARD_MANIFEST_FILE}.`,
    );
  }

  try {
    await fs.access(schemaPath);
  } catch {
    await safeCleanup(tempDir);
    throw new ShardMindError(
      `Not a valid shard: ${SHARD_SOURCE_DIR}/${SHARD_SCHEMA_FILE} not found`,
      'DOWNLOAD_MISSING_SCHEMA',
      `Ensure the shard repository includes ${SHARD_SOURCE_DIR}/${SHARD_SCHEMA_FILE}.`,
    );
  }

  return {
    tempDir,
    manifest: manifestPath,
    schema: schemaPath,
    tarball_sha256: hasher.digest('hex'),
    cleanup: dispose,
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
  // Retries ride out a Windows handle the aborted extraction is still closing.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function safeCleanup(dir: string): Promise<void> {
  try {
    await cleanup(dir);
  } catch {
    // Best-effort — don't mask the original error
  }
}
