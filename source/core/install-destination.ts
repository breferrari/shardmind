/**
 * Where `shardmind install <shard> [folder]` installs (#333). Spec:
 * docs/IMPLEMENTATION.md §4.31, ARCHITECTURE §10.6.
 *
 * A new folder named after the shard by default, as `git clone` makes one,
 * or the folder given; `.` is the current folder, as before #333. Decided,
 * and refused, before the lock, the state read, the download or any prompt.
 * Nothing is created here: a folder to create is made by the install's
 * transaction when it writes (`createRoot`, §4.28 step 0).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { shardNameOf } from './registry.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';

export interface InstallDestination {
  /** The vault folder, absolute. */
  root: string;
  /** The folder as the user wrote it, or the default name; null in place (`.`). */
  folder: string | null;
  /** The levels to make, outermost first; empty when the folder exists. */
  create: readonly string[];
}

export async function resolveInstallDestination(cwd: string, shardRef: string, folder?: string): Promise<InstallDestination> {
  // A malformed ref is refused first, whether or not a folder is given.
  const name = shardNameOf(shardRef);
  const given = folder ?? name;
  const root = path.resolve(cwd, given);
  if (root === path.resolve(cwd)) return { root, folder: null, create: [] };

  // Up from the vault folder to the nearest level that exists: everything
  // below it is to make. A file at a level makes the levels under it ENOTDIR.
  const create: string[] = [];
  for (let at = root; ; at = path.dirname(at)) {
    const stat = await fsp.lstat(at).catch((err: unknown) => {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    });
    if (stat === null) {
      create.unshift(at);
      continue;
    }
    if (!stat.isDirectory()) throw destinationTaken(given, at, 'is not a folder');
    break;
  }
  if (create.length === 0 && !(await isEmptyFolder(root))) throw destinationTaken(given, root, 'is not empty');
  return { root, folder: given, create };
}

/** One entry read, not the whole listing. */
async function isEmptyFolder(folder: string): Promise<boolean> {
  const dir = await fsp.opendir(folder);
  try {
    return (await dir.read()) === null;
  } finally {
    await dir.close();
  }
}

/**
 * `INSTALL_DESTINATION_NOT_EMPTY`: `at` (the folder, or a level on its way)
 * is in the way of installing into `folder`. Also thrown by the transaction
 * when the folder appears after planning (§4.28 step 0).
 */
export function destinationTaken(folder: string, at: string, what: string): ShardMindError {
  return new ShardMindError(
    `Cannot install into ${folder}: ${at} ${what}`,
    'INSTALL_DESTINATION_NOT_EMPTY',
    `Give another folder name (\`shardmind install <shard> my-vault\`), or install into the current folder with \`.\`.`,
  );
}
