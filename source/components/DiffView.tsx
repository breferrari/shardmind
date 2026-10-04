import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';
import { useOncePerKey } from './use-once-per-key.js';
import type { ConflictRegion, MergeResult } from '../runtime/types.js';
import type { ConflictChoice } from '../core/update-planner.js';

/**
 * Choices returned to the state machine: the update planner's conflict
 * choices, plus the editor's (#50). `open_editor` opens the conflict in the
 * user's editor; after an edit that kept conflict markers, `edit_again` and
 * `use_edit` (markers included) are offered with Keep mine.
 * `keep_and_track` is offered only for an add-collision, without
 * --adopt-preexisting (#165).
 */
export type DiffAction = ConflictChoice | 'open_editor' | 'edit_again' | 'use_edit';

/** Matches differ.ts's canonical splitter: tolerate CR, accept LF. */
const LINE_SPLIT = /\r?\n/;

/** Context lines shown before and after each conflict region. */
const CONTEXT_LINES = 3;

/**
 * `Select` accepts arbitrary string values; only these reach `onChoice`.
 * A Record over the union: an action that is not listed here fails the
 * typecheck instead of being dropped by onChange (#103, #109).
 */
const DIFF_ACTIONS = new Set<DiffAction>(
  Object.keys({
    accept_new: true,
    keep_mine: true,
    keep_and_track: true,
    skip: true,
    open_editor: true,
    edit_again: true,
    use_edit: true,
  } satisfies Record<DiffAction, true>) as DiffAction[],
);

interface Option {
  label: string;
  value: DiffAction;
}

const SELECT_OPTIONS: Option[] = [
  { label: 'Accept new (use shard version)', value: 'accept_new' },
  { label: 'Keep mine (preserve your edits)', value: 'keep_mine' },
  { label: 'Skip this file', value: 'skip' },
];

/**
 * An add-collision's file is the user's own, not an edited shard file
 * (#60): there are no edits to preserve, and Accept new replaces it.
 */
const PREEXISTING_LABELS: Partial<Record<DiffAction, string>> = {
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
const PREEXISTING_TRACKABLE_OPTIONS = PREEXISTING_OPTIONS.flatMap((o): Option[] =>
  // After Skip, so the options a user already knows keep their positions.
  o.value === 'skip'
    ? [o, { label: 'Keep mine and track it (merge future updates into your file)', value: 'keep_and_track' }]
    : [o],
);

/** Last, so the other options keep their positions (#50). */
const OPEN_EDITOR_OPTION: Option = { label: 'Open in editor (resolve it yourself)', value: 'open_editor' };

/** After an edit that kept conflict markers: they reach the vault only by `use_edit` (#50). */
const MARKER_OPTIONS: Option[] = [
  { label: 'Edit again', value: 'edit_again' },
  { label: 'Use my edit as is (conflict markers included)', value: 'use_edit' },
  { label: 'Keep mine', value: 'keep_mine' },
];

interface DiffViewProps {
  path: string;
  index: number;
  total: number;
  result: MergeResult;
  /** An untracked file at a path the new version adds, not an edited shard file (#60). */
  preexisting?: boolean;
  /** The run's `--adopt-preexisting` (#61): Keep mine / Skip track a preexisting file. */
  adoptPreexisting?: boolean;
  /** An editor is set ($VISUAL or $EDITOR): offer Open in editor on a text conflict (#50). */
  canEdit?: boolean;
  /** Why the last edit came back without resolving the conflict (cancelled, unchanged). */
  editNote?: string | undefined;
  /** The last edit was saved with conflict markers left: offer edit again / use as is / keep mine. */
  editHasMarkers?: boolean;
  /** Edit attempts on this file: a new prompt round, so its choice is not deduped away. */
  attempt?: number;
  onChoice: (action: DiffAction) => void;
}

export default function DiffView({
  path: filePath,
  index,
  total,
  result,
  preexisting = false,
  adoptPreexisting = false,
  canEdit = false,
  editNote,
  editHasMarkers = false,
  attempt = 0,
  onChoice,
}: DiffViewProps) {
  const mergedLines = useMemo(() => result.content.split(LINE_SPLIT), [result.content]);
  // `update.tsx` advances `phase.currentIndex` without remounting this
  // component, so the dedup ref must be scoped to the per-file key.
  // A boolean `useRef(false)` would leak across files and freeze every
  // conflict prompt after the first. See Pattern B in
  // `docs/COMPONENTS.md` for the broader convention.
  // An edit that comes back to this file is a new round of the same prompt.
  const roundKey = `${filePath}#${attempt}`;
  const tryFire = useOncePerKey(roundKey);
  const choices = !preexisting ? SELECT_OPTIONS : adoptPreexisting ? PREEXISTING_OPTIONS : PREEXISTING_TRACKABLE_OPTIONS;
  const options = editHasMarkers
    ? MARKER_OPTIONS
    : canEdit && !result.binary
      ? [...choices, OPEN_EDITOR_OPTION]
      : choices;

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
        {editHasMarkers && (
          <Text color="yellow">
            {'Your edit still has conflict markers (lines starting <<<<<<< or >>>>>>>). Edit again, use it as is with the markers, or keep yours.'}
          </Text>
        )}
        {editNote && <Text color="yellow">{editNote}</Text>}
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
        key={roundKey}
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
