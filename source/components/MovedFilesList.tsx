import { Box, Text } from 'ink';

/** Moves shown before the "…and K more" line, as for the other path lists. */
const PATHS_VISIBLE = 10;

/**
 * The files a rename migration moved to a new path, shared by the update
 * (#178) and adopt (#179) summaries. Renders nothing when nothing moved.
 */
export default function MovedFilesList({
  moves,
  dryRun,
}: {
  moves: ReadonlyArray<{ from: string; to: string }>;
  dryRun?: boolean;
}) {
  if (moves.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor>{dryRun ? 'Would move' : 'Moved'} to a new path:</Text>
      {moves.slice(0, PATHS_VISIBLE).map(({ from, to }) => (
        <Text key={to}>  · {from} → {to}</Text>
      ))}
      {moves.length > PATHS_VISIBLE && (
        <Text dimColor>  …and {moves.length - PATHS_VISIBLE} more</Text>
      )}
    </Box>
  );
}
