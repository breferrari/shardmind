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
  SHARD_SCHEMA_FILE,
} from '../runtime/vault-paths.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { migrateState } from './state-migrator.js';
import { walkShardSource } from './modules.js';
import { loadShardmindignore } from './shardmindignore.js';
import { mapConcurrent, removePath, sha256 } from './fs-utils.js';
import { missingFolders, removeCreatedFolders } from './created-folders.js';

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

/**
 * Current on-disk `state.json` schema version. Bumped 1 → 2 with the hook
 * lifecycle split (#102): v2 adds the optional `bootstrap_fingerprint`
 * field. The bump is additive — `state-migrator.ts` forward-migrates v1
 * with a field-supplying rule. Exported so the install / update / adopt
 * executors stamp the same version they read.
 */
export const STATE_SCHEMA_VERSION = 2;

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

  await removePath(dest);
  await fsp.mkdir(dest, { recursive: true });
  await mapConcurrent(files, CACHE_COPY_CONCURRENCY, async ({ relPath, absPath }) => {
    const destPath = path.join(dest, relPath);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(absPath, destPath);
  });
}

/**
 * Cache the shard's manifest and schema under `.shardmind/`.
 *
 * Prefers a **verbatim copy** of the source files. Re-serialising the parsed
 * objects round-trips the YAML and discards everything the parser does not
 * model — every comment, and every quoting choice the shard author made
 * (#140). Measured against obsidian-mind 7.0.1: `shard-schema.yaml` lost all
 * 74 of its comment lines, and `shard.yaml` went 1,755 to 621 bytes. Those
 * comments are the only in-file explanation a user gets when they open the
 * file to change a value, and losing them is silent.
 *
 * It also breaks shards that assert on their own rendered artifact: OM's
 * `shard-contract.test.ts` requires a quoted `fingerprint`, which the
 * round-trip unquotes, so a clean install fails one of its own tests.
 *
 * `sourceDir` is optional so existing callers keep working. When it is absent,
 * or the copy fails, fall back to serialising the parsed objects — lossy, but
 * always a valid and complete file. Cache fidelity must never fail an install.
 */
export async function cacheManifest(
  vaultRoot: string,
  manifest: ShardManifest,
  schema: ShardSchema,
  sourceDir?: string,
): Promise<void> {
  await fsp.mkdir(path.join(vaultRoot, SHARDMIND_DIR), { recursive: true });

  if (sourceDir !== undefined) {
    try {
      await fsp.copyFile(
        path.join(sourceDir, SHARD_SOURCE_DIR, SHARD_MANIFEST_FILE),
        path.join(vaultRoot, CACHED_MANIFEST),
      );
      await fsp.copyFile(
        path.join(sourceDir, SHARD_SOURCE_DIR, SHARD_SCHEMA_FILE),
        path.join(vaultRoot, CACHED_SCHEMA),
      );
      return;
    } catch {
      // Source unreadable — fall through rather than failing the install.
    }
  }

  const serializedManifest = stringifyYaml(manifest, { lineWidth: 0 }).trimEnd() + '\n';
  const serializedSchema = stringifyYaml(schema, { lineWidth: 0 }).trimEnd() + '\n';

  await fsp.writeFile(path.join(vaultRoot, CACHED_MANIFEST), serializedManifest, 'utf-8');
  await fsp.writeFile(path.join(vaultRoot, CACHED_SCHEMA), serializedSchema, 'utf-8');
}

/** Paths a re-hash reads: every tracked entry. */
function rehashablePaths(state: ShardState): string[] {
  return Object.keys(state.files);
}

/**
 * Snapshot value for a path that exists but could not be read (EBUSY,
 * EACCES, …). Never a sha256, so it equals no recorded hash. Kept distinct
 * from an absent path: an unreadable file may hold the user's edit, and
 * must never be re-baselined as though a hook had created it.
 */
const UNREADABLE = '';

/**
 * Hash every tracked non-volatile file as it is on disk right now. The
 * hook orchestrator takes this snapshot before the first hook slot runs,
 * and `rehashManagedFiles` compares against it: a file whose bytes moved
 * since the snapshot was written by a hook. Absent paths (ENOENT) are left
 * out of the map; unreadable ones map to `UNREADABLE`.
 */
export async function snapshotTrackedHashes(
  vaultRoot: string,
  state: ShardState,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  await mapConcurrent(rehashablePaths(state), REHASH_CONCURRENCY, async (rel) => {
    try {
      hashes.set(rel, sha256(await fsp.readFile(path.join(vaultRoot, rel))));
    } catch (err) {
      // Absent: a hook that creates it reads as a change.
      if (!isEnoent(err)) hashes.set(rel, UNREADABLE);
    }
  });
  return hashes;
}

export interface RehashResult {
  state: ShardState;
  /** Paths whose bytes moved since the baseline snapshot (written by a hook). */
  changed: string[];
  /** The subset of `changed` whose new hash was recorded (engine-owned at snapshot time). */
  rebaselined: string[];
  /**
   * Files present at the baseline snapshot and gone now (typically because
   * a buggy hook deleted them). Drift detection will flag them as
   * `missing` on the next status run; we do not remove them from
   * `state.files` here since rehash is a hash-update operation, not a
   * state-membership operation.
   */
  missing: string[];
  /** I/O failures other than ENOENT (permission, EBUSY, …). */
  failed: Array<{ path: string; reason: string }>;
  /** Every path's hash now (`UNREADABLE` for failed reads): the baseline for a later re-hash. */
  current: Map<string, string>;
}

/**
 * Record what hooks wrote since `baseline` (from `snapshotTrackedHashes`).
 * Returns a NEW state value; the input is not mutated. Per
 * `docs/SHARD-LAYOUT.md §Re-hash + state`, the engine runs this after the
 * hook phase (success OR failure).
 *
 * A path whose bytes moved since the baseline was written by a hook, and
 * is reported in `changed`. Its new hash is recorded only when the file
 * was engine-owned when the baseline was taken: the baseline hash equals
 * `rendered_hash`, or the file was absent then. A file the user had
 * already edited is never re-baselined, even if a hook rewrote it —
 * `rendered_hash` is the engine's baseline, never the user's bytes, and
 * recording theirs would make drift read the edit as engine-owned so the
 * next update overwrites it (#150). The comparison is against the
 * snapshot rather than `rendered_hash` for the same reason: a user edit
 * made before the hook phase is not a hook write.
 *
 * Per-file ENOENT and other I/O errors are tolerated — the file's hash
 * stays at its prior value and the path is reported via `missing` /
 * `failed`. The hook contract is non-fatal (Helm pattern), so a hook
 * that broke the world cannot break the engine; the next `shardmind`
 * status run surfaces drift on the affected paths.
 */
export async function rehashManagedFiles(
  vaultRoot: string,
  state: ShardState,
  baseline: ReadonlyMap<string, string>,
): Promise<RehashResult> {
  const changed: string[] = [];
  const rebaselined: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const current = new Map<string, string>();
  const nextFiles: Record<string, FileState> = { ...state.files };

  await mapConcurrent(rehashablePaths(state), REHASH_CONCURRENCY, async (rel) => {
    const prior = state.files[rel]!;
    const before = baseline.get(rel);
    try {
      const hash = sha256(await fsp.readFile(path.join(vaultRoot, rel)));
      current.set(rel, hash);
      // Unreadable at snapshot time: who wrote what since is unknowable.
      if (hash === before || before === UNREADABLE) return;
      changed.push(rel);
      const engineOwned = before === undefined || before === prior.rendered_hash;
      if (engineOwned) {
        nextFiles[rel] = { ...prior, rendered_hash: hash };
        rebaselined.push(rel);
      }
    } catch (err) {
      if (isEnoent(err)) {
        if (before !== undefined) missing.push(rel);
        return;
      }
      current.set(rel, UNREADABLE);
      failed.push({
        path: rel,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    state: { ...state, files: nextFiles },
    changed,
    rebaselined,
    missing,
    failed,
    current,
  };
}

/**
 * The `.shardmind/` entries an install or adopt writes (a subset of the
 * engine's entries in `vault-path-guard.ts`). `removeEngineWrites` removes
 * exactly these on a rollback.
 */
export const ENGINE_INSTALL_WRITES: readonly string[] = [STATE_FILE, CACHED_MANIFEST, CACHED_SCHEMA, CACHED_TEMPLATES];

/**
 * Remove what an install or an adopt wrote under `.shardmind/`, and nothing
 * else, when it rolls back (#215, #243). The engine's own entries go
 * (`state.json`, `shard.yaml`, `shard-schema.yaml`, `templates/`, and the
 * run's own snapshot folder when given); `backups/` goes only with that
 * snapshot and only if it is then empty, and `.shardmind/` itself only when
 * `removeEmptyDir` is set and it is empty. `ENGINE_INSTALL_WRITES` lists the
 * entries, so install's rollback can leave them to this one place. The vault owner's files there (`boundary-ignore`, #190) are never
 * touched. Best effort: each failure is returned, never thrown.
 */
export async function removeEngineWrites(
  vaultRoot: string,
  opts: { snapshotDir?: string | null; removeEmptyDir: boolean },
): Promise<Array<{ path: string; reason: string }>> {
  const failures: Array<{ path: string; reason: string }> = [];
  const attempt = async (rel: string, op: () => Promise<unknown>, tolerate: (code: string | undefined) => boolean) => {
    try {
      await op();
    } catch (err) {
      if (!tolerate(errnoCode(err))) {
        failures.push({ path: rel, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  for (const rel of ENGINE_INSTALL_WRITES.filter((r) => r !== CACHED_TEMPLATES)) {
    await attempt(rel, () => fsp.unlink(path.join(vaultRoot, rel)), (code) => code === 'ENOENT');
  }
  await attempt(CACHED_TEMPLATES, () => removePath(path.join(vaultRoot, CACHED_TEMPLATES)), () => false);
  if (opts.snapshotDir) {
    const snapshot = opts.snapshotDir;
    await attempt(path.relative(vaultRoot, snapshot), () => removePath(snapshot), () => false);
  }
  // Only empty folders: rmdir refuses one that still holds the user's files.
  // A folder that can't go for any other reason (a Windows lock, or not a
  // folder) is left where it is; it is not this rollback's to force.
  const leaveIt = (code: string | undefined) =>
    code !== undefined && ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY', 'ENOTDIR'].includes(code);
  // `backups/` only when this run's snapshot was in it: install never
  // creates one, and an empty one the user kept is theirs.
  if (opts.snapshotDir) {
    const backups = path.join(SHARDMIND_DIR, 'backups');
    await attempt(backups, () => fsp.rmdir(path.join(vaultRoot, backups)), leaveIt);
  }
  if (opts.removeEmptyDir) {
    await attempt(SHARDMIND_DIR, () => fsp.rmdir(path.join(vaultRoot, SHARDMIND_DIR)), leaveIt);
  }
  return failures;
}

/**
 * Allocate this run's snapshot folder, `.shardmind/backups/<kind>-<stamp>`,
 * for update and adopt alike (#248). The stamp is to the millisecond and the
 * folder is created exclusively (`recursive: false` surfaces EEXIST), with
 * `-<n>` on a taken name, so two runs started in the same instant never
 * share a snapshot: a rollback of one would overwrite or delete the other's
 * copies. The suffix also guards against clock rewinds, coarse filesystem
 * mtime granularity, and two concurrent runs that hit the exact same
 * millisecond. Any other failure (a read-only vault, a file where a
 * folder should be) is the kind's write-failed error, not a raw errno, and
 * leaves no folder it made on the way (`.shardmind/`, `backups/`): it runs
 * before the run's rollback exists, so it cleans up after itself (#269).
 */
export async function createBackupDir(vaultRoot: string, now: Date, kind: 'update' | 'adopt'): Promise<string> {
  const madeOnTheWay = await missingFolders(vaultRoot, [`${SHARDMIND_DIR}/backups/${kind}`]);
  try {
    return await allocateBackupDir(vaultRoot, now, kind);
  } catch (err) {
    // Only the folders that were missing, and only while empty.
    await removeCreatedFolders(vaultRoot, madeOnTheWay);
    throw err;
  }
}

async function allocateBackupDir(vaultRoot: string, now: Date, kind: 'update' | 'adopt'): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const base = path.join(vaultRoot, SHARDMIND_DIR, 'backups', `${kind}-${stamp}`);
  const code = kind === 'update' ? 'UPDATE_WRITE_FAILED' : 'ADOPT_WRITE_FAILED';
  let parentsCreated = false;
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    try {
      await fsp.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (err) {
      const errno = errnoCode(err);
      if (errno === 'ENOENT' && !parentsCreated) {
        // Parent folders don't exist yet. Create them once, then retry this
        // name; a second ENOENT is a real failure, not a reason to loop.
        parentsCreated = true;
        try {
          await fsp.mkdir(path.dirname(base), { recursive: true });
        } catch (mkdirErr) {
          throw backupDirError(kind, code, mkdirErr);
        }
        i--;
        continue;
      }
      if (errno !== 'EEXIST') throw backupDirError(kind, code, err);
    }
  }
  throw new ShardMindError(
    `Could not allocate a unique ${kind} backup directory under ${SHARDMIND_DIR}/backups/`,
    code,
    `Too many recent ${kind} runs with the same timestamp — clean up old ${kind}-* directories and retry.`,
  );
}

function backupDirError(kind: 'update' | 'adopt', code: 'UPDATE_WRITE_FAILED' | 'ADOPT_WRITE_FAILED', err: unknown): ShardMindError {
  return new ShardMindError(
    `Could not create the ${kind} backup directory under ${SHARDMIND_DIR}/backups/: ${err instanceof Error ? err.message : String(err)}`,
    code,
    `Check that ${SHARDMIND_DIR}/ and ${SHARDMIND_DIR}/backups/ are writable folders, then retry.`,
  );
}
