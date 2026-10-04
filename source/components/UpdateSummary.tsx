import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import MovedFilesList from './MovedFilesList.js';
import type { UpdateSummary as Summary } from '../core/update-executor.js';
import type { HookOutcome } from '../core/hook-orchestrator.js';

/**
 * Final update report.
 *
 * Shows the version delta, per-category counts, the files the update
 * replaced (by path, #153), conflict-resolution breakdown, migration
 * warnings, and the post-update hook outcome.
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
  hooks: HookOutcome[];
  dryRun?: boolean;
  /** Vault-relative snapshot dir (previous bytes under its `files/`); `null` in a dry run. */
  backupDir?: string | null;
}

/** Paths shown before the "…and K more" line, as for install's backup list. */
const PATHS_VISIBLE = 10;

export default function UpdateSummary({
  summary,
  durationMs,
  migrationWarnings,
  hooks,
  dryRun,
  backupDir,
}: UpdateSummaryProps) {
  const seconds = (durationMs / 1000).toFixed(1);
  const c = summary.counts;
  // `silent` counts managed overwrites and noops together; the planner
  // counts the overwrite part separately so the line can say which is which.
  const replaced = [...summary.replacedFiles].sort();
  const unchanged = c.silent - c.overwritten;
  const untracked = summary.keptUntracked.length;
  const parts: string[] = [];
  if (c.overwritten) parts.push(`${c.overwritten} replaced`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (c.adopted) parts.push(`${c.adopted} adopted`);
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

      {replaced.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>
            {dryRun ? 'Would replace' : 'Replaced'} with the shard's version:
          </Text>
          {replaced.slice(0, PATHS_VISIBLE).map((p) => (
            <Text key={p}>  · {p}</Text>
          ))}
          {replaced.length > PATHS_VISIBLE && (
            <Text dimColor>  …and {replaced.length - PATHS_VISIBLE} more</Text>
          )}
          {dryRun ? (
            <Text dimColor>Full list: add --json to this command</Text>
          ) : (
            backupDir && <Text dimColor>Previous copies: {backupDir}/files/</Text>
          )}
        </Box>
      )}

      <MovedFilesList moves={summary.renamedFiles} dryRun={dryRun} />

      {untracked > 0 && (
        <Text dimColor>
          {untracked === 1
            ? '1 of your files sits at a path the new version adds and was kept untracked; it comes back each update. Choose Keep mine and track it at the prompt (without --yes), or re-run with --adopt-preexisting to track it.'
            : `${untracked} of your files sit at paths the new version adds and were kept untracked; they come back each update. Choose Keep mine and track it for each at the prompt (without --yes), or re-run with --adopt-preexisting to track them.`}
        </Text>
      )}

      {summary.conflictsResolved > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Conflict resolutions:</Text>
          <Text>
            {'  '}
            {summary.conflictsAcceptedNew} accepted new · {summary.conflictsKeptMine} kept mine ·{' '}
            {summary.conflictsSkipped} skipped
            {summary.conflictsEdited > 0 ? ` · ${summary.conflictsEdited} edited in your editor` : ''}
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

      <HookSummarySection outcomes={hooks} />
    </Box>
  );
}
