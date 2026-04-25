import os from 'node:os';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import type { ShardManifest } from '../runtime/types.js';
import type { HookSummary } from '../core/hook.js';
import type { AdoptSummary as AdoptSummaryData } from '../core/adopt-executor.js';

/**
 * Final adopt report. Mirrors `Summary.tsx`'s shape (header line,
 * outcome counts, hook section, "next" command) but reports the four
 * adopt-specific buckets instead of install's "files in N seconds":
 *
 *   - matched-auto       (byte-equivalent → managed silently)
 *   - adopted as managed (use_shard decisions; user file overwritten)
 *   - kept as managed    (keep_mine decisions; user bytes recorded)
 *   - installed fresh    (shard-only paths; new bytes written)
 *
 * Counts add up to `state.files` length so the user has a precise sense
 * of how much of their vault is now under engine management. The hook
 * section is delegated to `HookSummarySection` (shared with Install /
 * Update Summary) — adopt fires the post-install hook, so `stage` is
 * `"post-install"`.
 *
 * Adopt success is independent of hook outcome (Helm semantics, per
 * ARCHITECTURE.md §9.3): a failing hook surfaces as a yellow warning in
 * the hook section but the engine still treats the adopt as complete.
 */
interface AdoptSummaryProps {
  manifest: ShardManifest;
  vaultRoot: string;
  summary: AdoptSummaryData;
  durationMs: number;
  hookOutput: HookSummary | null;
  dryRun?: boolean;
}

export default function AdoptSummary({
  manifest,
  vaultRoot,
  summary,
  durationMs,
  hookOutput,
  dryRun,
}: AdoptSummaryProps) {
  const seconds = (durationMs / 1000).toFixed(1);
  const openCmd = openCommandForPlatform(vaultRoot);

  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant={dryRun ? 'info' : 'success'}>
        {dryRun
          ? `Dry run complete — ${summary.totalManaged} files would be adopted`
          : `Adopted ${manifest.namespace}/${manifest.name}@${manifest.version} — ${summary.totalManaged} files in ${seconds}s`}
      </StatusMessage>

      <Box flexDirection="column">
        <Text bold>What happened:</Text>
        {summary.matchedAuto.length > 0 && (
          <Text>
            <Text color="green">  ✓ </Text>
            {summary.matchedAuto.length} matched the shard exactly (managed silently)
          </Text>
        )}
        {summary.adoptedMine.length > 0 && (
          <Text>
            <Text color="cyan">  → </Text>
            {summary.adoptedMine.length} kept your version (recorded as managed)
          </Text>
        )}
        {summary.adoptedShard.length > 0 && (
          <Text>
            <Text color="yellow">  ↻ </Text>
            {summary.adoptedShard.length} switched to the shard's version
          </Text>
        )}
        {summary.installedFresh.length > 0 && (
          <Text>
            <Text color="blue">  + </Text>
            {summary.installedFresh.length} installed fresh (file was missing)
          </Text>
        )}
        {summary.totalManaged === 0 && (
          <Text dimColor>  (no files adopted — empty plan)</Text>
        )}
      </Box>

      <HookSummarySection stage="post-install" hookOutput={hookOutput} />

      {!dryRun && (
        <Box flexDirection="column">
          <Text bold>Next:</Text>
          <Text>  {openCmd}</Text>
          <Text dimColor>  Run `shardmind` to verify status, or `shardmind update` when a new version ships.</Text>
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
