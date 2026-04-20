import { useState, useRef } from 'react';
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
 *
 * Implementation notes:
 * - `Select` carries internal highlight state across re-renders of the
 *   same tree position. Keying it on `filePath` forces a remount per
 *   file so every prompt starts fresh on "Keep".
 * - `submittedRef` guards against a re-entrant render firing `onSubmit`
 *   a second time after we've already committed the final decision.
 */
export default function RemovedFilesReview({ paths, onSubmit }: RemovedFilesReviewProps) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, 'delete' | 'keep'>>({});
  const submittedRef = useRef(false);

  const filePath = paths[index];
  if (!filePath) return null;

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
        key={filePath}
        options={[
          { label: 'Keep my edits (untrack)', value: 'keep' },
          { label: 'Delete', value: 'delete' },
        ]}
        onChange={(choice) => {
          if (submittedRef.current) return;
          const next = { ...decisions, [filePath]: choice as 'delete' | 'keep' };
          if (index + 1 >= paths.length) {
            submittedRef.current = true;
            onSubmit(next);
            return;
          }
          setDecisions(next);
          setIndex(index + 1);
        }}
      />
    </Box>
  );
}
