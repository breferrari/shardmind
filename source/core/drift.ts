/**
 * Ownership drift detection.
 *
 * `detectDrift` walks every file recorded in `state.files` and classifies it
 * by comparing the on-disk sha256 against the hash stored at install/update
 * time. See docs/IMPLEMENTATION.md §4.8.
 *
 * The output buckets are consumed by the update command to decide, per file,
 * whether to overwrite silently (`managed`), run a three-way merge
 * (`modified`), skip (`volatile`), re-render fresh (`missing`), or surface
 * for user attention (`orphaned`).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ShardState, DriftReport, DriftEntry } from '../runtime/types.js';
import { sha256 } from './fs-utils.js';

export async function detectDrift(
  vaultRoot: string,
  state: ShardState,
): Promise<DriftReport> {
  const managed: DriftEntry[] = [];
  const modified: DriftEntry[] = [];
  const volatile: DriftEntry[] = [];
  const missing: DriftEntry[] = [];

  for (const [relPath, file] of Object.entries(state.files)) {
    // FileState.ownership uses the literal 'user' for volatile files (what the
    // install engine writes to state.json); DriftEntry.ownership reports it as
    // 'volatile' because that is the reporting-layer vocabulary used by the
    // update command. Intentional naming gap, not a bug.
    if (file.ownership === 'user') {
      volatile.push({
        path: relPath,
        template: file.template,
        renderedHash: file.rendered_hash,
        actualHash: null,
        ownership: 'volatile',
      });
      continue;
    }

    const absPath = path.join(vaultRoot, relPath);
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) {
        missing.push({
          path: relPath,
          template: file.template,
          renderedHash: file.rendered_hash,
          actualHash: null,
          ownership: file.ownership === 'modified' ? 'modified' : 'managed',
        });
        continue;
      }
      throw err;
    }

    const actualHash = sha256(content);
    const entry: DriftEntry = {
      path: relPath,
      template: file.template,
      renderedHash: file.rendered_hash,
      actualHash,
      ownership: actualHash === file.rendered_hash ? 'managed' : 'modified',
    };

    if (entry.ownership === 'managed') {
      managed.push(entry);
    } else {
      modified.push(entry);
    }
  }

  // Orphan detection (files on disk under tracked paths but not in state) is
  // deferred to v0.2. "Tracked paths" is under-specified once _each iterators
  // have exploded one template into N per-item files, and no v0.1 flow needs
  // the information. See roadmap follow-up.
  const orphaned: string[] = [];

  return { managed, modified, volatile, missing, orphaned };
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
