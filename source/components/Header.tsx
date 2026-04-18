import { Box, Text } from 'ink';
import { Badge } from './ui.js';
import type { ShardManifest } from '../runtime/types.js';

interface HeaderProps {
  manifest: ShardManifest;
}

export default function Header({ manifest }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color="cyan">
          {manifest.namespace}/{manifest.name}
        </Text>
        <Badge color="blue">v{manifest.version}</Badge>
      </Box>
      {manifest.description && (
        <Box marginTop={1}>
          <Text dimColor>{manifest.description}</Text>
        </Box>
      )}
      {manifest.persona && (
        <Box marginTop={1}>
          <Text>
            <Text dimColor>for </Text>
            <Text italic>{manifest.persona}</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
