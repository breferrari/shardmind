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
import { isEnoent } from '../runtime/errno.js';

export interface InstallDestination {
  /** The vault folder, absolute. */
  root: string;
  /** As the user wrote it, or the default name; `.` in place. */
  display: string;
  /** `.`: the current folder, installed into as before #333. */
  inPlace: boolean;
  /** The levels to make, outermost first; empty when the folder exists. */
  create: readonly string[];
}

export async function resolveInstallDestination(cwd: string, shardRef: string, folder?: string): Promise<InstallDestination> {
  const display = folder ?? shardNameOf(shardRef);
  const root = path.resolve(cwd, display);
  if (root === path.resolve(cwd)) return { root, display: '.', inPlace: true, create: [] };
  // A malformed ref is refused even with a folder given, as it would be later.
  if (folder !== undefined) shardNameOf(shardRef);

  // Each level from the nearest existing ancestor down: a folder, missing,
  // or something else in the way.
  const levels: string[] = [];
  for (let at = root; ; at = path.dirname(at)) {
    levels.unshift(at);
    if (path.dirname(at) === at) break;
  }
  const create: string[] = [];
  for (const level of levels) {
    if (create.length > 0) {
      create.push(level);
      continue;
    }
    const stat = await fsp.lstat(level).catch((err: unknown) => {
      if (isEnoent(err)) return null;
      throw err;
    });
    if (stat === null) create.push(level);
    else if (!stat.isDirectory()) throw notEmpty(level, display, level === root ? 'is a file' : 'is a file, not a folder');
  }
  if (create.length === 0 && (await fsp.readdir(root)).length > 0) throw notEmpty(root, display, 'is not empty');
  return { root, display, inPlace: false, create };
}

function notEmpty(at: string, display: string, what: string): ShardMindError {
  return new ShardMindError(
    `Cannot install into ${display}: ${at} ${what}`,
    'INSTALL_DESTINATION_NOT_EMPTY',
    `Give another folder name (\`shardmind install <shard> my-vault\`), or install into the current folder with \`.\`.`,
  );
}
