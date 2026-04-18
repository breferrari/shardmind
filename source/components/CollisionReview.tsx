import { Box, Text } from 'ink';
import { Select, Alert } from '@inkjs/ui';
import type { Collision } from '../core/install-plan.js';

export type CollisionAction = 'backup' | 'overwrite' | 'cancel';

interface CollisionReviewProps {
  collisions: Collision[];
  onChoice: (action: CollisionAction) => void;
}

export default function CollisionReview({ collisions, onChoice }: CollisionReviewProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <Alert variant="warning">
        {collisions.length} existing file{collisions.length === 1 ? '' : 's'} will be affected
      </Alert>

      <Box flexDirection="column">
        {collisions.slice(0, 15).map((c) => (
          <Text key={c.absolutePath}>
            <Text>· {c.outputPath}</Text>
            <Text dimColor>  ({formatSize(c.size)}, modified {formatMtime(c.mtime)})</Text>
          </Text>
        ))}
        {collisions.length > 15 && (
          <Text dimColor>  …and {collisions.length - 15} more</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>How should I handle these?</Text>
        <Select
          options={[
            {
              label: 'Back up existing files and install (safest)',
              value: 'backup',
            },
            {
              label: 'Overwrite — existing content is lost',
              value: 'overwrite',
            },
            {
              label: 'Cancel',
              value: 'cancel',
            },
          ]}
          onChange={(v) => onChoice(v as CollisionAction)}
        />
      </Box>
    </Box>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatMtime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  return `${diffDays}d ago`;
}
