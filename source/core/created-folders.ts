/**
 * The folders a run created, so its rollback removes them and nothing else
 * (#258). One mechanism for install, update and adopt, replacing install's
 * own tracker (#215) and update's (#195).
 *
 * A run lists, before its first write, the folders on the way to every path
 * it will write that do not exist yet. Only ENOENT counts as missing: a
 * folder `lstat` cannot read for another reason (EACCES, a Windows lock)
 * exists, and is never the run's to remove. On a case-folding filesystem a
 * folder under another spelling exists too. The rollback removes those
 * folders deepest first, and only when empty: a folder holding the user's
 * files stays.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { reasonOf, type RollbackFailure } from './rollback-report.js';

/** Where a run that keeps a snapshot (update, adopt) records its list. */
const FOLDERS_FILE = 'folders.json';

/**
 * The folders on the way to `paths` (vault-relative, either separator), and
 * every folder of `opts.folders` itself, that do not exist: POSIX, sorted,
 * so a parent comes before its children. Once one folder is missing, those
 * under it are too.
 */
export async function missingFolders(
  vaultRoot: string,
  paths: readonly string[],
  opts: { folders?: readonly string[]; seen?: Map<string, boolean> } = {},
): Promise<string[]> {
  // A path that would leave the vault is never the run's to create or
  // remove; the writes themselves are refused by the vault path guard.
  const chains = [
    ...paths.map((rel) => segmentsOf(rel).slice(0, -1)),
    ...(opts.folders ?? []).map(segmentsOf),
  ].filter((segments) => !segments.includes('..'));
  // `seen` carries the answers across calls in one run (install asks per
  // write): a folder judged existing or missing at its first sight keeps
  // that answer, so one the run created is never reported twice, and one
  // that existed is never reported as created even if it vanishes mid-run.
  const seen = opts.seen ?? new Map<string, boolean>();
  const missing: string[] = [];
  for (const segments of chains) {
    let current = '';
    let parentMissing = false;
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      let isMissing = seen.get(current);
      if (isMissing === undefined) {
        isMissing = parentMissing || (await isMissingFolder(path.join(vaultRoot, current)));
        seen.set(current, isMissing);
        if (isMissing) missing.push(current);
      }
      parentMissing = isMissing;
    }
  }
  return missing.sort();
}

/**
 * Keep the list in the run's snapshot folder, for its rollback. Written
 * whole through a temporary file, so a crash or a full disk never leaves a
 * half-written record.
 */
export async function recordCreatedFolders(backupDir: string, folders: readonly string[]): Promise<void> {
  const record = path.join(backupDir, FOLDERS_FILE);
  await fsp.writeFile(`${record}.tmp`, JSON.stringify(folders), 'utf-8');
  await fsp.rename(`${record}.tmp`, record);
}

/** Where `recordCreatedFolders` keeps the list, for a failure that names it. */
export function createdFoldersRecord(backupDir: string): string {
  return path.join(backupDir, FOLDERS_FILE);
}

/**
 * A snapshotted run's rollback step: remove the folders it recorded, once
 * empty. When the record cannot be read or is not a list, `recorded` (the
 * list the run wrote, still in its memory) is used instead (#295). Only
 * with neither is it a failure, naming the record itself (`recordPath`,
 * vault-relative), never silence.
 */
export async function rollbackCreatedFolders(
  vaultRoot: string,
  backupDir: string,
  recordPath: string,
  recorded?: readonly string[],
): Promise<RollbackFailure[]> {
  let folders: readonly string[];
  try {
    folders = await readCreatedFolders(backupDir);
  } catch (err) {
    if (recorded === undefined) return [{ path: recordPath, reason: `folder record unreadable: ${reasonOf(err)}` }];
    folders = recorded;
  }
  return removeCreatedFolders(vaultRoot, folders);
}

/** The recorded list; none when nothing was recorded. An unreadable record throws. */
export async function readCreatedFolders(backupDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(backupDir, FOLDERS_FILE), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((f) => typeof f === 'string')) {
    throw new Error(`${FOLDERS_FILE} is not a list of folders`);
  }
  return parsed;
}

/**
 * Remove each folder the run created that is empty again, deepest first.
 * One that holds files (the user's) or is already gone stays and is not a
 * failure; any other refusal is returned.
 */
export async function removeCreatedFolders(vaultRoot: string, folders: readonly string[]): Promise<RollbackFailure[]> {
  const failures: RollbackFailure[] = [];
  // An entry that would leave the vault (a hand-edited record) is skipped.
  const inside = folders.map(segmentsOf).filter((segments) => segments.length > 0 && !segments.includes('..'));
  const deepestFirst = [...new Set(inside.map((segments) => segments.join('/')))].sort((a, b) => depth(b) - depth(a));
  for (const rel of deepestFirst) {
    try {
      await fsp.rmdir(path.join(vaultRoot, rel));
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') continue;
      failures.push({ path: rel, reason: `remove failed: ${reasonOf(err)}` });
    }
  }
  return failures;
}

async function isMissingFolder(absolute: string): Promise<boolean> {
  try {
    await fsp.lstat(absolute);
    return false;
  } catch (err) {
    return isEnoent(err);
  }
}

function segmentsOf(rel: string): string[] {
  // An absolute path keeps a leading empty or drive segment out, but is
  // never inside the vault: marked with '..' so it is filtered.
  if (path.isAbsolute(rel)) return ['..'];
  return rel.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
}

function depth(rel: string): number {
  return rel.split('/').length;
}
