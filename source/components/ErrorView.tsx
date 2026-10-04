import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import { ShardMindError } from '../runtime/types.js';
import { bugReportUrl } from '../core/bug-report.js';

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
 * Every command's error view (#225). A ShardMindError is a known failure:
 * its message, code and hint. Anything else is a bug in shardmind: the
 * message, a link to report it, and the stack, which stays on this machine.
 */
export default function ErrorView({ error, version, detail, lead }: ErrorViewProps) {
  const message = error instanceof Error ? error.message : String(error);
  const shown = lead ? `${lead}: ${message}` : message;
  if (error instanceof ShardMindError) {
    return (
      <Box flexDirection="column" gap={1}>
        <StatusMessage variant="error">{shown}</StatusMessage>
        <Text dimColor>code: {error.code}</Text>
        {error.hint && <Text>{error.hint}</Text>}
        {detail && <Text dimColor>{detail}</Text>}
      </Box>
    );
  }
  const stack = error instanceof Error && error.stack ? error.stack : null;
  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant="error">{shown}</StatusMessage>
      {detail && <Text dimColor>{detail}</Text>}
      <Box flexDirection="column">
        <Text>This is a bug in shardmind. Please report it:</Text>
        <Text color="cyan">{bugReportUrl(error, version)}</Text>
      </Box>
      {stack && <Text dimColor>{stack}</Text>}
    </Box>
  );
}
