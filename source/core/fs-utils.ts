import fsp from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';
import { errnoCode } from '../runtime/errno.js';

export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Errors a recursive remove hits while another process (a virus scanner, a
 * search indexer) holds a file in the tree, or descriptors run short: the set
 * `fs.rm` itself retries.
 */
const TRANSIENT_RM_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']);

/**
 * Remove a file or folder tree; a path that does not exist is not an error.
 * On Windows a scanner or indexer can still hold a file just written, and the
 * remove then fails with ENOTEMPTY, EBUSY or EPERM until it lets go (#191):
 * those, and EMFILE / ENFILE, are retried up to `maxRetries` times,
 * `retryDelay` ms apart and growing, and the original error is thrown if they
 * do not clear. Any other error is thrown at once. The loop is ours, not `fs.rm`'s `maxRetries`, so
 * a test can inject the error through `fsp.rm` and see it retried.
 */
export async function removePath(
  absolutePath: string,
  { maxRetries = 5, retryDelay = 100 }: { maxRetries?: number; retryDelay?: number } = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rm(absolutePath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (attempt >= maxRetries || code === undefined || !TRANSIENT_RM_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)));
    }
  }
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function toPosix(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, '/');
}

/**
 * Bounded-concurrency `map`. Runs `fn` over `items` with at most
 * `concurrency` in flight at once, preserving the input order in the
 * returned array. Used to cap file-descriptor pressure when fanning
 * out disk reads (drift detection, update merge planning, snapshots).
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Heuristic: a NUL byte in the first 8 KB indicates the file is not a
 * text file the diff UI can render usefully. Same convention git's diff
 * uses (the heuristic predates language-aware detection and is still
 * load-bearing in modern git for the "Binary files differ" message).
 *
 * The 8 KB ceiling caps work for huge files. For adopt's 2-way diff a wrong
 * answer only means a noisy diff. The update planner does not rely on it
 * alone: a wrong answer there would send bytes through the UTF-8 line merge
 * and corrupt them, so it uses `isBinaryForMerge` below (#63).
 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Whether bytes must not go through the line-based merge, which works on a
 * UTF-8 decoding and writes it back: they look binary (`looksBinary`), or
 * they are not valid UTF-8 anywhere (a Latin-1 CSV, a PDF with no early
 * NUL), so the decoding would not round-trip (#63).
 */
export function isBinaryForMerge(buf: Buffer): boolean {
  return looksBinary(buf) || !isUtf8(buf);
}
