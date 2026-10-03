/**
 * Vault path guard (#163).
 *
 * The engine writes with `fsp.writeFile` / `copyFile`, which follow links,
 * so a vault path that is a symlink, sits under a symlinked folder, is a
 * file with another hard link, or exists only under a different case on a
 * case-folding filesystem sends the write somewhere other than the path
 * the engine records — outside the vault in the first two. Install,
 * update and adopt check every path they will touch before touching any,
 * and refuse the whole run. See `docs/ARCHITECTURE.md §10.1` and
 * `docs/ERRORS.md` (`VAULT_PATH_UNSAFE`).
 */

import fsp from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';
import { STATE_FILE, VALUES_FILE } from '../runtime/vault-paths.js';
import { mapConcurrent } from './fs-utils.js';

export type UnsafeVaultPathReason = 'symlink' | 'symlinked-folder' | 'hard-link' | 'case-mismatch';

export interface UnsafeVaultPath {
  /** Vault-relative, as given. */
  path: string;
  reason: UnsafeVaultPathReason;
}

/** The engine's own files, which every install, update and adopt writes. */
const ENGINE_WRITE_PATHS: readonly string[] = [VALUES_FILE, STATE_FILE];

/** Paths named in the error message before "and N more". */
const MAX_LISTED_PATHS = 10;

/** A cached async lookup that maps "not there" (ENOENT, ENOTDIR) to null. */
function cachedOrNull<T>(lookup: (key: string) => Promise<T>): (key: string) => Promise<T | null> {
  const cache = new Map<string, Promise<T | null>>();
  return (key) => {
    let entry = cache.get(key);
    if (!entry) {
      entry = lookup(key).catch((err: unknown) => {
        const code = errnoCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      });
      cache.set(key, entry);
    }
    return entry;
  };
}

/**
 * The given vault-relative paths (either separator) that are unsafe to
 * touch, walking each component from the vault root. `writes` are checked
 * in full. `deletes` only need their folders checked: unlinking a symlink
 * or a hard-linked file harms nothing else, but deleting through a
 * symlinked folder deletes outside the vault. A path whose parent does
 * not exist yet is safe: nothing on its way is a link. The vault root
 * itself is not checked. Listings and `lstat` results are cached.
 */
export async function findUnsafeVaultPaths(
  vaultRoot: string,
  writes: readonly string[],
  deletes: readonly string[] = [],
): Promise<UnsafeVaultPath[]> {
  const list = cachedOrNull((dir) =>
    fsp.readdir(dir).then((names) => new Set(names.map((n) => n.normalize('NFC')))),
  );
  const lstat = cachedOrNull((abs): Promise<Stats> => fsp.lstat(abs));

  const check = async (rel: string, foldersOnly: boolean): Promise<UnsafeVaultPathReason | null> => {
    const segments = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    const checked = foldersOnly ? segments.slice(0, -1) : segments;
    let dir = vaultRoot;
    for (const [i, name] of checked.entries()) {
      const last = i === segments.length - 1;
      const abs = path.join(dir, name);
      const [names, st] = await Promise.all([list(dir), lstat(abs)]);
      if (names === null || st === null) return null;
      if (!names.has(name.normalize('NFC'))) {
        // It resolves, but not under this name: the filesystem folded case
        // (a normalization-only difference is the same name, and passes).
        const lower = name.normalize('NFC').toLowerCase();
        if ([...names].some((n) => n.toLowerCase() === lower)) return 'case-mismatch';
      }
      if (st.isSymbolicLink()) return last ? 'symlink' : 'symlinked-folder';
      if (last) return st.isFile() && st.nlink > 1 ? 'hard-link' : null;
      dir = abs;
    }
    return null;
  };

  const all = [
    ...writes.map((rel) => ({ rel, foldersOnly: false })),
    ...deletes.map((rel) => ({ rel, foldersOnly: true })),
  ];
  const reasons = await mapConcurrent(all, 16, ({ rel, foldersOnly }) => check(rel, foldersOnly));
  return all.flatMap(({ rel }, i) => (reasons[i] ? [{ path: rel, reason: reasons[i]! }] : []));
}

/**
 * Throw `VAULT_PATH_UNSAFE` naming each unsafe path, or resolve. The
 * engine's own files (`shard-values.yaml`, `.shardmind/state.json`) are
 * always checked as writes.
 */
export async function assertSafeVaultPaths(
  vaultRoot: string,
  writes: readonly string[],
  deletes: readonly string[] = [],
): Promise<void> {
  const unsafe = await findUnsafeVaultPaths(vaultRoot, [...writes, ...ENGINE_WRITE_PATHS], deletes);
  if (unsafe.length === 0) return;
  const listed = unsafe.slice(0, MAX_LISTED_PATHS).map((u) => `${u.path} (${u.reason})`).join(', ');
  const more = unsafe.length > MAX_LISTED_PATHS ? `, and ${unsafe.length - MAX_LISTED_PATHS} more` : '';
  throw new ShardMindError(
    `Refusing to write through ${unsafe.length} unsafe vault path${unsafe.length === 1 ? '' : 's'}: ${listed}${more}`,
    'VAULT_PATH_UNSAFE',
    'Replace each link with a regular file or folder (copy its content in), remove it, or rename the folder to the shard’s casing, then run the command again. See docs/ERRORS.md#vault_path_unsafe.',
  );
}
