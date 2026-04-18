import os from 'node:os';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import type { ShardManifest } from '../runtime/types.js';
import type { BackupRecord } from '../core/install-executor.js';

interface SummaryProps {
  manifest: ShardManifest;
  vaultRoot: string;
  fileCount: number;
  durationMs: number;
  backups: BackupRecord[];
  hookOutput: { deferred?: boolean; stdout?: string; exitCode?: number } | null;
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

      {hookOutput?.deferred && (
        <Box flexDirection="column">
          <Text color="yellow">Post-install hook detected but not executed.</Text>
          <Text dimColor>
            Hook runtime is deferred (see #30). Install succeeded without running it.
          </Text>
        </Box>
      )}

      {hookOutput?.stdout && (
        <Box flexDirection="column">
          <Text bold>Post-install output:</Text>
          <Text>{hookOutput.stdout}</Text>
        </Box>
      )}

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
