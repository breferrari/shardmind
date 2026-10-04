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
import {
  CACHED_MANIFEST,
  CACHED_SCHEMA,
  CACHED_TEMPLATES,
  HOOK_LOGS_DIR,
  SHARDMIND_DIR,
  STATE_FILE,
  VALUES_FILE,
} from '../runtime/vault-paths.js';
import { mapConcurrent } from './fs-utils.js';

export type UnsafeVaultPathReason = 'symlink' | 'symlinked-folder' | 'hard-link' | 'case-mismatch';

export interface UnsafeVaultPath {
  /** Vault-relative, as given. */
  path: string;
  reason: UnsafeVaultPathReason;
}

/** The engine's own files and folders, which install, update and adopt write into. */
const ENGINE_WRITE_PATHS: readonly string[] = [
  VALUES_FILE,
  STATE_FILE,
  CACHED_MANIFEST,
  CACHED_SCHEMA,
  CACHED_TEMPLATES,
  path.join(SHARDMIND_DIR, 'backups'),
  path.join(SHARDMIND_DIR, 'update-check.json'),
  HOOK_LOGS_DIR,
  // Every hook slot's full-output log, `.shardmind/logs/<slot>.log`.
  ...(['bootstrap', 'personalize', 'post-update', 'post-install'] as const).map((slot) =>
    path.join(HOOK_LOGS_DIR, `${slot}.log`),
  ),
];

/** Paths named in the error message before "and N more". */
const MAX_LISTED_PATHS = 10;

const isMissing = (err: unknown) => {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** A cached async lookup; `onError` maps a failure to a value or rethrows. */
function cached<T>(
  lookup: (key: string) => Promise<T>,
  onError: (err: unknown, key: string) => T,
): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    let entry = cache.get(key);
    if (!entry) {
      entry = lookup(key).catch((err: unknown) => onError(err, key));
      cache.set(key, entry);
    }
    return entry;
  };
}

/**
 * Whether names inside `dir` resolve case-insensitively: an entry of the
 * vault, its ASCII letters' case swapped, reaches the same inode. Probed
 * inside the vault, not on its parent, which can be another filesystem
 * (a mounted USB stick). When it cannot be told (no entry with an ASCII
 * letter, or an error), assume it folds, so the listings are read.
 */
async function foldsCaseAt(dir: string): Promise<boolean> {
  try {
    const name = (await fsp.readdir(dir)).find((n) => /[A-Za-z]/.test(n));
    if (!name) return true;
    const swapped = name.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const [a, b] = await Promise.all([fsp.lstat(path.join(dir, name)), fsp.lstat(path.join(dir, swapped))]);
    return a.ino === b.ino && a.dev === b.dev;
  } catch (err) {
    return !isMissing(err);
  }
}

/** A path that could not be inspected: reported as one, not as a raw errno. */
function checkFailed(err: unknown, at: string): ShardMindError {
  return new ShardMindError(
    `Could not check vault path: ${at}`,
    'COLLISION_CHECK_FAILED',
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * The given vault-relative paths (either separator) that are unsafe to
 * touch, walking each component from the vault root. `writes` are checked
 * in full. `deletes` skip the link checks on their last component:
 * unlinking a symlink or a hard-linked file harms nothing else, but
 * deleting through a symlinked folder deletes outside the vault, and a
 * case-folded name deletes a file the user renamed. A path whose parent
 * does not exist yet is safe: nothing on its way is a link. The vault
 * root itself is not checked. Folders are listed for the case check only
 * on a case-folding filesystem, and a folder that cannot be listed skips
 * it. A path that cannot be inspected throws `COLLISION_CHECK_FAILED`.
 * Listings and `lstat` results are cached. `caseRenames` are the case-only
 * renames the run applies (old path, new path; #169, #195): a segment a pair
 * spells either way is not a `case-mismatch` on any path under the same
 * prefix, since it is the same file or folder under the name the run moves
 * it from or to.
 */
export async function findUnsafeVaultPaths(
  vaultRoot: string,
  writes: readonly string[],
  deletes: readonly string[] = [],
  caseRenames: ReadonlyArray<readonly [string, string]> = [],
): Promise<UnsafeVaultPath[]> {
  const folds = await foldsCaseAt(vaultRoot);
  // A prefix (as either side spells it, up to and including one segment) →
  // the spellings the pair gives that segment. Keyed by prefix, not by whole
  // path, so a file the run adds under a folder whose case it changes is
  // covered too (#195).
  const pairNames = new Map<string, Set<string>>();
  for (const [from, to] of caseRenames) {
    const a = from.split('/');
    const b = to.split('/');
    for (let i = 0; i < a.length && i < b.length; i++) {
      const names = new Set([a[i]!, b[i]!].map((n) => n.normalize('NFC')));
      for (const prefix of [a.slice(0, i + 1).join('/'), b.slice(0, i + 1).join('/')]) {
        const set = pairNames.get(prefix) ?? new Set<string>();
        for (const n of names) set.add(n);
        pairNames.set(prefix, set);
      }
    }
  }
  // null: no such folder. undefined: not listable, so the case check is skipped.
  const list = cached<Set<string> | null | undefined>(
    (dir) => fsp.readdir(dir).then((names) => new Set(names.map((n) => n.normalize('NFC')))),
    (err, dir) => {
      if (isMissing(err)) return null;
      const code = errnoCode(err);
      if (code === 'EACCES' || code === 'EPERM') return undefined;
      throw checkFailed(err, dir);
    },
  );
  const lstat = cached<Stats | null>(
    (abs) => fsp.lstat(abs),
    (err, abs) => {
      if (isMissing(err)) return null;
      throw checkFailed(err, abs);
    },
  );

  const check = async (rel: string, isDelete: boolean): Promise<UnsafeVaultPathReason | null> => {
    const segments = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    let dir = vaultRoot;
    for (const [i, name] of segments.entries()) {
      const last = i === segments.length - 1;
      const abs = path.join(dir, name);
      const [names, st] = await Promise.all([folds ? list(dir) : undefined, lstat(abs)]);
      if (names === null || st === null) return null;
      if (names && !names.has(name.normalize('NFC'))) {
        // It resolves, but not under this name: the filesystem folded case
        // (a normalization-only difference is the same name, and passes).
        const lower = name.normalize('NFC').toLowerCase();
        const onDisk = [...names].find((n) => n.toLowerCase() === lower);
        const prefix = segments.slice(0, i + 1).join('/');
        if (onDisk !== undefined && !pairNames.get(prefix)?.has(onDisk)) return 'case-mismatch';
      }
      if (last && isDelete) return null;
      if (st.isSymbolicLink()) return last ? 'symlink' : 'symlinked-folder';
      if (last) return st.isFile() && st.nlink > 1 ? 'hard-link' : null;
      dir = abs;
    }
    return null;
  };

  const all = [
    ...writes.map((rel) => ({ rel, isDelete: false })),
    ...deletes.map((rel) => ({ rel, isDelete: true })),
  ];
  const reasons = await mapConcurrent(all, 16, ({ rel, isDelete }) => check(rel, isDelete));
  return all.flatMap(({ rel }, i) => (reasons[i] ? [{ path: rel, reason: reasons[i]! }] : []));
}

/**
 * Throw `VAULT_PATH_UNSAFE` naming each unsafe path, or resolve. The
 * engine's own files and folders (`shard-values.yaml`, `.shardmind/`'s
 * state, cache, backups and logs) are always checked as writes.
 * `caseRenames` as in `findUnsafeVaultPaths`.
 */
export async function assertSafeVaultPaths(
  vaultRoot: string,
  writes: readonly string[],
  deletes: readonly string[] = [],
  caseRenames: ReadonlyArray<readonly [string, string]> = [],
): Promise<void> {
  const unsafe = await findUnsafeVaultPaths(vaultRoot, [...writes, ...ENGINE_WRITE_PATHS], deletes, caseRenames);
  if (unsafe.length === 0) return;
  const listed = unsafe.slice(0, MAX_LISTED_PATHS).map((u) => `${u.path} (${u.reason})`).join(', ');
  const more = unsafe.length > MAX_LISTED_PATHS ? `, and ${unsafe.length - MAX_LISTED_PATHS} more` : '';
  throw new ShardMindError(
    `Refusing to write through ${unsafe.length} unsafe vault path${unsafe.length === 1 ? '' : 's'}: ${listed}${more}`,
    'VAULT_PATH_UNSAFE',
    'Replace each link with a regular file or folder (copy its content in), remove it, or rename the folder to the shard’s casing, then run the command again. See docs/ERRORS.md#vault_path_unsafe.',
  );
}
