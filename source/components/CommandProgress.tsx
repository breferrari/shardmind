import { Box, Text } from 'ink';
import { ProgressBar, Spinner } from './ui.js';

/**
 * Progress indicator shared by install and update commands: spinner +
 * counter + ProgressBar, with an optional rolling history footer for
 * verbose mode.
 */
interface CommandProgressProps {
  current: number;
  total: number;
  label: string;
  verbose?: boolean;
  history?: string[];
}

export default function CommandProgress({
  current,
  total,
  label,
  verbose,
  history,
}: CommandProgressProps) {
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
          {history.map((line, i) => (
            <Text key={`${i}-${line}`} dimColor>
              · {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
