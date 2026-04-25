/**
 * Engine-owned state I/O. Reads AND writes `.shardmind/state.json`,
 * caches manifest/schema/templates at install time, and gates on
 * schema_version migrations.
 *
 * The read-only counterpart for hook scripts lives at
 * `source/runtime/state.ts`. Runtime never imports from here; the
 * duplication of filename is intentional (same concern, different
 * audience, different permissions).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ShardState, ShardManifest, ShardSchema, FileState } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { stringify as stringifyYaml } from 'yaml';
import {
  SHARDMIND_DIR,
  STATE_FILE,
  CACHED_MANIFEST,
  CACHED_SCHEMA,
  CACHED_TEMPLATES,
  SHARD_SOURCE_DIR,
  SHARD_MANIFEST_FILE,
} from '../runtime/vault-paths.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { migrateState } from './state-migrator.js';
import { walkShardSource } from './modules.js';
import { loadShardmindignore } from './shardmindignore.js';
import { mapConcurrent, sha256 } from './fs-utils.js';

/**
 * Cap on parallel `copyFile` operations during cache population. Same budget
 * the update planner uses for read fan-out — keeps file-descriptor pressure
 * bounded while shaving wall-clock on shards with hundreds of files.
 */
const CACHE_COPY_CONCURRENCY = 16;

/**
 * Cap on parallel `readFile + sha256` operations during the post-hook
 * re-hash pass. Same budget as the cache copy fan-out for the same
 * reasons — most managed-file sets are bounded in the low hundreds, but
 * we don't want a 5000-file shard to open 5000 file descriptors at once.
 */
const REHASH_CONCURRENCY = 16;

const STATE_SCHEMA_VERSION = 1;

export async function readState(vaultRoot: string): Promise<ShardState | null> {
  const filePath = path.join(vaultRoot, STATE_FILE);

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    throw new ShardMindError(
      `Cannot read state.json: ${filePath}`,
      'STATE_READ_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}`,
      'STATE_CORRUPT',
      'Delete .shardmind/ and reinstall, or fix the JSON manually.',
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { schema_version?: unknown }).schema_version !== 'number'
  ) {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}`,
      'STATE_CORRUPT',
      'Missing or invalid schema_version field.',
    );
  }

  const version = (parsed as { schema_version: number }).schema_version;
  if (version === STATE_SCHEMA_VERSION) {
    return parsed as ShardState;
  }

  const migrated = migrateState(parsed, version, STATE_SCHEMA_VERSION);
  if (migrated) return migrated;

  throw new ShardMindError(
    `Unsupported state schema_version: ${version}`,
    'STATE_UNSUPPORTED_VERSION',
    `This version of shardmind supports schema_version ${STATE_SCHEMA_VERSION}. No migration rule is registered for ${version} → ${STATE_SCHEMA_VERSION}.`,
  );
}

export async function writeState(vaultRoot: string, state: ShardState): Promise<void> {
  const shardDir = path.join(vaultRoot, SHARDMIND_DIR);
  const filePath = path.join(vaultRoot, STATE_FILE);

  await fsp.mkdir(shardDir, { recursive: true });

  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    throw new ShardMindError(
      `Unsupported state schema_version: ${state.schema_version}`,
      'STATE_UNSUPPORTED_VERSION',
      `This version of shardmind writes schema_version ${STATE_SCHEMA_VERSION}.`,
    );
  }

  const serialized = JSON.stringify(state, null, 2) + '\n';
  await fsp.writeFile(filePath, serialized, 'utf-8');
}

export async function initShardDir(vaultRoot: string): Promise<void> {
  await fsp.mkdir(path.join(vaultRoot, CACHED_TEMPLATES), { recursive: true });
}

/**
 * Cache the post-walk source-file set under `.shardmind/templates/` so the
 * three-way merge engine has a stable merge base for the next update.
 *
 * Walks the temp shard with the same Tier 1 + `.shardmindignore` + symlink
 * filter the install/update planners use, so the cache mirrors exactly what
 * the engine considered installable. Module gating is *not* applied here —
 * toggling a module on at update time must be able to read its source from
 * the cache without re-downloading.
 *
 * The required-file gate is `.shardmind/shard.yaml`'s presence, not a top-
 * level `templates/` dir (gone under v6).
 */
export async function cacheTemplates(vaultRoot: string, tempDir: string): Promise<void> {
  const dest = path.join(vaultRoot, CACHED_TEMPLATES);
  const manifestSrc = path.join(tempDir, SHARD_SOURCE_DIR, SHARD_MANIFEST_FILE);
  try {
    await fsp.access(manifestSrc);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new ShardMindError(
        `Missing ${SHARD_SOURCE_DIR}/${SHARD_MANIFEST_FILE} in shard source: ${manifestSrc}`,
        'STATE_CACHE_MISSING_MANIFEST',
        `The downloaded shard does not contain a ${SHARD_SOURCE_DIR}/${SHARD_MANIFEST_FILE} file.`,
      );
    }
    throw err;
  }

  const ignoreFilter = await loadShardmindignore(tempDir);
  const files = await walkShardSource(tempDir, ignoreFilter);

  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  await mapConcurrent(files, CACHE_COPY_CONCURRENCY, async ({ relPath, absPath }) => {
    const destPath = path.join(dest, relPath);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(absPath, destPath);
  });
}

export async function cacheManifest(
  vaultRoot: string,
  manifest: ShardManifest,
  schema: ShardSchema,
): Promise<void> {
  await fsp.mkdir(path.join(vaultRoot, SHARDMIND_DIR), { recursive: true });

  const serializedManifest = stringifyYaml(manifest, { lineWidth: 0 }).trimEnd() + '\n';
  const serializedSchema = stringifyYaml(schema, { lineWidth: 0 }).trimEnd() + '\n';

  await fsp.writeFile(path.join(vaultRoot, CACHED_MANIFEST), serializedManifest, 'utf-8');
  await fsp.writeFile(path.join(vaultRoot, CACHED_SCHEMA), serializedSchema, 'utf-8');
}

export interface RehashResult {
  state: ShardState;
  /** Paths whose `rendered_hash` changed during the re-hash pass. */
  changed: string[];
  /**
   * Files that disappeared between the prior write and the re-read pass
   * (typically because a buggy hook deleted them). Drift detection will
   * flag them as `missing` on the next status run; we do not remove them
   * from `state.files` here since rehash is a hash-update operation, not
   * a state-membership operation.
   */
  missing: string[];
  /** I/O failures other than ENOENT (permission, EBUSY, …). */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Recompute `rendered_hash` for every managed file in `state.files` by
 * reading the current bytes off disk. Returns a NEW state value; the
 * input is not mutated. Per `docs/SHARD-LAYOUT.md §Hooks, state, and
 * re-hash semantics`, the engine runs this after every post-install /
 * post-update hook (success OR failure) so `state.json` reflects actual
 * file content even when a hook touched managed files.
 *
 * Per-file ENOENT and other I/O errors are tolerated — the file's hash
 * stays at its prior value and the path is reported via `missing` /
 * `failed`. The hook contract is non-fatal (Helm pattern), so a hook
 * that broke the world cannot break the engine; the next `shardmind`
 * status run surfaces drift on the affected paths.
 *
 * Entries with `ownership === 'user'` are skipped: drift detection
 * already routes those through the volatile bucket (see `drift.ts:104`)
 * and never compares their stored hash, so re-reading + sha256-ing
 * them is wasted I/O that would also cause the function's behavior to
 * drift from its name (it really is "managed files", not "every entry
 * in state.files").
 */
export async function rehashManagedFiles(
  vaultRoot: string,
  state: ShardState,
): Promise<RehashResult> {
  const paths = Object.entries(state.files)
    .filter(([, file]) => file.ownership !== 'user')
    .map(([rel]) => rel);
  const changed: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const nextFiles: Record<string, FileState> = { ...state.files };

  await mapConcurrent(paths, REHASH_CONCURRENCY, async (rel) => {
    const prior = state.files[rel]!;
    try {
      const buf = await fsp.readFile(path.join(vaultRoot, rel));
      const hash = sha256(buf);
      if (hash !== prior.rendered_hash) {
        nextFiles[rel] = { ...prior, rendered_hash: hash };
        changed.push(rel);
      }
    } catch (err) {
      if (isEnoent(err)) {
        missing.push(rel);
        return;
      }
      failed.push({
        path: rel,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    state: { ...state, files: nextFiles },
    changed,
    missing,
    failed,
  };
}

