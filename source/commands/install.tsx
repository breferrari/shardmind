import { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { Spinner, StatusMessage, Alert } from '@inkjs/ui';
import zod from 'zod';

import { ShardMindError } from '../runtime/types.js';

import InstallWizard from '../components/InstallWizard.js';
import CollisionReview from '../components/CollisionReview.js';
import ExistingInstallGate from '../components/ExistingInstallGate.js';
import InstallProgress from '../components/InstallProgress.js';
import Summary from '../components/Summary.js';

import { useInstallMachine } from './hooks/use-install-machine.js';

export const args = zod.tuple([
  zod.string().describe('Shard reference, e.g. "breferrari/obsidian-mind" or "github:owner/repo"'),
]);

export const options = zod.object({
  values: zod.string().optional().describe('Path to a YAML file prefilling value answers'),
  yes: zod.boolean().default(false).describe('Skip all prompts; accept defaults for everything'),
  verbose: zod.boolean().default(false).describe('Show per-file rendering progress'),
  dryRun: zod.boolean().default(false).describe('Preview what would be installed without writing'),
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function Install({ args, options }: Props) {
  const [shardRef] = args;
  const { values: valuesFile, yes, verbose, dryRun } = options;

  const {
    phase,
    onGateChoice,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onCollisionChoice,
  } = useInstallMachine({
    shardRef: shardRef!,
    valuesFile,
    yes,
    verbose,
    dryRun,
    vaultRoot: process.cwd(),
  });

  if (phase.kind === 'booting' || phase.kind === 'loading') {
    const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
    return (
      <RootFrame dryRun={dryRun} showLegend={false}>
        <Box gap={1}>
          <Spinner />
          <Text>{msg}</Text>
        </Box>
      </RootFrame>
    );
  }

  if (phase.kind === 'gate') {
    return (
      <RootFrame dryRun={dryRun}>
        <ExistingInstallGate state={phase.state} onChoice={onGateChoice} />
      </RootFrame>
    );
  }

  if (phase.kind === 'wizard') {
    return (
      <RootFrame dryRun={dryRun}>
        <InstallWizard
          manifest={phase.ctx.manifest}
          schema={phase.ctx.schema}
          prefillValues={phase.ctx.prefillValues}
          moduleFileCounts={phase.ctx.moduleFileCounts}
          alwaysIncludedFileCount={phase.ctx.alwaysIncludedFileCount}
          onComplete={onWizardComplete}
          onCancel={onWizardCancel}
          onError={onWizardError}
        />
      </RootFrame>
    );
  }

  if (phase.kind === 'collision') {
    return (
      <RootFrame dryRun={dryRun}>
        <CollisionReview collisions={phase.collisions} onChoice={onCollisionChoice} />
      </RootFrame>
    );
  }

  if (phase.kind === 'installing') {
    return (
      <RootFrame dryRun={dryRun} showLegend={false}>
        <InstallProgress
          current={phase.current}
          total={phase.total}
          label={phase.label}
          verbose={verbose}
          history={phase.history}
        />
      </RootFrame>
    );
  }

  if (phase.kind === 'summary') {
    return (
      <RootFrame dryRun={dryRun} showLegend={false}>
        <Summary
          manifest={phase.manifest}
          vaultRoot={phase.vaultRoot}
          fileCount={phase.fileCount}
          durationMs={phase.durationMs}
          backups={phase.backups}
          hookOutput={phase.hook}
          dryRun={phase.dryRun}
        />
      </RootFrame>
    );
  }

  if (phase.kind === 'cancelled') {
    return (
      <RootFrame dryRun={dryRun} showLegend={false}>
        <Box flexDirection="column">
          <Alert variant="info">Cancelled</Alert>
          <Text dimColor>{phase.reason}</Text>
        </Box>
      </RootFrame>
    );
  }

  const err = phase.error;
  const code = err instanceof ShardMindError ? err.code : null;
  const hint = err instanceof ShardMindError ? err.hint : null;
  return (
    <RootFrame dryRun={dryRun} showLegend={false}>
      <Box flexDirection="column" gap={1}>
        <StatusMessage variant="error">{err.message}</StatusMessage>
        {code && <Text dimColor>code: {code}</Text>}
        {hint && <Text>{hint}</Text>}
        {phase.detail && <Text dimColor>{phase.detail}</Text>}
      </Box>
    </RootFrame>
  );
}

function RootFrame({
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
          <Text backgroundColor="yellow" color="black">
            {' DRY RUN '}
          </Text>
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

export const description = 'Install a shard into the current directory';
