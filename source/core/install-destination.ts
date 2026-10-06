/**
 * Where `shardmind install <shard> [folder]` installs (#333). Spec:
 * docs/IMPLEMENTATION.md §4.31, ARCHITECTURE §10.6.
 *
 * A new folder named after the shard by default, as `git clone` makes one,
 * or the folder given; `.` is the current folder, as before #333. With no
 * folder, a run from inside an existing vault is refused instead (#337).
 * Decided, and refused, before the lock, the state read, the download or
 * any prompt.
 * Nothing is created here: a folder to create is made by the install's
 * transaction when it writes (`createRoot`, §4.28 step 1a).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { shardNameOf } from './registry.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';
import { OBSIDIAN_DIR, STATE_FILE } from '../runtime/vault-paths.js';

export interface InstallDestination {
  /** The vault folder, absolute. */
  root: string;
  /** The folder as the user wrote it, or the default name; null in place (`.`). */
  folder: string | null;
  /** The levels to make, outermost first; empty when the folder exists. */
  create: readonly string[];
}

export async function resolveInstallDestination(cwd: string, shardRef: string, given?: string): Promise<InstallDestination> {
  // A malformed ref is refused first, whether or not a folder is given.
  const name = shardNameOf(shardRef);
  // An empty argument (an unset `$DEST`) is no folder, not the current one.
  const folder = given === '' ? undefined : given;
  // With no folder, a run from inside a vault would nest a second one in it (#337).
  if (folder === undefined) {
    const vault = await enclosingVault(cwd);
    if (vault !== null) throw insideVault(vault);
  }
  const chosen = folder ?? name;
  const root = path.resolve(cwd, chosen);
  if (root === path.resolve(cwd)) return { root, folder: null, create: [] };

  // Up from the vault folder to the nearest level that exists: everything
  // below it is to make. A file at a level makes the levels under it ENOTDIR.
  // A link to a folder is that folder (macOS's /tmp, a synced folder, a
  // junction): the vault folder's own contents are guarded when it writes.
  const create: string[] = [];
  for (let at = root; ; at = path.dirname(at)) {
    const stat = await fsp.stat(at).catch((err: unknown) => {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      // A link loop, a level it may not read, a share it cannot reach.
      throw destinationTaken(chosen, at, `cannot be reached (${code ?? String(err)})`, PATH_HINT);
    });
    if (stat !== null) {
      if (!stat.isDirectory()) throw destinationTaken(chosen, at, 'is not a folder', PATH_HINT);
      break;
    }
    // A link to nothing (an offline synced folder): there, but no folder.
    if (await fsp.lstat(at).then(() => true, () => false)) throw destinationTaken(chosen, at, 'is a link to nothing', PATH_HINT);
    // Not even the drive or share exists (`Q:\vault`).
    if (path.dirname(at) === at) throw destinationTaken(chosen, at, 'does not exist', PATH_HINT);
    create.unshift(at);
  }
  if (create.length === 0 && !(await isEmptyFolder(root))) throw destinationTaken(chosen, root, 'is not empty');
  return { root, folder: chosen, create };
}

interface EnclosingVault {
  at: string;
  /** shardmind's (`state.json`) or only Obsidian's (`.obsidian/`): what upgrades it differs. */
  kind: 'shardmind' | 'obsidian';
}

/**
 * The nearest folder, from `cwd` up to the filesystem root, that is a vault:
 * it holds `.shardmind/state.json` (shardmind's) or `.obsidian/` (Obsidian's).
 * A level it cannot read is refused, never taken for one that is no vault.
 */
async function enclosingVault(cwd: string): Promise<EnclosingVault | null> {
  for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
    const [state, obsidian] = await Promise.all([statOrNull(path.join(at, STATE_FILE)), statOrNull(path.join(at, OBSIDIAN_DIR))]);
    if (state?.isFile()) return { at, kind: 'shardmind' };
    if (obsidian?.isDirectory()) return { at, kind: 'obsidian' };
    if (path.dirname(at) === at) return null;
  }
}

async function statOrNull(file: string): Promise<Awaited<ReturnType<typeof fsp.stat>> | null> {
  return fsp.stat(file).catch((err: unknown) => {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ShardMindError(
      `Cannot tell whether ${path.dirname(file)} is a vault: ${code ?? String(err)}`,
      'INSTALL_INSIDE_VAULT',
      'Name the folder to install into (`shardmind install <shard> my-vault`), which skips this check.',
    );
  });
}

/**
 * INSTALL_INSIDE_VAULT for a run with no folder from inside `vault`. Its
 * ways out name the vault, which may be above the current folder: `.` and
 * `update` act on the current folder, so they need a `cd` there first.
 */
function insideVault(vault: EnclosingVault): ShardMindError {
  const upgrade =
    vault.kind === 'shardmind'
      ? `To upgrade that vault, \`cd "${vault.at}"\` and run \`shardmind update\`.`
      : `To bring that Obsidian vault under a shard, \`cd "${vault.at}"\` and run \`shardmind adopt <shard>\`.`;
  return new ShardMindError(
    `Cannot install into a new folder inside the vault at ${vault.at}`,
    'INSTALL_INSIDE_VAULT',
    `Name a folder to install into anyway (\`shardmind install <shard> my-vault\`). To install into that vault in place, \`cd "${vault.at}"\` and run \`shardmind install <shard> .\`. ${upgrade}`,
  );
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
 * when the folder appears after planning (§4.28 step 1a). The default hint
 * is for a folder that exists with something in it; a path that cannot hold
 * a vault at all gets `PATH_HINT`.
 */
export function destinationTaken(folder: string, at: string, what: string, hint = TAKEN_HINT): ShardMindError {
  return new ShardMindError(`Cannot install into ${folder}: ${at} ${what}`, 'INSTALL_DESTINATION_NOT_EMPTY', hint);
}

const TAKEN_HINT =
  'Give another folder name (`shardmind install <shard> my-vault`). To install into that folder as it is, `cd` into it and run `shardmind install <shard> .`; if it is already a shardmind vault, `shardmind update` there upgrades it.';

export const PATH_HINT = 'Check the path, or give another folder name (`shardmind install <shard> my-vault`).';
