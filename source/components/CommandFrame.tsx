import { type ReactNode } from 'react';
import { Box, Text } from 'ink';

/**
 * Outer shell for a top-level command (install, update). Renders the
 * dry-run banner above children and the keyboard-legend hint below,
 * so command files only own their phase content — not the chrome.
 */
interface CommandFrameProps {
  children: ReactNode;
  dryRun: boolean;
  showLegend?: boolean;
}

export default function CommandFrame({ children, dryRun, showLegend = true }: CommandFrameProps) {
  return (
    <Box flexDirection="column" gap={1}>
      {dryRun && (
        <Box>
          <Text backgroundColor="yellow" color="black">{' DRY RUN '}</Text>
          <Text dimColor> no files will be written</Text>
        </Box>
      )}
      {children}
      {showLegend && (
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Space select (multi) · Enter confirm · Esc back · Ctrl+C cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}
