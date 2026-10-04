import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { TempShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { removePath } from './fs-utils.js';
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
/**
 * Thrown when a download is stopped by its own cleanup (Ctrl+C). Not a
 * failure: the command is exiting, and a caller must not report it as a
 * network or archive error.
 */
export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

/**
 * Default extraction limits (#32). obsidian-mind v9.0.0 extracts to about
 * 6.9 MB in 318 entries (measured 2026-10-04): these leave ~37x and ~300x
 * headroom while stopping a decompression bomb well before it fills a disk.
 */
const DEFAULT_MAX_SHARD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SHARD_ENTRIES = 100_000;
const SIZE_SUFFIX: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

interface ExtractionLimits {
  bytes: number;
  entries: number;
}

/**
 * A limit from the environment, or `fallback` when the variable is unset. A
 * set value that is not a positive whole number (with a `K`/`M`/`G` suffix
 * where `withSuffix`) is refused, never ignored: a typo must not change or
 * remove a limit silently.
 */
function readLimit(name: string, fallback: number, withSuffix: boolean): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const match = (withSuffix ? /^(\d+)([KMG])?$/i : /^(\d+)$/).exec(raw);
  const value = match ? Number(match[1]) * (match[2] ? SIZE_SUFFIX[match[2].toUpperCase()]! : 1) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ShardMindError(
      `${name} is not a valid limit: '${raw}'`,
      'DOWNLOAD_LIMIT_INVALID',
      withSuffix
        ? `Set ${name} to a positive whole number of bytes, optionally with K, M or G (e.g. 1G), or unset it.`
        : `Set ${name} to a positive whole number, or unset it.`,
    );
  }
  return value;
}

function extractionLimits(): ExtractionLimits {
  return {
    bytes: readLimit('SHARDMIND_MAX_SHARD_SIZE', DEFAULT_MAX_SHARD_BYTES, true),
    entries: readLimit('SHARDMIND_MAX_SHARD_ENTRIES', DEFAULT_MAX_SHARD_ENTRIES, false),
  };
}

export async function downloadShard(
  tarballUrl: string,
  onTempDir?: (cleanup: () => Promise<void>) => void,
): Promise<TempShard> {
  // Read first: an invalid override refuses before any network or disk work.
  const limits = extractionLimits();
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

  const work = fetchAndExtract(tarballUrl, tempDir, controller.signal, dispose, limits);
  inFlight = work;
  return work;
}

async function fetchAndExtract(
  tarballUrl: string,
  tempDir: string,
  signal: AbortSignal,
  dispose: () => Promise<void>,
  limits: ExtractionLimits,
): Promise<TempShard> {
  // Disposed inside `onTempDir`, before any work: there is nothing to fetch.
  if (signal.aborted) throw new DownloadCancelledError();
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
    if (signal.aborted) throw new DownloadCancelledError();
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
    // Count what each entry declares before its body is written (#32). The
    // declared size is what extraction writes: a pax size override is applied
    // to the header before the body is read, the body is consumed to exactly
    // that size, and sparse entries are never written. So a small, highly
    // compressed archive (a decompression bomb) stops before filling the disk.
    let bytes = 0;
    let entries = 0;
    let stopped = false;
    const stop = (err: ShardMindError): false => {
      if (!stopped) extractor.abort(err);
      stopped = true;
      return false;
    };
    const extractor = tar.x({
      strip: 1,
      C: tempDir,
      filter: (_path, entry) => {
        if (stopped) return false;
        entries += 1;
        // A pax `size` that is not a number stays a string in node-tar; added
        // to the count it would turn it into a string every later entry
        // compares past. Such an entry is refused.
        const size: unknown = 'size' in entry ? entry.size : 0;
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
          return stop(
            new ShardMindError(
              `Shard archive entry ${String(_path)} declares no valid size`,
              'DOWNLOAD_INVALID_TARBALL',
              'The archive is malformed or crafted; do not install it.',
            ),
          );
        }
        bytes += size;
        const tripped =
          bytes > limits.bytes ? `${limits.bytes} bytes` : entries > limits.entries ? `${limits.entries} entries` : null;
        if (tripped === null) return true;
        return stop(
          new ShardMindError(
            `Shard archive is larger than the limit of ${tripped}`,
            'SHARD_TOO_LARGE',
            'Raise SHARDMIND_MAX_SHARD_SIZE or SHARDMIND_MAX_SHARD_ENTRIES only for a shard you trust. See docs/ERRORS.md#shard_too_large.',
          ),
        );
      },
    });
    await pipeline(nodeStream, hashTap, extractor, { signal });
  } catch (err) {
    if (signal.aborted) throw new DownloadCancelledError();
    await safeCleanup(tempDir);
    // The extraction's own refusals (a limit, a malformed entry) keep their code.
    if (err instanceof ShardMindError) throw err;
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
  await removePath(dir);
}

async function safeCleanup(dir: string): Promise<void> {
  try {
    await cleanup(dir);
  } catch {
    // Best-effort — don't mask the original error
  }
}
