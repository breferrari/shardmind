import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';
import type { ConflictRegion, MergeResult } from '../runtime/types.js';

export type DiffAction = 'accept_new' | 'keep_mine' | 'skip';

interface DiffViewProps {
  path: string;
  index: number;
  total: number;
  result: MergeResult;
  onChoice: (action: DiffAction) => void;
}

const CONTEXT_LINES = 3;

export default function DiffView({ path: filePath, index, total, result, onChoice }: DiffViewProps) {
  const mergedLines = useMemo(() => result.content.split('\n'), [result.content]);

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
        options={[
          { label: 'Accept new (use shard version)', value: 'accept_new' },
          { label: 'Keep mine (preserve your edits)', value: 'keep_mine' },
          { label: 'Skip this file', value: 'skip' },
          { label: '(Open in editor · v0.2)', value: 'open_editor_disabled' },
        ]}
        onChange={(choice) => {
          if (choice === 'open_editor_disabled') return;
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
  const yours = region.theirs.split('\n');
  const shard = region.ours.split('\n');

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
