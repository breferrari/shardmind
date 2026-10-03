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

/** The engine's own files every install, update and adopt writes. */
export const ENGINE_WRITE_PATHS: readonly string[] = [VALUES_FILE, STATE_FILE];

export type UnsafeVaultPathReason = 'symlink' | 'symlinked-folder' | 'hard-link' | 'case-mismatch';

export interface UnsafeVaultPath {
  /** Vault-relative, as given. */
  path: string;
  reason: UnsafeVaultPathReason;
}

/** Paths named in the error message before "and N more". */
const LISTED = 10;

/**
 * The given vault-relative paths (either separator) that are unsafe to
 * write or delete, walking each component from the vault root. A path
 * whose parent does not exist yet is safe: nothing on its way is a link.
 * The vault root itself is not checked. Directory listings and `lstat`
 * results are cached across paths.
 */
export async function findUnsafeVaultPaths(
  vaultRoot: string,
  relPaths: readonly string[],
): Promise<UnsafeVaultPath[]> {
  const listings = new Map<string, Promise<Set<string> | null>>();
  const stats = new Map<string, Promise<Stats | null>>();

  const list = (dir: string) => {
    let entry = listings.get(dir);
    if (!entry) {
      entry = fsp.readdir(dir).then(
        (names) => new Set(names.map((n) => n.normalize('NFC'))),
        (err: unknown) => {
          const code = errnoCode(err);
          if (code === 'ENOENT' || code === 'ENOTDIR') return null;
          throw err;
        },
      );
      listings.set(dir, entry);
    }
    return entry;
  };
  const lstat = (abs: string) => {
    let entry = stats.get(abs);
    if (!entry) {
      entry = fsp.lstat(abs).catch((err: unknown) => {
        const code = errnoCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      });
      stats.set(abs, entry);
    }
    return entry;
  };

  const check = async (rel: string): Promise<UnsafeVaultPathReason | null> => {
    const segments = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    let dir = vaultRoot;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!;
      const last = i === segments.length - 1;
      const abs = path.join(dir, name);
      const names = await list(dir);
      if (names === null) return null;
      const st = await lstat(abs);
      if (!st) return null;
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

  const unsafe: UnsafeVaultPath[] = [];
  for (const rel of relPaths) {
    const reason = await check(rel);
    if (reason) unsafe.push({ path: rel, reason });
  }
  return unsafe;
}

/** Throw `VAULT_PATH_UNSAFE` naming each unsafe path, or resolve. */
export async function assertSafeVaultPaths(vaultRoot: string, relPaths: readonly string[]): Promise<void> {
  const unsafe = await findUnsafeVaultPaths(vaultRoot, relPaths);
  if (unsafe.length === 0) return;
  const listed = unsafe.slice(0, LISTED).map((u) => `${u.path} (${u.reason})`).join(', ');
  const more = unsafe.length > LISTED ? `, and ${unsafe.length - LISTED} more` : '';
  throw new ShardMindError(
    `Refusing to write through ${unsafe.length} unsafe vault path${unsafe.length === 1 ? '' : 's'}: ${listed}${more}`,
    'VAULT_PATH_UNSAFE',
    'Replace each link with a regular file or folder (copy its content in), remove it, or rename the folder to the shard’s casing, then run the command again. See docs/ERRORS.md#vault_path_unsafe.',
  );
}
