import os from 'node:os';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import ExternalToolsSection from './ExternalToolsSection.js';
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
  /** The folder the install made or was given, as written; null in place (`.`, #333). */
  folder?: string | null;
  fileCount: number;
  durationMs: number;
  backups: BackupRecord[];
  /** Vault-relative paths replaced with no backup: Overwrite or `--force` (#55). */
  replaced: string[];
  /** Files the previous install wrote that the shard no longer has, untouched: removed (#228). */
  removed?: string[];
  /** The same, edited by the user: kept, and theirs from now on (#228). */
  keptStale?: string[];
  hooks: HookOutcome[];
  /** Unmet optional tools, or the dry-run note (#138); from `checkExternalToolsForRun`. */
  externalTools?: readonly string[];
  dryRun?: boolean;
}

export default function Summary({
  manifest,
  vaultRoot,
  folder = null,
  fileCount,
  durationMs,
  backups,
  replaced,
  removed = [],
  keptStale = [],
  hooks,
  externalTools = [],
  dryRun,
}: SummaryProps) {
  const seconds = (durationMs / 1000).toFixed(1);
  const openCmd = openCommandForPlatform(vaultRoot);

  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant={dryRun ? 'info' : 'success'}>
        {dryRun
          ? `Dry run complete — ${fileCount} files would be written${folder === null ? '' : ` into ${folder}`}`
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

      <PathList
        title={`${dryRun ? 'Would remove' : 'Removed'} ${fileCountLabel(removed.length, '')} the shard no longer has:`}
        paths={removed}
      />

      <PathList
        title={`${dryRun ? 'Would keep' : 'Kept'} ${fileCountLabel(keptStale.length, '')} you edited that the shard no longer has; ${keptStale.length === 1 ? "it's" : "they're"} yours now:`}
        paths={keptStale}
      />

      <ExternalToolsSection lines={externalTools} />

      <HookSummarySection outcomes={hooks} />

      {!dryRun && (
        <Box flexDirection="column">
          {folder !== null && <Text>Your vault is in {vaultRoot}</Text>}
          <Text bold>Next:</Text>
          {folder !== null && <Text>  {cdCommand(folder)}</Text>}
          <Text>  {openCmd}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Paths shown before the "…and K more" line. */
const PATHS_VISIBLE = 10;

function fileCountLabel(n: number, adjective = 'existing'): string {
  return `${n} ${adjective ? `${adjective} ` : ''}file${n === 1 ? '' : 's'}`;
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

/** `cd` into the folder as written, quoted when the shell would split it. */
function cdCommand(folder: string): string {
  return /^[\w./@+-]+$/.test(folder) ? `cd ${folder}` : `cd "${folder}"`;
}

function openCommandForPlatform(vaultRoot: string): string {
  const platform = os.platform();
  if (platform === 'darwin') return `open "${vaultRoot}"`;
  if (platform === 'win32') return `start "" "${vaultRoot}"`;
  return `xdg-open "${vaultRoot}"`;
}
