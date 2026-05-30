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
 *    `detectManagedWrites`. No extra disk read: the managed set's pre-hook
 *    hashes come free from `state.files`, the post-hook hashes from the re-hash.
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

export type HookViolationKind = 'managed-write' | 'unmanaged-create';

export interface HookViolation {
  slot: HookSlot;
  kind: HookViolationKind;
  /** Vault-relative posix paths the hook touched outside its boundary. */
  paths: string[];
}

/**
 * Vault-relative posix paths present in the vault, ignore-filtered and
 * Tier-1-filtered, with symlinks skipped (not followed — the vault is user
 * territory and a symlink loop/escape must not wedge the walk). Path-only: no
 * content is read. Taken right before and right after `personalize` to detect
 * files it created.
 */
export async function snapshotUnmanaged(
  vaultRoot: string,
  ignore: IgnoreFilter,
): Promise<Set<string>> {
  const out = new Set<string>();
  await walkPaths(vaultRoot, '', ignore, out);
  return out;
}

async function walkPaths(
  rootAbs: string,
  relDir: string,
  ignore: IgnoreFilter,
  out: Set<string>,
): Promise<void> {
  const dirAbs = relDir === '' ? rootAbs : path.join(rootAbs, relDir);
  let entries;
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    // A directory that vanished mid-walk (a hook deleting under us) or is
    // unreadable is not a boundary signal — best-effort, skip it.
    return;
  }

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
      out.add(relPath);
    }
  }
}

/**
 * `bootstrap` boundary check. `rehashChanged` is `rehashManagedFiles().changed`
 * computed immediately after `bootstrap` ran — every entry is a managed (non-
 * 'user') file whose on-disk bytes diverged from the engine-written bytes.
 * Since only `bootstrap` has run at that point, any changed managed file is a
 * boundary crossing.
 */
export function detectManagedWrites(rehashChanged: readonly string[]): HookViolation | null {
  if (rehashChanged.length === 0) return null;
  return { slot: 'bootstrap', kind: 'managed-write', paths: [...rehashChanged].sort() };
}

/**
 * `personalize` boundary check. A path present in `after` but not `before`, and
 * not tracked as a managed file in `state.files`, is an unmanaged file the hook
 * created — `personalize` may only edit existing managed files.
 */
export function detectUnmanagedCreates(
  after: ReadonlySet<string>,
  before: ReadonlySet<string>,
  state: ShardState,
): HookViolation | null {
  const created: string[] = [];
  for (const rel of after) {
    if (before.has(rel)) continue;
    if (state.files[rel] !== undefined) continue; // a managed path is not "unmanaged"
    created.push(rel);
  }
  if (created.length === 0) return null;
  return { slot: 'personalize', kind: 'unmanaged-create', paths: created.sort() };
}
