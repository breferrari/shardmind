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
import type { ShardState, DriftReport, DriftEntry, FileState } from '../runtime/types.js';
import { sha256 } from './fs-utils.js';
import { isEnoent } from '../runtime/errno.js';
import { SHARDMIND_DIR, VALUES_FILE } from '../runtime/vault-paths.js';

type Bucket = 'managed' | 'modified' | 'volatile' | 'missing';
type Classified = { bucket: Bucket; entry: DriftEntry };

/**
 * Paths ShardMind owns but doesn't record in `state.files`. Excluded from
 * orphan detection because they're the engine's own scaffolding, not user
 * content.
 */
const ENGINE_RESERVED_FILES: ReadonlySet<string> = new Set([VALUES_FILE]);

/**
 * Directory names that are never scanned for orphans. `.shardmind/` holds
 * engine state; `.git/` and `.obsidian/` are third-party metadata the shard
 * never claims to manage.
 */
const UNSCANNED_DIRS: ReadonlySet<string> = new Set([SHARDMIND_DIR, '.git', '.obsidian']);

export async function detectDrift(
  vaultRoot: string,
  state: ShardState,
): Promise<DriftReport> {
  const trackedPaths = new Set(Object.keys(state.files));

  const [classified, orphaned] = await Promise.all([
    Promise.all(
      Object.entries(state.files).map(([relPath, file]) =>
        classifyFile(vaultRoot, relPath, file),
      ),
    ),
    detectOrphans(vaultRoot, trackedPaths),
  ]);

  const managed: DriftEntry[] = [];
  const modified: DriftEntry[] = [];
  const volatile: DriftEntry[] = [];
  const missing: DriftEntry[] = [];
  const byBucket = { managed, modified, volatile, missing };

  for (const { bucket, entry } of classified) {
    byBucket[bucket].push(entry);
  }

  return { managed, modified, volatile, missing, orphaned };
}

async function classifyFile(
  vaultRoot: string,
  relPath: string,
  file: FileState,
): Promise<Classified> {
  // FileState.ownership uses the literal 'user' for volatile files (what the
  // install engine writes to state.json); DriftEntry.ownership reports it as
  // 'volatile' because that is the reporting-layer vocabulary used by the
  // update command. Intentional naming gap, not a bug.
  if (file.ownership === 'user') {
    return { bucket: 'volatile', entry: volatileEntry(relPath, file) };
  }

  try {
    const content = await fsp.readFile(path.join(vaultRoot, relPath), 'utf-8');
    return classifyByHash(relPath, file, content);
  } catch (err) {
    if (isEnoent(err)) {
      return { bucket: 'missing', entry: missingEntry(relPath, file) };
    }
    throw err;
  }
}

function classifyByHash(relPath: string, file: FileState, content: string): Classified {
  const actualHash = sha256(content);
  const ownership = actualHash === file.rendered_hash ? 'managed' : 'modified';
  return {
    bucket: ownership,
    entry: {
      path: relPath,
      template: file.template,
      renderedHash: file.rendered_hash,
      actualHash,
      ownership,
    },
  };
}

function volatileEntry(relPath: string, file: FileState): DriftEntry {
  return {
    path: relPath,
    template: file.template,
    renderedHash: file.rendered_hash,
    actualHash: null,
    ownership: 'volatile',
  };
}

function missingEntry(relPath: string, file: FileState): DriftEntry {
  return {
    path: relPath,
    template: file.template,
    renderedHash: file.rendered_hash,
    actualHash: null,
    ownership: file.ownership === 'modified' ? 'modified' : 'managed',
  };
}

/**
 * A file is orphaned when it sits in a directory that contains at least one
 * state-tracked file, yet isn't itself in state.files. Non-recursive: a
 * subdirectory only counts as tracked if it directly holds a tracked file.
 *
 * Example: if `skills/leadership.md` is tracked, then `skills/` is a tracked
 * directory; a user-created `skills/my-extra.md` is an orphan. But
 * `brain/daily/2026-04-19.md` (under an untracked sub-directory) is user
 * content that ShardMind never claimed — not an orphan.
 *
 * Engine scaffolding (`.shardmind/`, `shard-values.yaml`) and third-party
 * metadata (`.git/`, `.obsidian/`) are excluded.
 */
async function detectOrphans(
  vaultRoot: string,
  trackedPaths: ReadonlySet<string>,
): Promise<string[]> {
  const trackedDirs = new Set<string>();
  for (const relPath of trackedPaths) {
    const dir = path.posix.dirname(toPosixPath(relPath));
    trackedDirs.add(dir === '.' ? '' : dir);
  }

  const perDir = await Promise.all(
    [...trackedDirs].map(relDir => scanDirForOrphans(vaultRoot, relDir, trackedPaths)),
  );

  return perDir.flat().sort();
}

async function scanDirForOrphans(
  vaultRoot: string,
  relDir: string,
  trackedPaths: ReadonlySet<string>,
): Promise<string[]> {
  const absDir = path.join(vaultRoot, relDir);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const orphans: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (UNSCANNED_DIRS.has(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (trackedPaths.has(rel)) continue;
    if (ENGINE_RESERVED_FILES.has(rel)) continue;
    orphans.push(rel);
  }
  return orphans;
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
