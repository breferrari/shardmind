import { useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';
import type { ConflictRegion, MergeResult } from '../runtime/types.js';

/** Conflict-resolution choices returned to the state machine. */
export type DiffAction = 'accept_new' | 'keep_mine' | 'skip';

/** Matches differ.ts's canonical splitter: tolerate CR, accept LF. */
const LINE_SPLIT = /\r?\n/;

/** Context lines shown before and after each conflict region. */
const CONTEXT_LINES = 3;

/**
 * `Select` accepts arbitrary string values; we use the type-guarded
 * lookup below to filter the disabled "Open in editor" placeholder so
 * no out-of-band value reaches `onChoice`.
 */
const DIFF_ACTIONS = new Set<DiffAction>(['accept_new', 'keep_mine', 'skip']);

const SELECT_OPTIONS = [
  { label: 'Accept new (use shard version)', value: 'accept_new' },
  { label: 'Keep mine (preserve your edits)', value: 'keep_mine' },
  { label: 'Skip this file', value: 'skip' },
  { label: '(Open in editor · v0.2)', value: 'open_editor_disabled' },
] as const;

interface DiffViewProps {
  path: string;
  index: number;
  total: number;
  result: MergeResult;
  onChoice: (action: DiffAction) => void;
}

export default function DiffView({ path: filePath, index, total, result, onChoice }: DiffViewProps) {
  const mergedLines = useMemo(() => result.content.split(LINE_SPLIT), [result.content]);
  // `Select` may fire onChange more than once if Ink re-focuses the
  // instance; once the user's pick is in, ignore everything else for
  // this mount. `key={filePath}` below forces a fresh ref per file so
  // this only blocks same-file duplicates.
  const firedRef = useRef(false);

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color="yellow">Conflict in </Text>
        <Text bold>{filePath}</Text>
        <Text dimColor> ({index} of {total})</Text>
      </Box>

      <Box flexDirection="column">
        {result.conflicts.map((region, i) => (
          <ConflictBlock
            key={`${filePath}-${i}-${region.lineStart}`}
            region={region}
            mergedLines={mergedLines}
          />
        ))}
      </Box>

      <Text dimColor>
        {result.stats.linesUnchanged} unchanged · {result.stats.linesAutoMerged} auto-merged ·{' '}
        {result.conflicts.length} region{result.conflicts.length === 1 ? '' : 's'} conflicted
      </Text>

      <Select
        key={filePath}
        options={SELECT_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
        onChange={(choice) => {
          if (firedRef.current) return;
          if (!DIFF_ACTIONS.has(choice as DiffAction)) return;
          firedRef.current = true;
          onChoice(choice as DiffAction);
        }}
      />
    </Box>
  );
}

function ConflictBlock({
  region,
  mergedLines,
}: {
  region: ConflictRegion;
  mergedLines: string[];
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
      <Text dimColor>lines {region.lineStart}–{region.lineEnd}</Text>
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
