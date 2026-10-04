import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import { describeError } from '../core/bug-report.js';

interface ErrorViewProps {
  error: unknown;
  /** shardmind's version, for the report link. */
  version?: string | undefined;
  /** Extra context the command adds under the error. */
  detail?: string | undefined;
  /** Put in front of the message: `<lead>: <message>`. */
  lead?: string;
}

/**
 * Every command's error view (#225), rendered from `describeError`. A
 * ShardMindError, or an error from the user's machine (a full disk, a
 * permission), shows its code and hint. Anything else is a bug in shardmind:
 * the message, a link to report it, and the stack, which stays on this machine.
 */
export default function ErrorView({ error, version, detail, lead }: ErrorViewProps) {
  const d = describeError(error, version);
  const shown = lead ? `${lead}: ${d.message}` : d.message;
  if (d.kind !== 'bug') {
    return (
      <Box flexDirection="column" gap={1}>
        <StatusMessage variant="error">{shown}</StatusMessage>
        <Text dimColor>code: {d.code}</Text>
        {d.hint && <Text>{d.hint}</Text>}
        {detail && <Text dimColor>{detail}</Text>}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant="error">{shown}</StatusMessage>
      {detail && <Text dimColor>{detail}</Text>}
      <Box flexDirection="column">
        <Text>This is a bug in shardmind. Please report it:</Text>
        <Text color="cyan">{d.url}</Text>
      </Box>
      {d.stack && <Text dimColor>{d.stack}</Text>}
    </Box>
  );
}
