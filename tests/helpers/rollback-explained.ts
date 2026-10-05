/**
 * What a rollback's report excuses, for the rollback contract (#267, #292).
 *
 * After a rollback, a vault path may differ from before only if the run's
 * `ROLLBACK_INCOMPLETE` failures account for it:
 * - a path a failure names (its `path`, or its `backup`);
 * - a folder on the way to a named path, as a folder, never its other contents;
 * - anything under a named folder: a rollback that could not read or restore
 *   a folder names the folder, not each file in it (#292). `.` is the vault
 *   itself.
 *
 * A folder that no failure names excuses nothing under it, so a difference
 * the rollback did not report stays a contract failure.
 */

import path from 'node:path';
import type { RollbackFailure } from '../../source/core/rollback-report.js';

/** Vault-relative POSIX, `.` for the vault itself. */
function posix(p: string): string {
  const joined = p.split(path.sep).join('/');
  return joined === '' ? '.' : joined;
}

export function explainedByReport(
  failures: readonly RollbackFailure[],
  vault: string,
  isFolder: (p: string) => boolean,
): (p: string) => boolean {
  const named = new Set<string>();
  const onTheWay = new Set<string>();
  for (const f of failures) {
    for (const p of [f.path, f.backup ? path.relative(vault, f.backup) : null]) {
      if (p === null) continue;
      const rel = posix(p);
      named.add(rel);
      const segments = rel.split('/');
      for (let i = 1; i < segments.length; i++) onTheWay.add(segments.slice(0, i).join('/'));
    }
  }
  const underNamedFolder = (p: string) =>
    [...named].some((n) => n === '.' || (isFolder(n) && p.startsWith(n + '/')));
  return (p) => named.has(p) || (onTheWay.has(p) && isFolder(p)) || underNamedFolder(p);
}
