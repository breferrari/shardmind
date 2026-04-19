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

import { diff3MergeRegions, type IRegion } from 'node-diff3';
import type {
  MergeAction,
  MergeResult,
  ConflictRegion,
  RenderContext,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { sha256 } from './fs-utils.js';
import { renderString } from './renderer.js';

const CONFLICT_START = '<<<<<<< yours';
const CONFLICT_SEPARATOR = '=======';
const CONFLICT_END = '>>>>>>> shard update';

export interface ComputeMergeActionInput {
  path: string;
  ownership: 'managed' | 'modified';
  oldTemplate: string;
  newTemplate: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  actualContent: string;
  renderContext: RenderContext;
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

  // ownership === 'modified'
  const theirs = input.actualContent;
  let merge: ReturnType<typeof threeWayMerge>;
  try {
    merge = threeWayMerge(base, theirs, ours);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Three-way merge failed for ${input.path}: ${message}`,
      'MERGE_FAILED',
      'Re-run with --verbose for the full trace, then report at github.com/breferrari/shardmind/issues.',
    );
  }

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

  const result: MergeResult = {
    content: merge.content,
    hasConflicts: true,
    conflicts: merge.conflicts,
    stats: merge.stats,
  };
  return { type: 'conflict', result };
}

interface ThreeWayMergeResult {
  content: string;
  conflicts: ConflictRegion[];
  stats: MergeResult['stats'];
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
  const baseLines = base.split('\n');
  const theirsLines = theirs.split('\n');
  const oursLines = ours.split('\n');

  const regions: IRegion<string>[] = diff3MergeRegions(
    theirsLines,
    baseLines,
    oursLines,
  );

  const merged: string[] = [];
  const conflicts: ConflictRegion[] = [];
  let linesUnchanged = 0;
  let linesAutoMerged = 0;
  let linesConflicted = 0;

  for (const region of regions) {
    if (region.stable) {
      merged.push(...region.bufferContent);
      linesUnchanged += region.bufferContent.length;
      continue;
    }

    // Unstable region — classify as auto-merge or true conflict.
    const theirsUnchanged = arraysEqual(region.aContent, region.oContent);
    const oursUnchanged = arraysEqual(region.bContent, region.oContent);
    const bothSame = arraysEqual(region.aContent, region.bContent);

    if (theirsUnchanged) {
      // User left base alone; shard changed → take ours.
      merged.push(...region.bContent);
      linesAutoMerged += region.bContent.length;
    } else if (oursUnchanged) {
      // Shard left base alone; user changed → take theirs.
      merged.push(...region.aContent);
      linesAutoMerged += region.aContent.length;
    } else if (bothSame) {
      // False conflict — both sides made the same change.
      merged.push(...region.aContent);
      linesAutoMerged += region.aContent.length;
    } else {
      const lineStart = merged.length + 1;
      merged.push(CONFLICT_START);
      merged.push(...region.aContent);
      merged.push(CONFLICT_SEPARATOR);
      merged.push(...region.bContent);
      merged.push(CONFLICT_END);
      const lineEnd = merged.length;
      conflicts.push({
        lineStart,
        lineEnd,
        base: region.oContent.join('\n'),
        theirs: region.aContent.join('\n'),
        ours: region.bContent.join('\n'),
      });
      linesConflicted += region.aContent.length + region.bContent.length;
    }
  }

  return {
    content: merged.join('\n'),
    conflicts,
    stats: { linesUnchanged, linesAutoMerged, linesConflicted },
  };
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
