/**
 * Two-way union merge for `shardmind adopt --mode=auto-merge` (#120).
 *
 * Adopt compares the user's vault file against the rendered shard file with
 * **no common ancestor** — the vault was cloned without shardmind, so the
 * original shard version that produced the user's bytes is unrecorded. A
 * base-anchored three-way merge (`core/differ.ts`, used by `update`) is
 * therefore impossible here.
 *
 * What we can do instead is a *union* merge: keep every line the two sides
 * share, keep each side's unique lines, and treat a region where BOTH sides
 * replaced the same span as a conflict that the caller resolves by prompting.
 *
 * This is a deliberately weaker, best-effort operation — surfaced as such in
 * the mode picker and docs. Its limitations are inherent to having no base:
 *
 *   - It **keeps the user's bytes** and therefore **does not apply shard
 *     deletions**: content the shard removed looks "user-unique" and is
 *     retained.
 *   - "Non-conflicting" is a line-*adjacency* heuristic. Two edits to the
 *     same idea that `diffLines` does not align as one replacement run are
 *     both kept (union), which can duplicate content. Overlapping (adjacent
 *     removed+added) runs are always reported as conflicts, never combined.
 *   - Newlines are never normalized, so a file that differs only in its
 *     trailing newline is a conflict (it prompts) — deliberately conservative
 *     rather than risk masking a real diff.
 *
 * `content` is the union and is only meaningful when `hasConflict === false`;
 * the caller sends conflicting files to the per-file prompt instead.
 */

import { diffLines } from 'diff';

export interface TwoWayMergeResult {
  /** The union-merged bytes. Only valid when `hasConflict === false`. */
  content: Buffer;
  /** True when some region needs a human decision (or the input is binary). */
  hasConflict: boolean;
}

/**
 * Union-merge `userContent` and `shardContent`.
 *
 * Binary inputs can't be line-merged, so they always conflict (the caller
 * prompts). For text, walk `diffLines` and group each maximal run of
 * non-common parts: a run touching only one side is unioned in; a run
 * touching both sides (a replacement) marks a conflict.
 */
export function twoWayUnionMerge(
  userContent: Buffer,
  shardContent: Buffer,
  isBinary: boolean,
): TwoWayMergeResult {
  if (isBinary) {
    // No meaningful line merge — force a prompt. `content` is unused.
    return { content: userContent, hasConflict: true };
  }

  const parts = diffLines(userContent.toString('utf8'), shardContent.toString('utf8'));

  let hasConflict = false;
  let out = '';

  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      // Common to both sides — emit verbatim (raw value preserves the
      // exact bytes, including any CRLF / trailing newline).
      out += part.value;
      i++;
      continue;
    }

    // Gather the maximal contiguous run of changed parts.
    let runHasUser = false; // removed === present in user, absent in shard
    let runHasShard = false; // added === present in shard, absent in user
    let runValue = '';
    let j = i;
    while (j < parts.length && (parts[j]!.added || parts[j]!.removed)) {
      if (parts[j]!.removed) runHasUser = true;
      if (parts[j]!.added) runHasShard = true;
      runValue += parts[j]!.value;
      j++;
    }

    if (runHasUser && runHasShard) {
      // Both sides replaced the same span — a real conflict. Leave it for
      // the per-file prompt; the union `content` is no longer usable.
      hasConflict = true;
    } else {
      // Pure one-side change (user-unique OR shard-unique lines) — union it.
      out += runValue;
    }
    i = j;
  }

  return { content: Buffer.from(out, 'utf8'), hasConflict };
}
