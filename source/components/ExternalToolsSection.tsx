/**
 * The "External tools" block shared by Summary, UpdateSummary and
 * AdoptSummary (#138): one line per unmet optional tool with its install
 * hint, or the dry-run note. The lines come from `checkExternalToolsForRun`
 * in core/external-tools.ts; nothing renders when there are none.
 */

import { Box, Text } from 'ink';

interface ExternalToolsSectionProps {
  lines: readonly string[];
}

export default function ExternalToolsSection({ lines }: ExternalToolsSectionProps) {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">External tools:</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>· {line}</Text>
      ))}
    </Box>
  );
}
