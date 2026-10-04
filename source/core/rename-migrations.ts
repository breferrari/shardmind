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
 * tracked, its new path is untracked, produced by the new shard, claimed by
 * no other rename, and free on disk; otherwise it is dropped and the update
 * removes and adds as it would without it. Reads the disk, writes nothing.
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
    ([from, to]) => state.files[from] !== undefined && state.files[to] === undefined && newPaths.has(to),
  );
  const claims = new Map<string, number>();
  for (const [, to] of candidates) claims.set(to, (claims.get(to) ?? 0) + 1);
  const unique = candidates.filter(([, to]) => claims.get(to) === 1);
  const free = await mapConcurrent(unique, 16, async ([, to]) =>
    fsp.lstat(path.join(vaultRoot, to)).then(() => false, () => true),
  );
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
  return {
    state: { ...state, files },
    drift: {
      managed: rekey(drift.managed),
      modified: rekey(drift.modified),
      volatile: rekey(drift.volatile),
      missing: rekey(drift.missing),
      orphaned: drift.orphaned,
    },
    movedFrom,
  };
}
