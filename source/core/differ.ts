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

// Non-printable sentinel prefixed to every line before handing them to
// node-diff3. Reason: node-diff3's LCS implementation uses a plain `{}`
// as a Map and iterates on string keys, which blows up when any line is
// a string that collides with Object.prototype members ('constructor',
// '__proto__', 'toString', 'hasOwnProperty', etc.). In a vault of
// markdown/code content, `constructor` appearing on its own line is not
// exotic. Prefixing every line with U+0001 (START OF HEADING, never a
// valid printable character) sidesteps the collision because no
// prototype member name starts with that code unit. We strip the prefix
// before anything leaves this module.
const LINE_SENTINEL = '\u0001';

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
  // Merged output is always LF — callers that need platform-native line
  // endings convert at the write boundary.
  const regions: IRegion<string>[] = diff3MergeRegions(
    prefixLines(theirs),
    prefixLines(base),
    prefixLines(ours),
  );

  const merged: string[] = [];
  const conflicts: ConflictRegion[] = [];
  const stats = { linesUnchanged: 0, linesAutoMerged: 0, linesConflicted: 0 };

  for (const region of regions) {
    if (region.stable) {
      merged.push(...region.bufferContent);
      // Stable region with buffer === 'o' means all three buffers agreed
      // (truly unchanged). buffer === 'a' or 'b' means diff3 resolved to
      // one side's version without ambiguity — count those as auto-merged.
      if (region.buffer === 'o') {
        stats.linesUnchanged += region.bufferContent.length;
      } else {
        stats.linesAutoMerged += region.bufferContent.length;
      }
      continue;
    }

    const resolution = resolveUnstableRegion(region, merged.length);
    merged.push(...resolution.lines);
    if (resolution.conflict) conflicts.push(resolution.conflict);
    stats.linesAutoMerged += resolution.autoMergedLines;
    stats.linesConflicted += resolution.conflictedLines;
  }

  return { content: stripPrefixes(merged.join('\n')), conflicts, stats };
}

function prefixLines(text: string): string[] {
  return text.split(LINE_SPLIT).map(line => LINE_SENTINEL + line);
}

function stripPrefixes(text: string): string {
  // Global strip of the sentinel from anywhere it appears in the output.
  // Safer than slicing per-line because merger output interleaves stable
  // region content with conflict markers we added ourselves (markers do
  // not carry the sentinel, so this is a no-op on them).
  return text.replace(new RegExp(LINE_SENTINEL, 'g'), '');
}

function stripPrefix(line: string): string {
  return line.startsWith(LINE_SENTINEL) ? line.slice(LINE_SENTINEL.length) : line;
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
): RegionResolution {
  const { aContent: theirs, bContent: ours, oContent: base } = region;

  if (arraysEqual(theirs, base)) {
    return { lines: ours, conflict: null, autoMergedLines: ours.length, conflictedLines: 0 };
  }
  if (arraysEqual(ours, base) || arraysEqual(theirs, ours)) {
    return { lines: theirs, conflict: null, autoMergedLines: theirs.length, conflictedLines: 0 };
  }

  const lines = [CONFLICT_START, ...theirs, CONFLICT_SEPARATOR, ...ours, CONFLICT_END];
  const lineStart = mergedLengthBefore + 1;
  const lineEnd = mergedLengthBefore + lines.length;
  return {
    lines,
    conflict: {
      lineStart,
      lineEnd,
      // Strip the LINE_SENTINEL prefix before exposing the content to the UI
      // layer. Consumers never see the prefix; it's an internal encoding.
      base: base.map(stripPrefix).join('\n'),
      theirs: theirs.map(stripPrefix).join('\n'),
      ours: ours.map(stripPrefix).join('\n'),
    },
    autoMergedLines: 0,
    conflictedLines: theirs.length + ours.length,
  };
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
