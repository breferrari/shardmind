/**
 * Rename migrations (#178): a shard release that moves a file declares it in
 * `shard.yaml`, and an update carries the file — with the user's edits — to
 * its new path instead of removing the old one and adding the new one fresh.
 * See docs/SHARD-LAYOUT.md §Rename migrations.
 */

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
  if (await isFree(vaultRoot, to)) return;
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
): Promise<void> {
  try {
    await assertRenameTargetFree(vaultRoot, from, to, command);
  } catch (err) {
    const i = addedPaths.indexOf(to);
    if (i >= 0) addedPaths.splice(i, 1);
    throw err;
  }
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
 * another rename vacates in the same update counts as taken. Reads the disk,
 * writes nothing.
 */
export async function applyRenames(input: {
  vaultRoot: string;
  state: ShardState;
  drift: DriftReport;
  renames: ReadonlyMap<string, string>;
  newPaths: ReadonlySet<string>;
}): Promise<AppliedRenames> {
  const { vaultRoot, state, drift, renames, newPaths } = input;
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
  const free = await mapConcurrent(unique, 16, ([, to]) => isFree(vaultRoot, to));
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
