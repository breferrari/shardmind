/**
 * Rename migrations (#178): a shard release that moves a file declares it in
 * `shard.yaml`, and an update carries the file — with the user's edits — to
 * its new path instead of removing the old one and adding the new one fresh.
 * See docs/SHARD-LAYOUT.md §Rename migrations.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import type { DriftEntry, DriftReport, RenameMigration, ShardState } from '../runtime/types.js';
import { mapConcurrent } from './fs-utils.js';
import { isEnoent } from '../runtime/errno.js';
import { ShardMindError } from '../runtime/types.js';

/**
 * Old path → new path for an update from `installed` to `target`. A
 * migration applies when `installed < to <= target`; migrations chain in
 * `to` order, so a→b then b→c gives a→c. Every old path any applicable
 * migration names is a key, including one that only exists after an
 * earlier rename (b→c above): which of them are tracked, and clashes
 * between them, are settled by `applyRenames`. A chain that returns to
 * its start is dropped.
 */
export function renamesBetween(
  migrations: readonly RenameMigration[] | undefined,
  installed: string,
  target: string,
): Map<string, string> {
  const steps = (migrations ?? [])
    .filter((m) => semver.gt(m.to, installed) && semver.lte(m.to, target))
    .sort((a, b) => semver.compare(a.to, b.to));
  const result = new Map<string, string>();
  steps.forEach((step, i) => {
    for (const start of Object.keys(step.renames)) {
      if (result.has(start)) continue;
      let current = start;
      for (const later of steps.slice(i)) current = later.renames[current] ?? current;
      if (current !== start) result.set(start, current);
    }
  });
  return result;
}

/** A name as a case-folding filesystem compares it. */
const fold = (rel: string): string => rel.normalize('NFC').toLowerCase();

/**
 * Old path → new path for each change of a file name's case alone (#169),
 * which needs no `migrations` entry: a tracked path the new shard no longer
 * ships, and an untracked new path in the same folder that equals it
 * ignoring case. Paired only when unambiguous: no other tracked or shipped
 * path folds to the same name, and no declared rename names either side.
 * Folders on the way may change case too, as a whole (`dropSplitFolders`,
 * #195).
 */
export function caseOnlyRenames(
  tracked: Iterable<string>,
  newPaths: ReadonlySet<string>,
  declared: ReadonlyMap<string, string>,
): Map<string, string> {
  const trackedSet = new Set(tracked);
  const groups = new Map<string, Set<string>>();
  for (const rel of [...trackedSet, ...newPaths]) {
    const key = fold(rel);
    const group = groups.get(key) ?? new Set<string>();
    group.add(rel);
    groups.set(key, group);
  }
  const declaredTargets = new Set(declared.values());
  const result = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.size !== 2) continue;
    const from = [...group].find((p) => trackedSet.has(p) && !newPaths.has(p));
    const to = [...group].find((p) => newPaths.has(p) && !trackedSet.has(p));
    if (from === undefined || to === undefined || !isCaseOnlyRename(from, to)) continue;
    if (declared.has(from) || declaredTargets.has(to)) continue;
    result.set(from, to);
  }
  return dropSplitFolders(result, newPaths);
}

/**
 * Two paths that differ only in case (or Unicode normalization), in the file
 * name (#169) or in any folder on the way (#195).
 */
export function isCaseOnlyRename(from: string, to: string): boolean {
  return from !== to && fold(from) === fold(to);
}

/**
 * The folders a case-only pair renames, shallowest first: each folder prefix
 * whose last segment's spelling differs, old spelling → new (#195).
 */
export function folderChanges(from: string, to: string): Array<{ from: string; to: string }> {
  const a = from.split('/');
  const b = to.split('/');
  const out: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] !== b[i]) out.push({ from: a.slice(0, i + 1).join('/'), to: b.slice(0, i + 1).join('/') });
  }
  return out;
}

/**
 * A folder whose case a pair changes moves whole or not at all (#195): every
 * pair under an old folder spelling is dropped when that spelling maps to two
 * new ones, or when a shipped path keeps the old spelling or a third one.
 */
function dropSplitFolders(pairs: Map<string, string>, newPaths: ReadonlySet<string>): Map<string, string> {
  const spellings = new Map<string, Set<string>>();
  for (const [from, to] of pairs) {
    for (const change of folderChanges(from, to)) {
      const set = spellings.get(change.from) ?? new Set<string>();
      set.add(change.to);
      spellings.set(change.from, set);
    }
  }
  const split = new Set<string>();
  for (const [old, news] of spellings) {
    const [only] = news;
    if (news.size > 1 || only === undefined) {
      split.add(old);
      continue;
    }
    const depth = old.split('/').length;
    for (const shipped of newPaths) {
      const segments = shipped.split('/');
      if (segments.length <= depth) continue;
      const prefix = segments.slice(0, depth).join('/');
      if (prefix !== only && fold(prefix) === fold(old)) {
        split.add(old);
        break;
      }
    }
  }
  if (split.size === 0) return pairs;
  return new Map([...pairs].filter(([from, to]) => !folderChanges(from, to).some((c) => split.has(c.from))));
}

/**
 * Whether two paths of a case-only pair reach one file or folder, one
 * spelling folded onto the other. Decided segment by segment from the folder
 * listings: where the spellings differ, a parent that lists both holds two
 * entries; one that lists one holds one entry under both names. A listing
 * that spells neither as given (a third Unicode normalization) falls back to
 * the file index, as `bigint` (an NTFS index exceeds 2^53) and never 0, which
 * FAT and some network filesystems report for every file.
 */
export async function sameFile(vaultRoot: string, a: string, b: string): Promise<boolean> {
  const stat = (rel: string) => fsp.lstat(path.join(vaultRoot, rel), { bigint: true }).catch(() => null);
  const [x, y] = await Promise.all([stat(a), stat(b)]);
  if (x === null || y === null) return false;
  const sa = a.split('/');
  const sb = b.split('/');
  if (sa.length !== sb.length) return false;
  let undecided = false;
  for (let i = 0; i < sa.length; i++) {
    const nameA = sa[i]!;
    const nameB = sb[i]!;
    if (nameA === nameB) continue;
    const names = await fsp.readdir(path.join(vaultRoot, ...sa.slice(0, i))).catch(() => null);
    const hasA = names?.includes(nameA) ?? false;
    const hasB = names?.includes(nameB) ?? false;
    if (hasA && hasB) return false;
    if (!hasA && !hasB) undecided = true;
  }
  return !undecided || (x.ino !== 0n && x.dev === y.dev && x.ino === y.ino);
}

/**
 * Whether `from` can move to `to`: `to` is free, or the move only changes the
 * name's case and `to` already reaches `from`'s file, as on a case-folding
 * filesystem (#169).
 */
export async function isFreeFor(vaultRoot: string, from: string, to: string): Promise<boolean> {
  if (await isFree(vaultRoot, to)) return true;
  return isCaseOnlyRename(from, to) && sameFile(vaultRoot, from, to);
}

/** One in-place case rename, recorded before it starts so a rollback can undo it. */
export interface CaseHop {
  from: string;
  to: string;
  /** The temporary name between the two renames. */
  tmp: string;
}

/** Records a hop before it starts (`<backupDir>/case-renames.json`, see `caseJournal`). */
export type CaseJournal = (hop: CaseHop) => Promise<void>;

/**
 * Give `from`'s file or folder the spelling `to` when both reach the same
 * entry (a case-only rename on a case-folding filesystem, #169, #195):
 * through a temporary name beside it, since some filesystems ignore a rename
 * to a name they fold to the same one. The hop is journaled before the first
 * rename, and for a file the temporary path also joins `addedPaths`, so a
 * rollback after a failure between the two puts the old name back. Returns
 * false, having done nothing, when the two are not the same entry.
 */
export async function renameCaseInPlace(
  vaultRoot: string,
  from: string,
  to: string,
  addedPaths: string[] | null,
  journal?: CaseJournal,
): Promise<boolean> {
  if (!isCaseOnlyRename(from, to) || !(await sameFile(vaultRoot, from, to))) return false;
  const tmp = path.posix.join(
    path.posix.dirname(to),
    `.${path.posix.basename(to)}.shardmind-case-${crypto.randomBytes(4).toString('hex')}`,
  );
  await journal?.({ from, to, tmp });
  addedPaths?.push(tmp);
  await fsp.rename(path.join(vaultRoot, from), path.join(vaultRoot, tmp));
  await fsp.rename(path.join(vaultRoot, tmp), path.join(vaultRoot, to));
  if (addedPaths) addedPaths.splice(addedPaths.indexOf(tmp), 1);
  return true;
}

const CASE_JOURNAL = 'case-renames.json';

/** A journal that appends each hop to `<backupDir>/case-renames.json`. */
export function caseJournal(backupDir: string): CaseJournal {
  const hops: CaseHop[] = [];
  return async (hop) => {
    hops.push(hop);
    await fsp.writeFile(path.join(backupDir, CASE_JOURNAL), JSON.stringify(hops), 'utf-8');
  };
}

/**
 * Undo the journaled hops in `backupDir`, newest first: a hop stopped at its
 * temporary name goes back to the old name; a finished one is renamed back
 * in place. Returns the hops it could not undo, with why.
 */
export async function undoCaseHops(
  vaultRoot: string,
  backupDir: string,
): Promise<Array<{ path: string; reason: string }>> {
  let hops: CaseHop[];
  try {
    hops = JSON.parse(await fsp.readFile(path.join(backupDir, CASE_JOURNAL), 'utf-8')) as CaseHop[];
  } catch {
    return [];
  }
  const failures: Array<{ path: string; reason: string }> = [];
  for (const hop of [...hops].reverse()) {
    try {
      const tmpAbs = path.join(vaultRoot, hop.tmp);
      const atTmp = await fsp.lstat(tmpAbs).then(() => true, () => false);
      if (atTmp) await fsp.rename(tmpAbs, path.join(vaultRoot, hop.from));
      else await renameCaseInPlace(vaultRoot, hop.to, hop.from, null);
    } catch (err) {
      failures.push({ path: hop.from, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return failures;
}

/**
 * Nothing at `rel`, and every existing folder on its way is a folder. Windows
 * reports ENOENT, not ENOTDIR, for a path under a regular file, so the
 * ancestors are checked too. Any other error counts as taken.
 */
export async function isFree(vaultRoot: string, rel: string): Promise<boolean> {
  const segments = rel.split('/');
  for (let i = 1; i < segments.length; i++) {
    const ancestor = path.join(vaultRoot, ...segments.slice(0, i));
    const st = await fsp.lstat(ancestor).catch((err: unknown) => (isEnoent(err) ? null : undefined));
    if (st === undefined) return false;
    if (st === null) return true;
    if (!st.isDirectory()) return false;
  }
  return fsp.lstat(path.join(vaultRoot, rel)).then(() => false, (err: unknown) => isEnoent(err));
}

/**
 * `adopt --from-version <v>` (#179): the release a vault was cloned from,
 * refused unless it is semver. Checked before the shard is fetched.
 */
export function parseFromVersion(value: string): string {
  const version = semver.valid(value);
  if (version !== null) return version;
  throw new ShardMindError(
    `--from-version is not a version: '${value}'`,
    'ADOPT_FROM_VERSION_INVALID',
    "Pass the release the vault was cloned from as MAJOR.MINOR.PATCH (e.g. --from-version 5.1.0), as in that release's shard.yaml.",
  );
}

/** The command that moves a file, for the error it refuses with. */
export type MovingCommand = 'update' | 'adopt';

/**
 * Refuse a rename into a path something now occupies (`isFree`), arrived
 * after the command planned it: refused before any write, and again before
 * the move itself.
 */
export async function assertRenameTargetFree(
  vaultRoot: string,
  from: string,
  to: string,
  command: MovingCommand,
): Promise<void> {
  if (await isFreeFor(vaultRoot, from, to)) return;
  throw new ShardMindError(
    `'${to}' is no longer free: '${from}' was to move there`,
    command === 'update' ? 'UPDATE_WRITE_FAILED' : 'ADOPT_WRITE_FAILED',
    `Something was created at '${to}' after the ${command} was planned. Move or remove it, then run \`shardmind ${command}\` again.`,
  );
}

/**
 * Move the user's file from `from` to `to`, which the command registered in
 * `addedPaths` before writing. Something that arrived at `to` meanwhile is
 * never moved over, and leaves `addedPaths` so a rollback keeps it. A
 * missing `from` (a volatile file the user deleted) has nothing to move.
 */
export async function moveToFreePath(
  vaultRoot: string,
  from: string,
  to: string,
  addedPaths: string[],
  command: MovingCommand,
  journal?: CaseJournal,
): Promise<void> {
  try {
    await assertRenameTargetFree(vaultRoot, from, to, command);
  } catch (err) {
    const i = addedPaths.indexOf(to);
    if (i >= 0) addedPaths.splice(i, 1);
    throw err;
  }
  if (await renameCaseInPlace(vaultRoot, from, to, addedPaths, journal)) return;
  const toAbs = path.join(vaultRoot, to);
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await fsp.rename(path.join(vaultRoot, from), toAbs);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export interface AppliedRenames {
  /** `state.files` keyed by each renamed file's new path. */
  state: ShardState;
  /** Drift entries keyed the same way; `orphaned` is unchanged. */
  drift: DriftReport;
  /** New path → old path, for each rename that applies. */
  movedFrom: Map<string, string>;
}

/**
 * Re-key the state and drift an update plans from, so each renamed file is
 * planned at its new path (#178). A rename applies only when its old path is
 * tracked and no longer shipped, its new path is untracked, produced by the
 * new shard, claimed by no other rename, and free on disk; otherwise it is
 * dropped and the update removes and adds as it would without it. A new path
 * another rename vacates in the same update counts as taken. Case-only
 * changes of a path join the declared renames (`caseOnlyRenames`, #169, #195),
 * and a case-only new path that reaches its old file counts as free
 * (`isFreeFor`). Reads the disk, writes nothing.
 */
export async function applyRenames(input: {
  vaultRoot: string;
  state: ShardState;
  drift: DriftReport;
  renames: ReadonlyMap<string, string>;
  newPaths: ReadonlySet<string>;
}): Promise<AppliedRenames> {
  const { vaultRoot, state, drift, newPaths } = input;
  const renames = new Map([
    ...input.renames,
    ...caseOnlyRenames(Object.keys(state.files), newPaths, input.renames),
  ]);
  const candidates = [...renames].filter(
    ([from, to]) =>
      state.files[from] !== undefined &&
      state.files[to] === undefined &&
      newPaths.has(to) &&
      // A shard that still ships the old path did not move it.
      !newPaths.has(from),
  );
  const claims = new Map<string, number>();
  for (const [, to] of candidates) claims.set(to, (claims.get(to) ?? 0) + 1);
  const unique = candidates.filter(([, to]) => claims.get(to) === 1);
  // Free means nothing there at all; any other error (a file where a
  // folder should be, no access) keeps the old behaviour.
  const free = await mapConcurrent(unique, 16, ([from, to]) => isFreeFor(vaultRoot, from, to));
  const newOf = new Map(unique.filter((_, i) => free[i]));
  const movedFrom = new Map([...newOf].map(([from, to]) => [to, from]));
  if (movedFrom.size === 0) return { state, drift, movedFrom };

  const files: ShardState['files'] = {};
  for (const [rel, entry] of Object.entries(state.files)) files[newOf.get(rel) ?? rel] = entry;
  const rekey = (entries: DriftEntry[]) =>
    entries.map((e) => {
      const to = newOf.get(e.path);
      return to === undefined ? e : { ...e, path: to };
    });
  const { orphaned, ...tracked } = drift;
  const rekeyed = Object.fromEntries(
    Object.entries(tracked).map(([kind, entries]) => [kind, rekey(entries)]),
  ) as Omit<DriftReport, 'orphaned'>;
  return { state: { ...state, files }, drift: { ...rekeyed, orphaned }, movedFrom };
}
