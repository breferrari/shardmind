import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import type { UpdateSummary as Summary } from '../core/update-executor.js';
import type { HookSummary } from '../core/hook.js';

/**
 * Final update report.
 *
 * Shows the version delta, per-category counts, conflict-resolution
 * breakdown, migration warnings, and the post-update hook outcome.
 *
 * The hook section is delegated to `HookSummarySection` — the same
 * component `Summary.tsx` uses — so the four-branch rendering
 * (absent / deferred / success / warning) can't drift between install
 * and update views. Update success is independent of the hook outcome
 * (Helm semantics, per ARCHITECTURE.md §9.3) — a failing hook does not
 * roll back the update.
 */
interface UpdateSummaryProps {
  summary: Summary;
  durationMs: number;
  migrationWarnings: string[];
  hookOutput: HookSummary | null;
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

      <HookSummarySection stage="post-update" hookOutput={hookOutput} />
    </Box>
  );
}
