import { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import zod from 'zod';

import { Spinner, StatusMessage, Alert } from '../components/ui.js';
import { ShardMindError } from '../runtime/types.js';

import DiffView from '../components/DiffView.js';
import NewValuesPrompt from '../components/NewValuesPrompt.js';
import NewModulesReview from '../components/NewModulesReview.js';
import RemovedFilesReview from '../components/RemovedFilesReview.js';
import UpdateProgress from '../components/UpdateProgress.js';
import UpdateSummary from '../components/UpdateSummary.js';
import Header from '../components/Header.js';

import { useUpdateMachine } from './hooks/use-update-machine.js';

export const options = zod.object({
  yes: zod.boolean().default(false).describe('Accept defaults for every prompt (auto-keeps conflicts)'),
  verbose: zod.boolean().default(false).describe('Show per-file action history during write'),
  dryRun: zod.boolean().default(false).describe('Plan the update without touching the vault'),
});

type Props = {
  options: zod.infer<typeof options>;
};

export default function Update({ options }: Props) {
  const { yes, verbose, dryRun } = options;

  const {
    phase,
    onNewValuesComplete,
    onNewModulesComplete,
    onRemovedFilesComplete,
    onConflictChoice,
  } = useUpdateMachine({
    vaultRoot: process.cwd(),
    yes,
    verbose,
    dryRun,
  });

  if (phase.kind === 'booting' || phase.kind === 'loading') {
    const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
    return (
      <Frame dryRun={dryRun}>
        <Box gap={1}>
          <Spinner />
          <Text>{msg}</Text>
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'no-install') {
    return (
      <Frame dryRun={dryRun}>
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="warning">
            No shard installed in this directory.
          </StatusMessage>
          <Text dimColor>
            Run <Text bold>shardmind install &lt;shard&gt;</Text> first, then come back to update.
          </Text>
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'up-to-date') {
    return (
      <Frame dryRun={dryRun}>
        <Box flexDirection="column" gap={1}>
          <Header manifest={phase.manifest} />
          <StatusMessage variant="success">
            Already up to date at v{phase.state.version}.
          </StatusMessage>
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'prompt-new-values') {
    return (
      <Frame dryRun={dryRun}>
        <Header manifest={phase.ctx.newManifest} />
        <NewValuesPrompt
          schema={phase.ctx.newSchema}
          keys={phase.ctx.newRequiredKeys}
          existingValues={phase.ctx.migratedValues}
          onComplete={onNewValuesComplete}
        />
      </Frame>
    );
  }

  if (phase.kind === 'prompt-new-modules') {
    return (
      <Frame dryRun={dryRun}>
        <Header manifest={phase.ctx.newManifest} />
        <NewModulesReview
          offered={phase.ctx.newOptionalModules}
          onSubmit={onNewModulesComplete}
        />
      </Frame>
    );
  }

  if (phase.kind === 'prompt-removed-files') {
    return (
      <Frame dryRun={dryRun}>
        <Header manifest={phase.ctx.newManifest} />
        <RemovedFilesReview
          paths={phase.paths}
          onSubmit={onRemovedFilesComplete}
        />
      </Frame>
    );
  }

  if (phase.kind === 'resolving-conflicts') {
    const pending = phase.plan.pendingConflicts[phase.currentIndex];
    if (!pending) return null;
    return (
      <Frame dryRun={dryRun}>
        <DiffView
          path={pending.path}
          index={phase.currentIndex + 1}
          total={phase.plan.pendingConflicts.length}
          result={pending.result}
          onChoice={onConflictChoice}
        />
      </Frame>
    );
  }

  if (phase.kind === 'writing') {
    return (
      <Frame dryRun={dryRun} showLegend={false}>
        <UpdateProgress
          current={phase.current}
          total={phase.total}
          label={phase.label}
          verbose={verbose}
          history={phase.history}
        />
      </Frame>
    );
  }

  if (phase.kind === 'summary') {
    return (
      <Frame dryRun={dryRun} showLegend={false}>
        <UpdateSummary
          summary={phase.summary}
          durationMs={phase.durationMs}
          migrationWarnings={phase.migrationWarnings}
          hookOutput={phase.hook}
          dryRun={phase.dryRun}
        />
      </Frame>
    );
  }

  if (phase.kind === 'cancelled') {
    return (
      <Frame dryRun={dryRun} showLegend={false}>
        <Box flexDirection="column">
          <Alert variant="info">Cancelled</Alert>
          <Text dimColor>{phase.reason}</Text>
        </Box>
      </Frame>
    );
  }

  const err = phase.error;
  const code = err instanceof ShardMindError ? err.code : null;
  const hint = err instanceof ShardMindError ? err.hint : null;
  return (
    <Frame dryRun={dryRun} showLegend={false}>
      <Box flexDirection="column" gap={1}>
        <StatusMessage variant="error">{err.message}</StatusMessage>
        {code && <Text dimColor>code: {code}</Text>}
        {hint && <Text>{hint}</Text>}
        {phase.detail && <Text dimColor>{phase.detail}</Text>}
      </Box>
    </Frame>
  );
}

function Frame({
  children,
  dryRun,
  showLegend = true,
}: {
  children: ReactNode;
  dryRun: boolean;
  showLegend?: boolean;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      {dryRun && (
        <Box>
          <Text backgroundColor="yellow" color="black">{' DRY RUN '}</Text>
          <Text dimColor> no files will be written</Text>
        </Box>
      )}
      {children}
      {showLegend && (
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Space select (multi) · Enter confirm · Esc back · Ctrl+C cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}

export const description = 'Update the installed shard to its latest version';
