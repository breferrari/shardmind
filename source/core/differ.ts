/**
 * Three-way merge engine.
 *
 * Given the old template, the new template, and the file on disk,
 * `computeMergeAction` decides whether to skip, silently overwrite,
 * auto-merge, or surface a conflict. When a merge is needed, the heavy
 * lifting is delegated to node-diff3's Khanna–Myers algorithm (same
 * approach git uses).
 *
 * See docs/IMPLEMENTATION.md §4.9 for the spec.
 */

import { diff3MergeRegions, type IRegion, type IUnstableRegion } from 'node-diff3';
import type {
  MergeAction,
  MergeStatsWithConflicts,
  ConflictRegion,
  RenderContext,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { sha256 } from './fs-utils.js';
import { renderString } from './renderer.js';

const CONFLICT_START = '<<<<<<< yours';
const CONFLICT_SEPARATOR = '=======';
const CONFLICT_END = '>>>>>>> shard update';

// Line splitter. LF is the engine's canonical line ending (renderer output
// is always LF); CR is tolerated so Windows-saved user files don't produce
// spurious conflicts against LF base/ours.
const LINE_SPLIT = /\r?\n/;

// node-diff3's LCS implementation uses a plain `{}` as a hash map keyed by
// line content. If any line equals a string that collides with
// Object.prototype (`constructor`, `__proto__`, `toString`, ...), the
// internal lookup returns a function instead of an array and the library
// crashes. We sidestep this by interning every unique line to a synthetic
// integer token (as a decimal string: "0", "1", "2", ...). Object.prototype
// has no integer-named members, so collisions are impossible by
// construction. Tokens are mapped back to original lines on output —
// callers never see the encoding, and it's robust to any user content
// including control characters.
//
// Upstream: bhousel/node-diff3#86 (issue) + #87 (fix — one-line
// Object.create(null) patch). Drop the LineInterner once node-diff3
// ships a version with the fix. See #49.

export interface ComputeMergeActionInput {
  readonly path: string;
  readonly ownership: 'managed' | 'modified';
  readonly oldTemplate: string;
  readonly newTemplate: string;
  readonly oldValues: Record<string, unknown>;
  readonly newValues: Record<string, unknown>;
  readonly actualContent: string;
  readonly renderContext: RenderContext;
}

export interface ThreeWayMergeResult {
  readonly content: string;
  readonly conflicts: ConflictRegion[];
  readonly stats: MergeStatsWithConflicts;
}

export async function computeMergeAction(
  input: ComputeMergeActionInput,
): Promise<MergeAction> {
  const base = renderString(
    input.oldTemplate,
    { ...input.renderContext, values: input.oldValues },
    input.path,
  );
  const ours = renderString(
    input.newTemplate,
    { ...input.renderContext, values: input.newValues },
    input.path,
  );

  if (sha256(base) === sha256(ours)) {
    return { type: 'skip', reason: 'no upstream change' };
  }

  if (input.ownership === 'managed') {
    return { type: 'overwrite', content: ours };
  }

  const merge = runMerge(base, input.actualContent, ours, input.path);

  if (merge.conflicts.length === 0) {
    return {
      type: 'auto_merge',
      content: merge.content,
      stats: {
        linesUnchanged: merge.stats.linesUnchanged,
        linesAutoMerged: merge.stats.linesAutoMerged,
      },
    };
  }

  return {
    type: 'conflict',
    result: {
      content: merge.content,
      hasConflicts: true,
      conflicts: merge.conflicts,
      stats: merge.stats,
    },
  };
}

function runMerge(base: string, theirs: string, ours: string, path: string): ThreeWayMergeResult {
  try {
    return threeWayMerge(base, theirs, ours);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Three-way merge failed for ${path}: ${message}`,
      'MERGE_FAILED',
      'Re-run with --verbose for the full trace, then report at github.com/breferrari/shardmind/issues.',
    );
  }
}

/**
 * Line-based three-way merge. `a` is theirs (user on disk), `o` is base
 * (rendered from old template + old values), `b` is ours (rendered from
 * new template + new values). Convention matches diff3MergeRegions and
 * the git conflict-marker vocabulary (`<<<<<<< yours` wraps theirs,
 * `>>>>>>> shard update` wraps ours).
 */
export function threeWayMerge(
  base: string,
  theirs: string,
  ours: string,
): ThreeWayMergeResult {
  // Intern every unique line to an integer-named token. See the block
  // comment on LINE_SPLIT for why this is load-bearing.
  const interner = new LineInterner();
  const regions: IRegion<string>[] = diff3MergeRegions(
    interner.tokenize(theirs),
    interner.tokenize(base),
    interner.tokenize(ours),
  );

  const merged: string[] = [];
  const conflicts: ConflictRegion[] = [];
  const stats = { linesUnchanged: 0, linesAutoMerged: 0, linesConflicted: 0 };

  for (const region of regions) {
    if (region.stable) {
      const decoded = region.bufferContent.map(t => interner.detokenize(t));
      merged.push(...decoded);
      // Stable region with buffer === 'o' means all three buffers agreed
      // (truly unchanged). buffer === 'a' or 'b' means diff3 resolved to
      // one side's version without ambiguity — count those as auto-merged.
      if (region.buffer === 'o') {
        stats.linesUnchanged += decoded.length;
      } else {
        stats.linesAutoMerged += decoded.length;
      }
      continue;
    }

    const resolution = resolveUnstableRegion(region, merged.length, interner);
    merged.push(...resolution.lines);
    if (resolution.conflict) conflicts.push(resolution.conflict);
    stats.linesAutoMerged += resolution.autoMergedLines;
    stats.linesConflicted += resolution.conflictedLines;
  }

  // Merged output is always LF; callers convert at the write boundary.
  return { content: merged.join('\n'), conflicts, stats };
}

class LineInterner {
  private readonly table = new Map<string, string>();
  private readonly byIndex: string[] = [];

  tokenize(text: string): string[] {
    return text.split(LINE_SPLIT).map(line => {
      let token = this.table.get(line);
      if (token === undefined) {
        token = String(this.byIndex.length);
        this.table.set(line, token);
        this.byIndex.push(line);
      }
      return token;
    });
  }

  detokenize(token: string): string {
    // Integer-string tokens issued by tokenize(); out-of-range would indicate
    // a programming error, so we fail loudly rather than produce undefined.
    const line = this.byIndex[Number(token)];
    if (line === undefined) {
      throw new Error(`LineInterner: unknown token ${JSON.stringify(token)}`);
    }
    return line;
  }
}

interface RegionResolution {
  readonly lines: readonly string[];
  readonly conflict: ConflictRegion | null;
  readonly autoMergedLines: number;
  readonly conflictedLines: number;
}

/**
 * Classify one unstable region. If either side kept the base unchanged (or
 * both sides made the identical change), we can auto-merge. Otherwise we
 * emit git-style conflict markers and describe a `ConflictRegion` for the
 * UI layer.
 *
 * Pure function — no mutation. `mergedLengthBefore` is the length of the
 * output buffer prior to this region and is used only to compute the
 * 1-indexed line range recorded in the ConflictRegion.
 */
function resolveUnstableRegion(
  region: IUnstableRegion<string>,
  mergedLengthBefore: number,
  interner: LineInterner,
): RegionResolution {
  // Operate on token arrays for equality checks (cheaper than decoding), but
  // emit decoded lines and decoded conflict snapshots so callers never see
  // the internal encoding.
  const theirsTokens = region.aContent;
  const oursTokens = region.bContent;
  const baseTokens = region.oContent;

  const decode = (tokens: string[]): string[] => tokens.map(t => interner.detokenize(t));

  if (arraysEqual(theirsTokens, baseTokens)) {
    const decoded = decode(oursTokens);
    return { lines: decoded, conflict: null, autoMergedLines: decoded.length, conflictedLines: 0 };
  }
  if (arraysEqual(oursTokens, baseTokens) || arraysEqual(theirsTokens, oursTokens)) {
    const decoded = decode(theirsTokens);
    return { lines: decoded, conflict: null, autoMergedLines: decoded.length, conflictedLines: 0 };
  }

  const theirs = decode(theirsTokens);
  const ours = decode(oursTokens);
  const base = decode(baseTokens);
  const lines = [CONFLICT_START, ...theirs, CONFLICT_SEPARATOR, ...ours, CONFLICT_END];
  const lineStart = mergedLengthBefore + 1;
  const lineEnd = mergedLengthBefore + lines.length;
  return {
    lines,
    conflict: {
      lineStart,
      lineEnd,
      base: base.join('\n'),
      theirs: theirs.join('\n'),
      ours: ours.join('\n'),
    },
    autoMergedLines: 0,
    conflictedLines: theirs.length + ours.length,
  };
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
