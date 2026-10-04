/**
 * Hook write-boundary detection (detect-and-warn).
 *
 * The hook lifecycle split (#102) gives each slot a write boundary the engine
 * checks but does NOT prevent — a hook is an ordinary Node subprocess with full
 * filesystem access, so true sandboxing is out of scope. Instead the engine
 * snapshots before each boundary-checked slot and diffs after, surfacing a
 * non-fatal warning (Helm-style) when a hook wrote outside its lane. The bytes
 * are left in place; the warning tells the author the work belongs in a
 * different slot.
 *
 *  - `bootstrap` may write only unmanaged paths. A managed file it changed is
 *    detected via the post-hook re-hash (`rehashManagedFiles().changed`) — see
 *    `detectManagedWrites`. The pre-hook hashes come from the orchestrator's
 *    snapshot, not `state.files`: a file the user edited before the hook
 *    phase differs from its recorded hash without any hook writing it (#150).
 *  - `personalize` may write only managed files. An unmanaged file it created is
 *    detected via a path-only vault walk before and after the hook — see
 *    `snapshotUnmanaged` + `detectUnmanagedCreates`. Install/adopt only (the
 *    recurring update path never runs `personalize`), so the twice-walk happens
 *    at most once per vault per shard.
 *
 * Pure of Ink/React. Reuses `tier1.ts`, `.shardmindignore`, and `fs-utils`.
 * Spec: docs/SHARD-LAYOUT.md §Hook lifecycle; docs/IMPLEMENTATION.md §4.16b.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HookSlot, ShardState } from '../runtime/types.js';
import type { IgnoreFilter } from './shardmindignore.js';
import { isTier1Excluded } from './tier1.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';

/**
 * `incomplete`: the personalize walk could not read some folders and found no
 * created file; `paths` names the folders.
 */
export type HookViolationKind = 'managed-write' | 'unmanaged-create' | 'incomplete';

export interface HookViolation {
  slot: HookSlot;
  kind: HookViolationKind;
  /** Vault-relative posix paths the hook touched outside its boundary. */
  paths: string[];
  /**
   * Folders the personalize walk could not read, set on `unmanaged-create`
   * when the walk was also incomplete ('.' = the vault root).
   */
  unreadable?: string[];
}

/** One path-only walk of the vault: what it saw, and the folders it could not read. */
export interface UnmanagedSnapshot {
  paths: Set<string>;
  /** Vault-relative posix folders the walk could not read ('.' = the vault root). */
  unreadable: string[];
}

/** Errors a scanner or indexer holding a folder can cause, worth a second read. */
const TRANSIENT_READDIR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const READDIR_RETRY_MS = 50;

/**
 * Vault-relative posix paths present in the vault, ignore-filtered and
 * Tier-1-filtered, with symlinks skipped (not followed — the vault is user
 * territory and a symlink loop/escape must not wedge the walk). Path-only: no
 * content is read. Taken right before and right after `personalize` to detect
 * files it created.
 *
 * A folder that cannot be read is recorded in `unreadable`, never read as
 * empty: an empty read would make the check report that nothing was created
 * (#175). A vanished folder (`ENOENT`) is empty.
 */
export async function snapshotUnmanaged(
  vaultRoot: string,
  ignore: IgnoreFilter,
): Promise<UnmanagedSnapshot> {
  const out: UnmanagedSnapshot = { paths: new Set(), unreadable: [] };
  await walkPaths(vaultRoot, '', ignore, out);
  return out;
}

/**
 * The folder's entries, or `null` when it vanished (`ENOENT`). A busy or
 * permission-denied folder is read once more after a short pause; any
 * remaining error is thrown.
 */
async function readFolder(dirAbs: string) {
  try {
    return await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    if (code === undefined || !TRANSIENT_READDIR_CODES.has(code)) throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, READDIR_RETRY_MS));
  try {
    return await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function walkPaths(
  rootAbs: string,
  relDir: string,
  ignore: IgnoreFilter,
  out: UnmanagedSnapshot,
): Promise<void> {
  const dirAbs = relDir === '' ? rootAbs : path.join(rootAbs, relDir);
  let entries;
  try {
    entries = await readFolder(dirAbs);
  } catch {
    out.unreadable.push(relDir === '' ? '.' : relDir);
    return;
  }
  if (entries === null) return;

  for (const entry of entries) {
    // Skip symlinks entirely: don't follow (escape/cycle risk) and don't record.
    if (entry.isSymbolicLink()) continue;

    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const isDir = entry.isDirectory();
    const isFile = entry.isFile();
    if (!isDir && !isFile) continue;

    if (isTier1Excluded(relPath)) continue;
    if (ignore.ignores(relPath, isDir)) continue;

    if (isDir) {
      await walkPaths(rootAbs, relPath, ignore, out);
    } else {
      out.paths.add(relPath);
    }
  }
}

/**
 * `bootstrap` boundary check. `touched` is the union of `rehashManagedFiles()`'s
 * `changed` (tracked files whose bytes moved since the pre-hook snapshot) and
 * `missing` (tracked files deleted since then), computed immediately after
 * `bootstrap` ran. Since only `bootstrap` has run at that point, any managed
 * file it modified OR removed is a boundary crossing — bootstrap may write
 * unmanaged paths only.
 */
export function detectManagedWrites(touched: readonly string[]): HookViolation | null {
  if (touched.length === 0) return null;
  return { slot: 'bootstrap', kind: 'managed-write', paths: [...touched].sort() };
}

/**
 * `personalize` boundary check. A path present in `after` but not `before`, and
 * not tracked as a managed file in `state.files`, is an unmanaged file the hook
 * created — `personalize` may only edit existing managed files.
 *
 * Scope: this catches CREATION of unmanaged files (the common author mistake —
 * artifact generation that belongs in `bootstrap`). It deliberately does NOT
 * catch a `personalize` that *modifies or deletes* an already-present unmanaged
 * file (e.g. overwriting bootstrap's `.qmd/index.bin`): the path set is
 * unchanged, so the path-only before/after diff can't see it. Detecting that
 * would require content-hashing every unmanaged file (including bootstrap's
 * large artifacts) on both snapshots — the cost the path-only walk exists to
 * avoid. As a non-fatal courtesy check, creation-only is the deliberate scope;
 * the broader "managed files only" rule remains the author's contract.
 *
 * An incomplete walk is reported, not hidden. A path under a folder that was
 * unreadable `before` is not counted as created, since it may have been there
 * all along. The folders either walk could not read ride on the creation
 * finding as `unreadable`, or, when nothing was created, become an
 * `incomplete` finding of their own.
 */
export function detectUnmanagedCreates(
  after: UnmanagedSnapshot,
  before: UnmanagedSnapshot,
  state: ShardState,
): HookViolation | null {
  const unseenBefore = (rel: string): boolean =>
    before.unreadable.some((dir) => dir === '.' || rel.startsWith(`${dir}/`));
  const created: string[] = [];
  for (const rel of after.paths) {
    if (before.paths.has(rel)) continue;
    if (state.files[rel] !== undefined) continue; // a managed path is not "unmanaged"
    if (unseenBefore(rel)) continue;
    created.push(rel);
  }
  const unreadable = [...new Set([...before.unreadable, ...after.unreadable])].sort();
  if (created.length > 0) {
    const violation: HookViolation = { slot: 'personalize', kind: 'unmanaged-create', paths: created.sort() };
    if (unreadable.length > 0) violation.unreadable = unreadable;
    return violation;
  }
  if (unreadable.length > 0) return { slot: 'personalize', kind: 'incomplete', paths: unreadable };
  return null;
}
