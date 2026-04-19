import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';

interface RemovedFilesReviewProps {
  paths: string[];
  onSubmit: (decisions: Record<string, 'delete' | 'keep'>) => void;
}

/**
 * One file at a time: "this file was in the old shard and you edited it,
 * but the new shard no longer ships it. Keep your version or delete?"
 *
 * Only modified files surface here — managed removals auto-delete silently.
 */
export default function RemovedFilesReview({ paths, onSubmit }: RemovedFilesReviewProps) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, 'delete' | 'keep'>>({});

  const done = index >= paths.length;
  useEffect(() => {
    if (done) onSubmit(decisions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (done) return null;

  const filePath = paths[index]!;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="yellow">Removed by new shard</Text>
      <Text>
        <Text>{filePath} </Text>
        <Text dimColor>({index + 1} of {paths.length})</Text>
      </Text>
      <Text dimColor>
        You edited this file and the new shard no longer ships it. Keep your version
        (it stops being tracked) or delete it?
      </Text>
      <Select
        options={[
          { label: 'Keep my edits (untrack)', value: 'keep' },
          { label: 'Delete', value: 'delete' },
        ]}
        onChange={(choice) => {
          setDecisions((prev) => ({ ...prev, [filePath]: choice as 'delete' | 'keep' }));
          setIndex((i) => i + 1);
        }}
      />
    </Box>
  );
}
