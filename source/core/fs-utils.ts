import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { SHARD_TEMPLATES_DIR } from '../runtime/vault-paths.js';

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
 * `state.files[x].template` stores the template path relative to the
 * downloaded temp dir at install time (e.g. `templates/brain/Index.md.njk`).
 * The cached copy lives under `.shardmind/templates/brain/Index.md.njk` —
 * same tail, different root. Strip the leading `templates/` segment if
 * present so callers can join against the cache dir cleanly.
 *
 * Shared between the update planner (which reads cached templates to
 * compute three-way merges) and the status command's verbose per-file
 * diff pass (which reads the same templates to compute `+N/−M`).
 */
export function stripTemplatePrefix(templateKey: string): string {
  const prefix = `${SHARD_TEMPLATES_DIR}/`;
  return templateKey.startsWith(prefix) ? templateKey.slice(prefix.length) : templateKey;
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
