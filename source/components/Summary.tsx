import os from 'node:os';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import type { ShardManifest } from '../runtime/types.js';
import type { BackupRecord } from '../core/install-executor.js';
import type { HookSummary } from '../commands/hooks/shared.js';

/**
 * Final install report.
 *
 * Renders the count of installed files, any pre-install backups that
 * were taken to avoid overwriting user content, and the post-install
 * hook outcome with separate stdout / stderr blocks when present.
 *
 * The hook section is a four-way render keyed off the `HookSummary`
 * produced by `summarizeHook` in `commands/hooks/shared.ts`:
 *
 *   - null           — hook was never declared OR this was a dry run;
 *                      nothing rendered.
 *   - deferred       — hook exists but execution was suppressed (e.g.
 *                      --dry-run explicitly asked); dim "skipped" note.
 *   - ran, exit 0    — hook completed cleanly; "completed" headline +
 *                      captured stdout + stderr (labeled, only if
 *                      non-empty).
 *   - ran, exit !=0  — hook ran but exited non-zero (or timed out /
 *                      cancelled / threw); yellow warning with exit
 *                      code + both captured streams.
 *
 * Install success is independent of the hook outcome (Helm semantics,
 * per ARCHITECTURE.md §9.3) — a failing hook does not roll back the
 * install; it surfaces here as a warning.
 */
interface SummaryProps {
  manifest: ShardManifest;
  vaultRoot: string;
  fileCount: number;
  durationMs: number;
  backups: BackupRecord[];
  hookOutput: HookSummary | null;
  dryRun?: boolean;
}

export default function Summary({
  manifest,
  vaultRoot,
  fileCount,
  durationMs,
  backups,
  hookOutput,
  dryRun,
}: SummaryProps) {
  const seconds = (durationMs / 1000).toFixed(1);
  const openCmd = openCommandForPlatform(vaultRoot);

  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant={dryRun ? 'info' : 'success'}>
        {dryRun
          ? `Dry run complete — ${fileCount} files would be written`
          : `Installed ${manifest.namespace}/${manifest.name}@${manifest.version} — ${fileCount} files in ${seconds}s`}
      </StatusMessage>

      {backups.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Backed up {backups.length} existing file{backups.length === 1 ? '' : 's'}:</Text>
          {backups.slice(0, 10).map((b) => (
            <Text key={b.originalPath} dimColor>
              · {b.backupPath}
            </Text>
          ))}
          {backups.length > 10 && <Text dimColor>  …and {backups.length - 10} more</Text>}
        </Box>
      )}

      {renderHookSection(hookOutput)}

      {!dryRun && (
        <Box flexDirection="column">
          <Text bold>Next:</Text>
          <Text>  {openCmd}</Text>
        </Box>
      )}
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
        <Text dimColor>Post-install hook skipped (dry run).</Text>
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
        <Text color="green">Post-install hook completed.</Text>
      ) : (
        <StatusMessage variant="warning">
          Post-install hook exited with code {exitCode}. Install succeeded; the hook's work may be incomplete.
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

function openCommandForPlatform(vaultRoot: string): string {
  const platform = os.platform();
  if (platform === 'darwin') return `open "${vaultRoot}"`;
  if (platform === 'win32') return `start "" "${vaultRoot}"`;
  return `xdg-open "${vaultRoot}"`;
}
