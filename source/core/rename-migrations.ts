/**
 * Rename migrations (#178): a shard release that moves a file declares it in
 * `shard.yaml`, and an update carries the file — with the user's edits — to
 * its new path instead of removing the old one and adding the new one fresh.
 * See docs/SHARD-LAYOUT.md §Rename migrations.
 */

import semver from 'semver';
import type { RenameMigration } from '../runtime/types.js';

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
