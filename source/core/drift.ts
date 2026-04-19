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
import { isEnoent } from '../runtime/errno.js';

export async function detectDrift(
  vaultRoot: string,
  state: ShardState,
): Promise<DriftReport> {
  const managed: DriftEntry[] = [];
  const modified: DriftEntry[] = [];
  const volatile: DriftEntry[] = [];
  const missing: DriftEntry[] = [];

  const entries = await Promise.all(
    Object.entries(state.files).map(async ([relPath, file]) => {
      // FileState.ownership uses the literal 'user' for volatile files (what
      // the install engine writes to state.json); DriftEntry.ownership reports
      // it as 'volatile' because that is the reporting-layer vocabulary used
      // by the update command. Intentional naming gap, not a bug.
      if (file.ownership === 'user') {
        return { bucket: 'volatile' as const, entry: volatileEntry(relPath, file) };
      }

      const absPath = path.join(vaultRoot, relPath);
      try {
        const content = await fsp.readFile(absPath, 'utf-8');
        return { bucket: 'hashed' as const, entry: hashedEntry(relPath, file, content) };
      } catch (err) {
        if (isEnoent(err)) {
          return { bucket: 'missing' as const, entry: missingEntry(relPath, file) };
        }
        throw err;
      }
    }),
  );

  for (const { bucket, entry } of entries) {
    if (bucket === 'volatile') volatile.push(entry);
    else if (bucket === 'missing') missing.push(entry);
    else if (entry.ownership === 'managed') managed.push(entry);
    else modified.push(entry);
  }

  // Orphan detection (files on disk under tracked paths but not in state) is
  // deferred to v0.2. "Tracked paths" is under-specified once _each iterators
  // have exploded one template into N per-item files, and no v0.1 flow needs
  // the information. See #47.
  const orphaned: string[] = [];

  return { managed, modified, volatile, missing, orphaned };
}

function volatileEntry(relPath: string, file: ShardState['files'][string]): DriftEntry {
  return {
    path: relPath,
    template: file.template,
    renderedHash: file.rendered_hash,
    actualHash: null,
    ownership: 'volatile',
  };
}

function missingEntry(relPath: string, file: ShardState['files'][string]): DriftEntry {
  return {
    path: relPath,
    template: file.template,
    renderedHash: file.rendered_hash,
    actualHash: null,
    ownership: file.ownership === 'modified' ? 'modified' : 'managed',
  };
}

function hashedEntry(
  relPath: string,
  file: ShardState['files'][string],
  content: string,
): DriftEntry {
  const actualHash = sha256(content);
  return {
    path: relPath,
    template: file.template,
    renderedHash: file.rendered_hash,
    actualHash,
    ownership: actualHash === file.rendered_hash ? 'managed' : 'modified',
  };
}
