import { Box, Text } from 'ink';
import { Spinner } from './ui.js';

/**
 * Live display for the `running-hook` phase in the install and update
 * state machines. Shows a spinner + stage-aware heading + a tail of the
 * subprocess's most recent output so the user sees the hook is actually
 * doing work (e.g. `git init`, `qmd setup`, a package install).
 *
 * This is a tail view, not a full scrollback — the machine caps the
 * underlying buffer at 64 KB and the component renders only the last
 * ~12 lines. The complete captured output is shown post-hoc in the
 * install/update Summary once the hook exits.
 *
 * See docs/ARCHITECTURE.md §9.3 for the hook contract.
 */

const TAIL_LINES = 12;

interface HookProgressProps {
  stage: 'post-install' | 'post-update';
  output: string;
  shardLabel: string;
}

export default function HookProgress({ stage, output, shardLabel }: HookProgressProps) {
  const heading =
    stage === 'post-install'
      ? `Running post-install hook for ${shardLabel}…`
      : `Running post-update hook for ${shardLabel}…`;

  // Split on either LF or CRLF so Windows-authored hooks tail cleanly.
  // `filter(Boolean)` drops the trailing empty string the final newline
  // leaves behind so the tail doesn't waste a line.
  const lines = output.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(-TAIL_LINES);

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Spinner />
        <Text>{heading}</Text>
      </Box>
      {tail.length > 0 && (
        <Box flexDirection="column">
          {tail.map((line, i) => (
            <Text key={`${i}-${line}`} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
