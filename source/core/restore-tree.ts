/**
 * Put a snapshot back (#247, #264). Never throws: every file it cannot
 * restore or remove is collected as a `RollbackFailure`, so the ones before
 * it still reach the user. Failure paths are POSIX, relative to the vault.
 *
 * - `restoreTree` copies the snapshot over `destRoot` and leaves whatever
 *   else is there. Update restores its `files/` snapshot over the vault
 *   root, which holds the user's own files too.
 * - `restoreDirExactly` makes a folder the run replaced whole equal to a
 *   snapshot of it that is known to be complete: what the snapshot lacks is
 *   removed, and a symlink at a restored path is removed rather than
 *   written through. Under a snapshot folder that cannot be read, nothing
 *   is removed, since what it held is unknown.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from '../runtime/errno.js';
import { removePath } from './fs-utils.js';
import { reasonOf, type RollbackFailure } from './rollback-report.js';

interface Listing {
  files: string[];
  dirs: string[];
  /** Folders whose contents could not be read. */
  unreadable: string[];
}

export async function restoreTree(
  srcRoot: string,
  destRoot: string,
  failures: RollbackFailure[],
  opts: {
    /** Paths under `srcRoot` to leave alone, with everything below them (restored another way). */
    skip?: readonly string[];
    /** Prefix for failure paths, the vault-relative path of `destRoot`. */
    label?: string;
  } = {},
): Promise<void> {
  const listing = await listTree(srcRoot, failures, opts.label, true, opts.skip);
  if (!listing) return;
  await copyAll(srcRoot, destRoot, listing.files, failures, opts.label);
}

export async function restoreDirExactly(
  srcRoot: string,
  destRoot: string,
  failures: RollbackFailure[],
  opts: { label?: string } = {},
): Promise<void> {
  const want = await listTree(srcRoot, failures, opts.label, true);
  if (!want) {
    // The caller knows the folder did not exist before: remove it.
    await removeLogged(destRoot, opts.label ?? '.', failures);
    return;
  }
  const have = (await listTree(destRoot, failures, opts.label, false)) ?? { files: [], dirs: [], unreadable: [] };
  const wantFiles = new Set(want.files);
  const wantDirs = new Set(want.dirs);
  const unknown = (rel: string) => want.unreadable.some((d) => rel === d || rel.startsWith(d + path.sep));

  for (const rel of have.files) {
    if (unknown(rel)) continue;
    const abs = path.join(destRoot, rel);
    // A file the snapshot lacks goes; one it has goes too if it is a
    // symlink now, so the copy below writes a file, not through the link.
    if (wantFiles.has(rel) && !(await isSymlink(abs))) continue;
    await removeLogged(abs, labelled(opts.label, rel), failures);
  }
  // Deepest first, only folders the snapshot does not have.
  for (const rel of [...have.dirs].sort((a, b) => b.length - a.length)) {
    if (wantDirs.has(rel) || unknown(rel)) continue;
    try {
      await fsp.rmdir(path.join(destRoot, rel));
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        failures.push({ path: labelled(opts.label, rel), reason: `remove failed: ${reasonOf(err)}` });
      }
    }
  }
  for (const rel of want.dirs) {
    try {
      await fsp.mkdir(path.join(destRoot, rel), { recursive: true });
    } catch (err) {
      failures.push({ path: labelled(opts.label, rel), reason: `restore failed: ${reasonOf(err)}`, backup: path.join(srcRoot, rel) });
    }
  }
  await copyAll(srcRoot, destRoot, want.files, failures, opts.label);
}

async function copyAll(
  srcRoot: string,
  destRoot: string,
  files: readonly string[],
  failures: RollbackFailure[],
  label: string | undefined,
): Promise<void> {
  for (const rel of files) {
    const abs = path.join(srcRoot, rel);
    const dst = path.join(destRoot, rel);
    try {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(abs, dst);
    } catch (err) {
      // The snapshot is never removed, so `abs` is still there.
      failures.push({ path: labelled(label, rel), reason: `restore failed: ${reasonOf(err)}`, backup: abs });
    }
  }
}

/**
 * Every file and folder under `root`, relative, or undefined when `root`
 * does not exist. An unreadable folder is a failure, listed in `unreadable`;
 * `isSnapshot` says whether its path is a backup worth naming.
 */
async function listTree(
  root: string,
  failures: RollbackFailure[],
  label: string | undefined,
  isSnapshot: boolean,
  skip: readonly string[] = [],
): Promise<Listing | undefined> {
  try {
    await fsp.lstat(root);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    failures.push({ path: label ?? '.', reason: `read failed: ${reasonOf(err)}`, ...(isSnapshot ? { backup: root } : {}) });
    return { files: [], dirs: [], unreadable: [''] };
  }
  const skipped = skip.map((p) => path.normalize(p));
  const listing: Listing = { files: [], dirs: [], unreadable: [] };
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const rel = path.relative(root, dir);
      listing.unreadable.push(rel);
      failures.push({
        path: labelled(label, rel) || '.',
        reason: `readdir failed: ${reasonOf(err)}`,
        ...(isSnapshot ? { backup: dir } : {}),
      });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (skipped.some((p) => rel === p || rel.startsWith(p + path.sep))) continue;
      if (entry.isDirectory()) {
        listing.dirs.push(rel);
        await walk(full);
      } else {
        listing.files.push(rel);
      }
    }
  };
  await walk(root);
  return listing;
}

async function removeLogged(abs: string, label: string, failures: RollbackFailure[]): Promise<void> {
  try {
    // Retries Windows' transient EBUSY / EPERM / ENOTEMPTY.
    await removePath(abs);
  } catch (err) {
    failures.push({ path: label, reason: `remove failed: ${reasonOf(err)}` });
  }
}

async function isSymlink(abs: string): Promise<boolean> {
  return fsp.lstat(abs).then((s) => s.isSymbolicLink(), () => false);
}

/** The vault-relative POSIX path of `rel` under `label`. */
function labelled(label: string | undefined, rel: string): string {
  const joined = label ? (rel ? path.join(label, rel) : label) : rel;
  return joined.split(path.sep).join('/');
}
