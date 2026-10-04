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

/**
 * Dominant line ending of `theirs` (the user's on-disk file). When a
 * Windows user saves a managed note with CRLF, we honor that on merge
 * output rather than silently rewriting the file to LF — which would
 * flip line endings on every `shardmind update` and churn git blame.
 *
 * Heuristic: if the file contains any `\r\n`, treat as CRLF. Mixed
 * endings collapse to CRLF which is the practical norm on Windows
 * editors that emit CRLF-by-default.
 */
function detectLineEnding(source: string): '\r\n' | '\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

// Raw lines go straight to node-diff3, which keys its LCS lookup by line
// content. That needs node-diff3 >= 3.2.1: earlier versions used a plain `{}`
// for the lookup, so a line equal to an Object.prototype member
// (`constructor`, `__proto__`, `toString`, ...) crashed the merge, and this
// module interned lines to integer tokens to avoid it (bhousel/node-diff3#86,
// fixed by #87; workaround removed in #49). The prototype-name tests in
// three-way-merge.test.ts and merge-adversarial.test.ts guard the fix.

export interface ComputeMergeActionInput {
  readonly path: string;
  readonly ownership: 'managed' | 'modified';
  readonly oldTemplate: string;
  readonly newTemplate: string;
  readonly oldValues: Record<string, unknown>;
  readonly newValues: Record<string, unknown>;
  readonly actualContent: string;
  readonly renderContext: RenderContext;
  /**
   * Copy-origin file (not a `.njk` template): `oldTemplate` / `newTemplate`
   * are verbatim bytes, NOT Nunjucks sources. Skip rendering them — a copy
   * file is never templated, so rendering it (a) crashes on a literal `{{`
   * that isn't a valid expression (e.g. `garbage{{` in a test fixture) and
   * (b) silently substitutes any real `{{ expr }}` the file contains as
   * data. The three-way merge runs on the raw bytes instead. Default
   * `false` keeps the rendered path for `.njk` templates. See #132.
   */
  readonly literal?: boolean;
  /**
   * An `_each` output's list item on each side: the old item renders the
   * merge base, the new one the shard's new version, as `renderEach` did at
   * install. Without them both sides render `{{ item }}` empty, so a
   * template change looks like a conflict with the user's file (#233).
   */
  readonly oldItem?: unknown;
  readonly newItem?: unknown;
}

export interface ThreeWayMergeResult {
  readonly content: string;
  readonly conflicts: ConflictRegion[];
  readonly stats: MergeStatsWithConflicts;
}

export async function computeMergeAction(
  input: ComputeMergeActionInput,
): Promise<MergeAction> {
  // Copy-origin files are verbatim — never run Nunjucks over them (see
  // `literal` on the input type). Template files render old/new values so the
  // diff3 below sees only the user's manual edits, not value churn.
  const sideContent = (template: string, values: Record<string, unknown>, item: unknown): string =>
    input.literal
      ? template
      : renderString(
          template,
          { ...input.renderContext, values, ...(item === undefined ? {} : { item }) },
          input.path,
        );
  const base = sideContent(input.oldTemplate, input.oldValues, input.oldItem);
  const ours = sideContent(input.newTemplate, input.newValues, input.newItem);

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
  // Note: `split(/\r?\n/)` produces a trailing "" line when input ends with a
  // newline (e.g. "a\nb\n" → ["a", "b", ""]). That trailing "" is how the
  // newline-as-document-property is preserved through diff3 — we keep it in
  // the merge itself and correct for it in stats after the loop.
  const regions: IRegion<string>[] = diff3MergeRegions(
    theirs.split(LINE_SPLIT),
    base.split(LINE_SPLIT),
    ours.split(LINE_SPLIT),
  );

  const merged: string[] = [];
  const conflicts: ConflictRegion[] = [];
  const stats = { linesUnchanged: 0, linesAutoMerged: 0, linesConflicted: 0 };

  for (const region of regions) {
    if (region.stable) {
      const lines = region.bufferContent;
      merged.push(...lines);
      // Stable region with buffer === 'o' means all three buffers agreed
      // (truly unchanged). buffer === 'a' or 'b' means diff3 resolved to
      // one side's version without ambiguity — count those as auto-merged.
      if (region.buffer === 'o') {
        stats.linesUnchanged += lines.length;
      } else {
        stats.linesAutoMerged += lines.length;
      }
      continue;
    }

    const resolution = resolveUnstableRegion(region, merged.length);
    merged.push(...resolution.lines);
    if (resolution.conflict) conflicts.push(resolution.conflict);
    stats.linesAutoMerged += resolution.autoMergedLines;
    stats.linesConflicted += resolution.conflictedLines;
  }

  // Correct stats for the trailing empty line. When all three inputs end
  // with `\n`, `split` produced a trailing "" on each, diff3 emitted it as
  // part of a stable unchanged region, and it's padded `linesUnchanged` by 1.
  // Subtract it so stats match user-visible line counts.
  if (merged.length > 0 && merged[merged.length - 1] === '' && stats.linesUnchanged > 0) {
    stats.linesUnchanged -= 1;
  }

  // Restore theirs's line ending on merged output. Renderer output is
  // LF-canonical and so is `base`/`ours`, but the user's `theirs` may be
  // CRLF — preserving it here means `shardmind update` doesn't silently
  // flip the file's line endings on write.
  const lineEnding = detectLineEnding(theirs);
  return { content: merged.join(lineEnding), conflicts, stats };
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
  const theirs = region.aContent;
  const ours = region.bContent;
  const base = region.oContent;

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
