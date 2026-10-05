/**
 * Keep a coverage run's subprocess coverage small (#293). Each process under
 * `NODE_V8_COVERAGE` writes everything it loaded, node_modules included:
 * about 3 MB for one CLI run, of which about 0.1 MB is `dist/`. The spawn
 * helpers call this when a CLI exits, so the directory holds only what the
 * provider reads.
 *
 * It sweeps the whole directory, not just the exited CLI's file, because the
 * CLI's own children (the hook runner, the self-update refresh) write theirs
 * under their own pids. A file it has compacted is renamed `dist-<name>` and
 * skipped from then on; one with no `dist/` entries is deleted. A file that
 * does not parse is still being written and is left for the next sweep, or
 * for the provider.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DIST_URL_PREFIX, readDistEntries, SUBPROCESS_COVERAGE_DIR } from './coverage-run.js';

export const COMPACTED_PREFIX = 'dist-';

export type CompactOptions = {
  /** The directory the spawned processes write to: by default `NODE_V8_COVERAGE`; null for none. */
  dir?: string | null;
  /** The only directory this may change: the coverage run's own. */
  ownDir?: string;
  distPrefix?: string;
};

/**
 * Compact every raw coverage file in the coverage run's directory. A no-op
 * outside a coverage run, and when `NODE_V8_COVERAGE` names any other
 * directory: a caller's own coverage tool (c8, a hand-set variable) keeps
 * every file it wrote.
 */
export function compactSubprocessCoverage(opts: CompactOptions = {}): void {
  const { ownDir = SUBPROCESS_COVERAGE_DIR, distPrefix = DIST_URL_PREFIX } = opts;
  const dir = 'dir' in opts ? opts.dir : process.env['NODE_V8_COVERAGE'];
  if (!dir || path.resolve(dir) !== path.resolve(ownDir)) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith(COMPACTED_PREFIX)) continue;
    const file = path.join(dir, name);
    const dist = readDistEntries(file, distPrefix);
    if (dist === undefined) continue;
    try {
      if (dist.length === 0) {
        fs.rmSync(file, { force: true });
        continue;
      }
      // Written aside, then renamed over: another worker's sweep may be
      // compacting the same file, and neither may leave it half-written.
      const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ result: dist }));
      fs.renameSync(tmp, path.join(dir, `${COMPACTED_PREFIX}${name}`));
      fs.rmSync(file, { force: true });
    } catch {
      // Another sweep got there first.
    }
  }
}
