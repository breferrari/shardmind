import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
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
