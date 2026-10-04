/**
 * Put a snapshot back (#247, #264). Never throws: every file it cannot
 * restore or remove is collected as a `RollbackFailure`, so the ones before
 * it still reach the user.
 *
 * - `restoreTree` copies the snapshot over `destRoot` and leaves whatever
 *   else is there. Update restores its `files/` snapshot over the vault
 *   root, which holds the user's own files too.
 * - `restoreDirExactly` makes a folder the run replaced whole equal to its
 *   snapshot: what the snapshot lacks is removed, and with no snapshot the
 *   folder is removed, since it did not exist before.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './fs-utils.js';
import { reasonOf, type RollbackFailure } from './rollback-report.js';

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
  if (!(await pathExists(srcRoot))) return;
  const skip = (opts.skip ?? []).map((p) => path.normalize(p));
  const files = (await listTree(srcRoot, failures, opts.label)).files.filter(
    (rel) => !skip.some((p) => rel === p || rel.startsWith(p + path.sep)),
  );
  for (const rel of files) {
    const abs = path.join(srcRoot, rel);
    const dst = path.join(destRoot, rel);
    try {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(abs, dst);
    } catch (err) {
      // The snapshot is never removed, so `abs` is still there.
      failures.push({ path: labelled(opts.label, rel), reason: `restore failed: ${reasonOf(err)}`, backup: abs });
    }
  }
}

export async function restoreDirExactly(
  srcRoot: string,
  destRoot: string,
  failures: RollbackFailure[],
  opts: { label?: string } = {},
): Promise<void> {
  if (!(await pathExists(srcRoot))) {
    try {
      await fsp.rm(destRoot, { recursive: true, force: true });
    } catch (err) {
      failures.push({ path: opts.label ?? destRoot, reason: `remove failed: ${reasonOf(err)}` });
    }
    return;
  }
  const want = await listTree(srcRoot, failures, opts.label);
  const have = (await pathExists(destRoot)) ? await listTree(destRoot, failures, opts.label) : { files: [], dirs: [] };
  const wantFiles = new Set(want.files);
  const wantDirs = new Set(want.dirs);
  for (const rel of have.files) {
    if (wantFiles.has(rel)) continue;
    try {
      await fsp.rm(path.join(destRoot, rel), { force: true });
    } catch (err) {
      failures.push({ path: labelled(opts.label, rel), reason: `remove failed: ${reasonOf(err)}` });
    }
  }
  // Deepest first, and only folders the snapshot does not have; an emptied
  // one goes, one still holding a file that could not be removed stays.
  for (const rel of [...have.dirs].sort((a, b) => b.length - a.length)) {
    if (wantDirs.has(rel)) continue;
    await fsp.rmdir(path.join(destRoot, rel)).catch(() => {});
  }
  for (const rel of want.dirs) await fsp.mkdir(path.join(destRoot, rel), { recursive: true }).catch(() => {});
  await restoreTree(srcRoot, destRoot, failures, opts.label === undefined ? {} : { label: opts.label });
}

/** Every file and folder under `root`, relative. An unreadable folder is a failure, and is skipped. */
async function listTree(
  root: string,
  failures: RollbackFailure[],
  label: string | undefined,
): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      failures.push({ path: labelled(label, path.relative(root, dir)) || '.', reason: `readdir failed: ${reasonOf(err)}`, backup: dir });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        dirs.push(rel);
        await walk(full);
      } else {
        files.push(rel);
      }
    }
  };
  await walk(root);
  return { files, dirs };
}

function labelled(label: string | undefined, rel: string): string {
  if (!label) return rel;
  return rel ? path.join(label, rel) : label;
}
