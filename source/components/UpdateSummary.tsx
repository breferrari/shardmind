import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import type { UpdateSummary as Summary } from '../core/update-executor.js';
import type { HookSummary } from '../commands/hooks/shared.js';

/**
 * Final update report.
 *
 * Shows the version delta, per-category counts, conflict-resolution
 * breakdown, migration warnings, and the post-update hook outcome
 * with separate stdout / stderr blocks when present.
 *
 * The hook section is a four-way render keyed off the `HookSummary`
 * produced by `summarizeHook` in `commands/hooks/shared.ts`:
 *
 *   - null           — hook was never declared OR this was a dry run;
 *                      nothing rendered.
 *   - deferred       — hook exists but execution was suppressed (e.g.
 *                      --dry-run explicitly asked); dim "skipped" note.
 *   - ran, exit 0    — hook completed cleanly; green "completed"
 *                      headline + captured stdout + stderr (labeled,
 *                      only if non-empty).
 *   - ran, exit !=0  — hook ran but exited non-zero (or timed out /
 *                      cancelled / threw); yellow warning with exit
 *                      code + both captured streams.
 *
 * Update success is independent of the hook outcome (Helm semantics,
 * per ARCHITECTURE.md §9.3) — a failing hook does not roll back the
 * update; it surfaces here as a warning.
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

      {renderHookSection(hookOutput)}
    </Box>
  );
}

/**
 * Render the four possible hook outcomes. Returns `null` when there is
 * nothing to show (absent hook or dry run).
 */
function renderHookSection(hookOutput: HookSummary | null) {
  if (hookOutput === null) return null;

  if (hookOutput.deferred) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Post-update hook skipped (dry run).</Text>
      </Box>
    );
  }

  const exitCode = hookOutput.exitCode ?? 0;
  const succeeded = exitCode === 0;
  const stdout = hookOutput.stdout?.trim();
  const stderr = hookOutput.stderr?.trim();

  return (
    <Box flexDirection="column">
      {succeeded ? (
        <Text color="green">Post-update hook completed.</Text>
      ) : (
        <StatusMessage variant="warning">
          Post-update hook exited with code {exitCode}. Update succeeded; the hook's work may be incomplete.
        </StatusMessage>
      )}
      {stdout && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Hook stdout:</Text>
          <Text>{stdout}</Text>
        </Box>
      )}
      {stderr && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Hook stderr:</Text>
          <Text>{stderr}</Text>
        </Box>
      )}
    </Box>
  );
}
