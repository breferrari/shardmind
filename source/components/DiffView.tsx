import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';
import { useOncePerKey } from './use-once-per-key.js';
import type { ConflictRegion, MergeResult } from '../runtime/types.js';
import type { ConflictResolution } from '../core/update-planner.js';

/**
 * Conflict-resolution choices returned to the state machine: the update
 * planner's conflict resolutions, one set for both.
 * `keep_and_track` is offered only for an add-collision, without
 * --adopt-preexisting (#165).
 */
export type DiffAction = ConflictResolution;

/** Matches differ.ts's canonical splitter: tolerate CR, accept LF. */
const LINE_SPLIT = /\r?\n/;

/** Context lines shown before and after each conflict region. */
const CONTEXT_LINES = 3;

/**
 * `Select` accepts arbitrary string values; we use the type-guarded
 * lookup below to filter the disabled "Open in editor" placeholder so
 * no out-of-band value reaches `onChoice`.
 */
const DIFF_ACTIONS = new Set<DiffAction>(['accept_new', 'keep_mine', 'keep_and_track', 'skip']);

const SELECT_OPTIONS: Array<{ label: string; value: DiffAction | 'open_editor_disabled' }> = [
  { label: 'Accept new (use shard version)', value: 'accept_new' },
  { label: 'Keep mine (preserve your edits)', value: 'keep_mine' },
  { label: 'Skip this file', value: 'skip' },
  { label: '(Open in editor · v0.2)', value: 'open_editor_disabled' },
];

/**
 * An add-collision's file is the user's own, not an edited shard file
 * (#60): there are no edits to preserve, and Accept new replaces it.
 */
const PREEXISTING_LABELS: Partial<Record<(typeof SELECT_OPTIONS)[number]['value'], string>> = {
  accept_new: 'Accept new (replace your file)',
  keep_mine: 'Keep mine (keep your file)',
};
const PREEXISTING_OPTIONS = SELECT_OPTIONS.map((o) => ({
  ...o,
  label: PREEXISTING_LABELS[o.value] ?? o.label,
}));

/**
 * Without --adopt-preexisting, Keep mine leaves the file untracked; this
 * tracks it as the user's modified copy for this file alone (#165). With the
 * flag, Keep mine already tracks, so the plain list is shown.
 */
const PREEXISTING_TRACKABLE_OPTIONS = PREEXISTING_OPTIONS.flatMap((o) =>
  o.value === 'keep_mine'
    ? [o, { label: 'Keep mine and track it (merge future updates into your file)', value: 'keep_and_track' as const }]
    : [o],
);

interface DiffViewProps {
  path: string;
  index: number;
  total: number;
  result: MergeResult;
  /** An untracked file at a path the new version adds, not an edited shard file (#60). */
  preexisting?: boolean;
  /** The run's `--adopt-preexisting` (#61): Keep mine / Skip track a preexisting file. */
  adoptPreexisting?: boolean;
  onChoice: (action: DiffAction) => void;
}

export default function DiffView({
  path: filePath,
  index,
  total,
  result,
  preexisting = false,
  adoptPreexisting = false,
  onChoice,
}: DiffViewProps) {
  const mergedLines = useMemo(() => result.content.split(LINE_SPLIT), [result.content]);
  // `update.tsx` advances `phase.currentIndex` without remounting this
  // component, so the dedup ref must be scoped to the per-file key.
  // A boolean `useRef(false)` would leak across files and freeze every
  // conflict prompt after the first. See Pattern B in
  // `docs/COMPONENTS.md` for the broader convention.
  const tryFire = useOncePerKey(filePath);
  const options = !preexisting ? SELECT_OPTIONS : adoptPreexisting ? PREEXISTING_OPTIONS : PREEXISTING_TRACKABLE_OPTIONS;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text bold color="yellow">
            {preexisting ? 'New file from shard collides with your file ' : 'Conflict in '}
          </Text>
          <Text bold>{filePath}</Text>
          <Text dimColor> ({index} of {total})</Text>
        </Box>
        {preexisting && (
          <Text dimColor>
            {adoptPreexisting
              ? 'The new version adds this path. Keep mine or Skip keeps your file and tracks it as your modified copy.'
              : 'The new version adds this path. Keep mine or Skip keeps your file untracked, so the next update asks again; Keep mine and track it tracks it (--adopt-preexisting tracks every one).'}
          </Text>
        )}
      </Box>

      {result.binary ? (
        // #63: no line merge ran; the whole file is the conflict.
        <Text>
          Can't merge this file line by line (binary, or not UTF-8) — yours {result.binary.yours} bytes, shard {result.binary.shard} bytes. Choose a whole version.
        </Text>
      ) : (
        <>
          <Box flexDirection="column">
            {result.conflicts.map((region, i) => (
              <ConflictBlock
                key={`${filePath}-${i}-${region.lineStart}`}
                region={region}
                mergedLines={mergedLines}
                showLineRange={!preexisting}
              />
            ))}
          </Box>

          {/* An add-collision ran no merge (#60): its stats would describe one. */}
          {!preexisting && (
            <Text dimColor>
              {result.stats.linesUnchanged} unchanged · {result.stats.linesAutoMerged} auto-merged ·{' '}
              {result.conflicts.length} region{result.conflicts.length === 1 ? '' : 's'} conflicted
            </Text>
          )}
        </>
      )}

      <Select
        key={filePath}
        options={options}
        onChange={(choice) => {
          if (!DIFF_ACTIONS.has(choice as DiffAction)) return;
          if (!tryFire()) return;
          onChoice(choice as DiffAction);
        }}
      />
    </Box>
  );
}

function ConflictBlock({
  region,
  mergedLines,
  showLineRange,
}: {
  region: ConflictRegion;
  mergedLines: string[];
  /** Off for an add-collision: the range indexes a merged file that never existed (#60). */
  showLineRange: boolean;
}) {
  const beforeStart = Math.max(0, region.lineStart - 1 - CONTEXT_LINES);
  const beforeEnd = region.lineStart - 1;
  const afterStart = region.lineEnd;
  const afterEnd = Math.min(mergedLines.length, region.lineEnd + CONTEXT_LINES);

  const before = mergedLines.slice(beforeStart, beforeEnd);
  const after = mergedLines.slice(afterStart, afterEnd);
  const yours = region.theirs.split(LINE_SPLIT);
  const shard = region.ours.split(LINE_SPLIT);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {showLineRange && <Text dimColor>lines {region.lineStart}–{region.lineEnd}</Text>}
      {before.map((line, i) => (
        <Text key={`b-${i}`} dimColor>  {line}</Text>
      ))}
      <Text color="red">&lt;&lt;&lt;&lt;&lt;&lt;&lt; yours</Text>
      {yours.map((line, i) => (
        <Text key={`y-${i}`} color="red">{line}</Text>
      ))}
      <Text dimColor>=======</Text>
      {shard.map((line, i) => (
        <Text key={`s-${i}`} color="green">{line}</Text>
      ))}
      <Text color="green">&gt;&gt;&gt;&gt;&gt;&gt;&gt; shard update</Text>
      {after.map((line, i) => (
        <Text key={`a-${i}`} dimColor>  {line}</Text>
      ))}
    </Box>
  );
}
