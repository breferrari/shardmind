import { Box, Text } from 'ink';
import { Spinner, StatusMessage, Alert } from '../components/ui.js';
import zod from 'zod';

import { ShardMindError } from '../runtime/types.js';

import InstallWizard from '../components/InstallWizard.js';
import CollisionReview from '../components/CollisionReview.js';
import ExistingInstallGate from '../components/ExistingInstallGate.js';
import CommandProgress from '../components/CommandProgress.js';
import Summary from '../components/Summary.js';
import CommandFrame from '../components/CommandFrame.js';

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
      <CommandFrame dryRun={dryRun} showLegend={false}>
        <Box gap={1}>
          <Spinner />
          <Text>{msg}</Text>
        </Box>
      </CommandFrame>
    );
  }

  if (phase.kind === 'gate') {
    return (
      <CommandFrame dryRun={dryRun}>
        <ExistingInstallGate state={phase.state} onChoice={onGateChoice} />
      </CommandFrame>
    );
  }

  if (phase.kind === 'wizard') {
    return (
      <CommandFrame dryRun={dryRun}>
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
      </CommandFrame>
    );
  }

  if (phase.kind === 'collision') {
    return (
      <CommandFrame dryRun={dryRun}>
        <CollisionReview collisions={phase.collisions} onChoice={onCollisionChoice} />
      </CommandFrame>
    );
  }

  if (phase.kind === 'installing') {
    return (
      <CommandFrame dryRun={dryRun} showLegend={false}>
        <CommandProgress
          current={phase.current}
          total={phase.total}
          label={phase.label}
          verbose={verbose}
          history={phase.history}
        />
      </CommandFrame>
    );
  }

  if (phase.kind === 'summary') {
    return (
      <CommandFrame dryRun={dryRun} showLegend={false}>
        <Summary
          manifest={phase.manifest}
          vaultRoot={phase.vaultRoot}
          fileCount={phase.fileCount}
          durationMs={phase.durationMs}
          backups={phase.backups}
          hookOutput={phase.hook}
          dryRun={phase.dryRun}
        />
      </CommandFrame>
    );
  }

  if (phase.kind === 'cancelled') {
    return (
      <CommandFrame dryRun={dryRun} showLegend={false}>
        <Box flexDirection="column">
          <Alert variant="info">Cancelled</Alert>
          <Text dimColor>{phase.reason}</Text>
        </Box>
      </CommandFrame>
    );
  }

  const err = phase.error;
  const code = err instanceof ShardMindError ? err.code : null;
  const hint = err instanceof ShardMindError ? err.hint : null;
  return (
    <CommandFrame dryRun={dryRun} showLegend={false}>
      <Box flexDirection="column" gap={1}>
        <StatusMessage variant="error">{err.message}</StatusMessage>
        {code && <Text dimColor>code: {code}</Text>}
        {hint && <Text>{hint}</Text>}
        {phase.detail && <Text dimColor>{phase.detail}</Text>}
      </Box>
    </CommandFrame>
  );
}

export const description = 'Install a shard into the current directory';
