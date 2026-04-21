import os from 'node:os';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import type { ShardManifest } from '../runtime/types.js';
import type { BackupRecord } from '../core/install-executor.js';
import type { HookSummary } from '../core/hook.js';

/**
 * Final install report.
 *
 * Renders the count of installed files, any pre-install backups that
 * were taken to avoid overwriting user content, and the post-install
 * hook outcome.
 *
 * The hook section is delegated to `HookSummarySection`, which is
 * shared with `UpdateSummary.tsx` so the four-branch rendering
 * (absent / deferred / success / warning) can't drift between the two
 * views. Install success is independent of the hook outcome (Helm
 * semantics, per ARCHITECTURE.md §9.3) — a failing hook does not roll
 * back the install; it surfaces as a warning in the hook section.
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

      <HookSummarySection stage="post-install" hookOutput={hookOutput} />

      {!dryRun && (
        <Box flexDirection="column">
          <Text bold>Next:</Text>
          <Text>  {openCmd}</Text>
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
