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
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { ShardState, DriftReport, DriftEntry, FileState } from '../runtime/types.js';
import { sha256, mapConcurrent } from './fs-utils.js';
import { isEnoent } from '../runtime/errno.js';
import { SHARDMIND_DIR, VALUES_FILE, GIT_DIR, OBSIDIAN_DIR } from '../runtime/vault-paths.js';

type Bucket = 'managed' | 'modified' | 'volatile' | 'missing';
type Classified = { bucket: Bucket; entry: DriftEntry };

/**
 * Paths ShardMind owns but doesn't record in `state.files`. Excluded from
 * orphan detection because they're the engine's own scaffolding, not user
 * content.
 */
const ENGINE_RESERVED_FILES: ReadonlySet<string> = new Set([VALUES_FILE]);

/**
 * Top-level directory names that should never be treated as "tracked" for
 * orphan scanning. `.shardmind/` holds engine state; `.git/` and `.obsidian/`
 * are third-party metadata the shard never claims to manage. Applied when
 * deriving `trackedDirs` so we never readdir into one of these, even if the
 * shard misconfigures a tracked file under them.
 */
const UNSCANNED_DIR_NAMES: ReadonlySet<string> = new Set([
  SHARDMIND_DIR,
  GIT_DIR,
  OBSIDIAN_DIR,
]);

/**
 * Cap on concurrent file-read handles when hashing the vault. A small limit
 * keeps per-update work bounded below typical OS fd limits (macOS defaults
 * to ~256 without `ulimit -n`) while still saturating disk on realistic
 * vault sizes.
 */
const DRIFT_READ_CONCURRENCY = 32;

/**
 * Cap on concurrent `readdir` calls during orphan detection. Vaults that
 * track hundreds of files across hundreds of directories would otherwise
 * fan out one open-directory handle per tracked dir, reliably hitting
 * EMFILE on macOS's 256-handle default.
 */
const ORPHAN_SCAN_CONCURRENCY = 32;

export async function detectDrift(
  vaultRoot: string,
  state: ShardState,
): Promise<DriftReport> {
  // Normalize to forward slashes so downstream lookups are separator-
  // independent. State-file keys are written via `toPosix()` at install
  // time, but defensive normalization guards any caller that writes state
  // with native separators.
  const trackedPaths: ReadonlySet<string> = new Set(
    Object.keys(state.files).map(toPosix),
  );

  const [classified, orphaned] = await Promise.all([
    mapConcurrent(
      Object.entries(state.files),
      DRIFT_READ_CONCURRENCY,
      ([relPath, file]) => classifyFile(vaultRoot, relPath, file),
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
    // Read as Buffer so the hash matches install time for ANY content —
    // copy-origin files (images, PDFs, binary assets) are hashed as bytes
    // by install-executor, and reading them as utf-8 here would replace
    // invalid sequences with U+FFFD and produce a different sha256 every
    // run. Both `sha256` and `update(buf)` accept Buffer, so rendered
    // text files produce the same hash whether read as Buffer or utf-8.
    const content = await fsp.readFile(path.join(vaultRoot, relPath));
    return classifyByHash(relPath, file, content);
  } catch (err) {
    if (isEnoent(err)) {
      return { bucket: 'missing', entry: missingEntry(relPath, file) };
    }
    throw err;
  }
}

function classifyByHash(relPath: string, file: FileState, content: Buffer): Classified {
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
    const dir = path.posix.dirname(relPath);
    const normalizedDir = dir === '.' ? '' : dir;
    // Never scan directories under an engine-reserved or third-party
    // namespace, even if the shard somehow tracks a file inside one.
    const topSegment = normalizedDir.split('/')[0] ?? '';
    if (topSegment && UNSCANNED_DIR_NAMES.has(topSegment)) continue;
    trackedDirs.add(normalizedDir);
  }

  const perDir = await mapConcurrent(
    [...trackedDirs],
    ORPHAN_SCAN_CONCURRENCY,
    relDir => scanDirForOrphans(vaultRoot, relDir, trackedPaths),
  );

  return perDir.flat().sort();
}

async function scanDirForOrphans(
  vaultRoot: string,
  relDir: string,
  trackedPaths: ReadonlySet<string>,
): Promise<string[]> {
  const absDir = path.join(vaultRoot, relDir);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const orphans: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (trackedPaths.has(rel)) continue;
    if (ENGINE_RESERVED_FILES.has(rel)) continue;
    orphans.push(rel);
  }
  return orphans;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

