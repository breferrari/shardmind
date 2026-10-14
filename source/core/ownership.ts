/**
 * One owner per file (R2): which vault paths a shard may not write because
 * another shard, or the engine, owns them. `add` checks an overlay against
 * every shard (#396); update checks a shard's new version against every
 * other shard (#407). Spec: docs/IMPLEMENTATION.md §4.30 steps 6.6 and 10.4;
 * SHARD-LAYOUT §Overlay shards.
 */

import type { VaultState } from '../runtime/types.js';
import { SHARDMIND_DIR, VALUES_FILE, overlayValuesFile } from '../runtime/vault-paths.js';
import { foldOutputPath } from './fs-utils.js';

/**
 * Every path a shard may not write, keyed by its case-folded form, with its
 * owner: each shard's files, every values file, and each folder holding a
 * shard's files, keyed with a trailing `/` (a file there would move them
 * aside). Anything under `.shardmind/` is the engine's, by prefix, in
 * `ownerOf`.
 *
 * - `adding`: the overlay `add` puts in; the values file it will write is
 *   owned too, so a shard that ships it is refused up front.
 * - `except`: the index of the shard being updated, whose own files and
 *   values file are its to write.
 *
 * Throws for an overlay name that is not `<namespace>/<name>`: such a state
 * is refused, never given a stand-in path (#406 review).
 */
export function ownedPaths(vault: VaultState, opts: { adding?: string; except?: number }): Map<string, string> {
  const owned = new Map<string, string>();
  const own = (rel: string, owner: string) => owned.set(foldPath(rel), owner);
  vault.shards.forEach((shard, i) => {
    if (i === opts.except) return;
    for (const rel of Object.keys(shard.files)) {
      own(rel, shard.shard);
      const parts = foldPath(rel).split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = `${parts.slice(0, depth).join('/')}/`;
        if (!owned.has(folder)) owned.set(folder, `${shard.shard} (a folder of its files)`);
      }
    }
    own(i === 0 ? VALUES_FILE : overlayValuesFile(shard.shard), `${shard.shard} (its values file)`);
  });
  if (opts.adding !== undefined) own(overlayValuesFile(opts.adding), `${opts.adding} (the values file add writes)`);
  return owned;
}

/**
 * Who owns `rel`, if anyone: the engine (`.shardmind/`); a shard, when it
 * manages the path, keeps a folder of files there, or manages a file at a
 * folder above it (the file is in the way); or nobody.
 */
export function ownerOf(rel: string, owned: Map<string, string>): string | null {
  const folded = foldPath(rel);
  if (folded === SHARDMIND_DIR || folded.startsWith(`${SHARDMIND_DIR}/`)) return 'ShardMind (the engine folder)';
  const exact = owned.get(folded) ?? owned.get(`${folded}/`);
  if (exact !== undefined) return exact;
  const parts = folded.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const above = owned.get(parts.slice(0, depth).join('/'));
    if (above !== undefined) return `${above} (a file above this path)`;
  }
  return null;
}

/** Each of `paths` someone owns, with its owner, in the order given. */
export function ownedConflicts(owned: Map<string, string>, paths: readonly string[]): Array<{ rel: string; owner: string }> {
  return paths
    .map((rel) => ({ rel, owner: ownerOf(rel, owned) }))
    .filter((t): t is { rel: string; owner: string } => t.owner !== null);
}

/** Up to `OWNED_LISTED` of the conflicts, `path (owner)`, then how many more. */
const OWNED_LISTED = 20;
export function listOwned(taken: ReadonlyArray<{ rel: string; owner: string }>): string {
  const items = taken.map((t) => `${t.rel} (${t.owner})`);
  const shown = items.slice(0, OWNED_LISTED).join(', ');
  return items.length > OWNED_LISTED ? `${shown}, and ${items.length - OWNED_LISTED} more` : shown;
}

/**
 * One spelling per path, as the vault-path guard folds it (`foldOutputPath`:
 * NFC, lower case), with forward slashes.
 */
function foldPath(rel: string): string {
  return foldOutputPath(rel.replaceAll('\\', '/'));
}
