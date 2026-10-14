import { Box } from 'ink';
import { StatusMessage } from './ui.js';
import HookSummarySection from './HookSummarySection.js';
import ExternalToolsSection from './ExternalToolsSection.js';
import type { HookOutcome } from '../core/hook-orchestrator.js';

/**
 * An update with nothing to update: the installed version, and any owed
 * bootstrap (#199) the run ran, previewed (dry run) or skipped
 * (--skip-hooks), shown as any summary shows hooks. Shared by a one-shard
 * update and each shard's block of an update across several (#407).
 */
interface UpToDateSummaryProps {
  version: string;
  hooks: readonly HookOutcome[];
  externalTools: readonly string[];
}

export default function UpToDateSummary({ version, hooks, externalTools }: UpToDateSummaryProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant="success">Already up to date at v{version}.</StatusMessage>
      {hooks.length > 0 && <HookSummarySection outcomes={[...hooks]} />}
      <ExternalToolsSection lines={externalTools} />
    </Box>
  );
}
