import { Box, Text } from 'ink';
import { ProgressBar, Spinner } from '@inkjs/ui';

interface InstallProgressProps {
  current: number;
  total: number;
  label: string;
  verbose?: boolean;
  history?: string[];
}

export default function InstallProgress({
  current,
  total,
  label,
  verbose,
  history,
}: InstallProgressProps) {
  const percent = total === 0 ? 0 : Math.min(100, Math.round((current / total) * 100));

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Spinner />
        <Text>
          <Text dimColor>[{current}/{total}]</Text>
          <Text> {label}</Text>
        </Text>
      </Box>
      <ProgressBar value={percent} />
      {verbose && history && history.length > 0 && (
        <Box flexDirection="column">
          {history.slice(-5).map((line, i) => (
            <Text key={`${i}-${line}`} dimColor>
              · {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
