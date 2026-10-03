import os from 'node:os';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import type { ShardManifest } from '../runtime/types.js';
import type { BackupRecord } from '../core/install-executor.js';
import type { HookOutcome } from '../core/hook-orchestrator.js';

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
  /** Vault-relative paths replaced with no backup: Overwrite or `--force` (#55). */
  replaced?: string[];
  hooks: HookOutcome[];
  dryRun?: boolean;
}

export default function Summary({
  manifest,
  vaultRoot,
  fileCount,
  durationMs,
  backups,
  replaced = [],
  hooks,
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

      <PathList
        title={`Backed up ${fileCountLabel(backups.length)}:`}
        paths={backups.map((b) => b.backupPath)}
      />

      <PathList
        title={`${dryRun ? 'Would replace' : 'Replaced'} ${fileCountLabel(replaced.length)} (no backup):`}
        paths={replaced}
      />

      <HookSummarySection outcomes={hooks} />

      {!dryRun && (
        <Box flexDirection="column">
          <Text bold>Next:</Text>
          <Text>  {openCmd}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Paths shown before the "…and K more" line. */
const PATHS_VISIBLE = 10;

function fileCountLabel(n: number): string {
  return `${n} existing file${n === 1 ? '' : 's'}`;
}

/** A titled path list, truncated after `PATHS_VISIBLE`; renders nothing when empty. */
function PathList({ title, paths }: { title: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {paths.slice(0, PATHS_VISIBLE).map((p) => (
        <Text key={p} dimColor>
          · {p}
        </Text>
      ))}
      {paths.length > PATHS_VISIBLE && <Text dimColor>  …and {paths.length - PATHS_VISIBLE} more</Text>}
    </Box>
  );
}

function openCommandForPlatform(vaultRoot: string): string {
  const platform = os.platform();
  if (platform === 'darwin') return `open "${vaultRoot}"`;
  if (platform === 'win32') return `start "" "${vaultRoot}"`;
  return `xdg-open "${vaultRoot}"`;
}
