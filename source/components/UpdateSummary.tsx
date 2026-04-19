import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import type { UpdateSummary as Summary } from '../core/update-executor.js';

interface UpdateSummaryProps {
  summary: Summary;
  durationMs: number;
  migrationWarnings: string[];
  hookOutput: { deferred?: boolean; stdout?: string; exitCode?: number } | null;
  dryRun?: boolean;
}

export default function UpdateSummary({
  summary,
  durationMs,
  migrationWarnings,
  hookOutput,
  dryRun,
}: UpdateSummaryProps) {
  const seconds = (durationMs / 1000).toFixed(1);
  const c = summary.counts;
  const parts: string[] = [];
  if (c.silent) parts.push(`${c.silent} silent`);
  if (c.autoMerged) parts.push(`${c.autoMerged} auto-merged`);
  if (c.conflicts) parts.push(`${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'}`);
  if (c.added) parts.push(`${c.added} added`);
  if (c.deleted) parts.push(`${c.deleted} deleted`);
  if (c.keptAsUser) parts.push(`${c.keptAsUser} kept as yours`);
  if (c.restored) parts.push(`${c.restored} restored`);
  if (c.volatile) parts.push(`${c.volatile} volatile preserved`);

  const title = dryRun
    ? `Dry run: would update ${summary.fromVersion} → ${summary.toVersion}`
    : `Updated ${summary.fromVersion} → ${summary.toVersion} in ${seconds}s`;

  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant={dryRun ? 'info' : 'success'}>{title}</StatusMessage>

      <Box flexDirection="column">
        <Text dimColor>Changes:</Text>
        <Text>  {parts.length === 0 ? '(nothing changed)' : parts.join(' · ')}</Text>
      </Box>

      {summary.conflictsResolved > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Conflict resolutions:</Text>
          <Text>
            {'  '}
            {summary.conflictsAcceptedNew} accepted new · {summary.conflictsKeptMine} kept mine ·{' '}
            {summary.conflictsSkipped} skipped
          </Text>
        </Box>
      )}

      {migrationWarnings.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="yellow">Migration warnings:</Text>
          {migrationWarnings.slice(0, 8).map((w, i) => (
            <Text key={i} dimColor>· {w}</Text>
          ))}
          {migrationWarnings.length > 8 && (
            <Text dimColor>  …and {migrationWarnings.length - 8} more</Text>
          )}
        </Box>
      )}

      {hookOutput?.deferred && (
        <Box flexDirection="column">
          <Text color="yellow">Post-update hook detected but not executed.</Text>
          <Text dimColor>Hook runtime is deferred (see #30).</Text>
        </Box>
      )}

      {hookOutput?.stdout && (
        <Box flexDirection="column">
          <Text bold>Post-update output:</Text>
          <Text>{hookOutput.stdout}</Text>
        </Box>
      )}
    </Box>
  );
}
