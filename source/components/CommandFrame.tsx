import { type ReactNode } from 'react';
import { Box, Text, useStdin, useStdout } from 'ink';

/**
 * Outer shell for a top-level command (install, update). Renders the
 * dry-run banner above children and the keyboard-legend hint below,
 * so command files only own their phase content — not the chrome.
 *
 * `selfUpdateBanner` is reserved for the engine self-update notifier
 * (#113): the command renders a `<SelfUpdateBanner>` and passes it
 * through, and CommandFrame paints it as the very first child above
 * the dry-run banner. Stays optional so legacy call sites and tests
 * not concerned with the notifier render unchanged.
 *
 * The legend shows only on a terminal: stdin to press the keys, stdout to
 * see the prompt. With either piped (`update --yes > log`, CI) there is
 * nothing to navigate, and it would only pollute captured output (#381).
 */
interface CommandFrameProps {
  children: ReactNode;
  dryRun: boolean;
  showLegend?: boolean;
  selfUpdateBanner?: ReactNode;
}

export default function CommandFrame({
  children,
  dryRun,
  showLegend = true,
  selfUpdateBanner,
}: CommandFrameProps) {
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const onTerminal = Reflect.get(stdout, 'isTTY') === true && Reflect.get(stdin, 'isTTY') === true;
  return (
    <Box flexDirection="column" gap={1}>
      {selfUpdateBanner}
      {dryRun && (
        <Box>
          <Text backgroundColor="yellow" color="black">{' DRY RUN '}</Text>
          <Text dimColor> no files will be written</Text>
        </Box>
      )}
      {children}
      {showLegend && onTerminal && (
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Space select (multi) · Enter confirm · Esc back · Ctrl+C cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}
