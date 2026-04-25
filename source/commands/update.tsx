import { Box, Text } from 'ink';
import zod from 'zod';

import { Spinner, StatusMessage, Alert } from '../components/ui.js';
import { ShardMindError, assertNever } from '../runtime/types.js';

import DiffView from '../components/DiffView.js';
import NewValuesPrompt from '../components/NewValuesPrompt.js';
import NewModulesReview from '../components/NewModulesReview.js';
import RemovedFilesReview from '../components/RemovedFilesReview.js';
import CommandProgress from '../components/CommandProgress.js';
import HookProgress from '../components/HookProgress.js';
import UpdateSummary from '../components/UpdateSummary.js';
import CommandFrame from '../components/CommandFrame.js';
import Header from '../components/Header.js';

import { useUpdateMachine } from './hooks/use-update-machine.js';

export const options = zod.object({
  yes: zod.boolean().default(false).describe('Accept defaults for every prompt (auto-keeps conflicts)'),
  verbose: zod.boolean().default(false).describe('Show per-file action history during write'),
  dryRun: zod.boolean().default(false).describe('Plan the update without touching the vault'),
  // Named `--release <v>` because Pastel reserves the program-level
  // `--version` for "print package version" (`shardmind --version`).
  // Trying to expose `update --version 0.2.0` would silently print the
  // package version and exit. `--release` matches GitHub's terminology
  // for tagged releases and avoids the collision.
  release: zod
    .string()
    .optional()
    .describe('Pin the update to a specific shard release tag (stable or prerelease)'),
  includePrerelease: zod
    .boolean()
    .default(false)
    .describe('Widen latest-release resolution to include prereleases'),
});

type Props = {
  options: zod.infer<typeof options>;
};

export default function Update({ options }: Props) {
  const { yes, verbose, dryRun, release, includePrerelease } = options;

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
    release,
    includePrerelease,
  });

  switch (phase.kind) {
    case 'booting':
    case 'loading': {
      const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
      return (
        <CommandFrame dryRun={dryRun}>
          <Box gap={1}>
            <Spinner />
            <Text>{msg}</Text>
          </Box>
        </CommandFrame>
      );
    }
    case 'up-to-date':
      return (
        <CommandFrame dryRun={dryRun}>
          <Box flexDirection="column" gap={1}>
            <Header manifest={phase.manifest} />
            <StatusMessage variant="success">
              Already up to date at v{phase.state.version}.
            </StatusMessage>
          </Box>
        </CommandFrame>
      );
    case 'prompt-new-values':
      return (
        <CommandFrame dryRun={dryRun}>
          <Header manifest={phase.ctx.newManifest} />
          <NewValuesPrompt
            schema={phase.ctx.newSchema}
            keys={phase.ctx.newRequiredKeys}
            existingValues={phase.ctx.migratedValues}
            onComplete={onNewValuesComplete}
          />
        </CommandFrame>
      );
    case 'prompt-new-modules':
      return (
        <CommandFrame dryRun={dryRun}>
          <Header manifest={phase.ctx.newManifest} />
          <NewModulesReview
            offered={phase.ctx.newOptionalModules}
            onSubmit={onNewModulesComplete}
          />
        </CommandFrame>
      );
    case 'prompt-removed-files':
      return (
        <CommandFrame dryRun={dryRun}>
          <Header manifest={phase.ctx.newManifest} />
          <RemovedFilesReview
            paths={phase.paths}
            onSubmit={onRemovedFilesComplete}
          />
        </CommandFrame>
      );
    case 'resolving-conflicts': {
      const pending = phase.plan.pendingConflicts[phase.currentIndex];
      if (!pending) return null;
      return (
        <CommandFrame dryRun={dryRun}>
          <DiffView
            path={pending.path}
            index={phase.currentIndex + 1}
            total={phase.plan.pendingConflicts.length}
            result={pending.result}
            onChoice={onConflictChoice}
          />
        </CommandFrame>
      );
    }
    case 'writing':
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
    case 'running-hook':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false}>
          <HookProgress
            stage={phase.stage}
            output={phase.output}
            shardLabel={phase.shardLabel}
          />
        </CommandFrame>
      );
    case 'summary':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false}>
          <UpdateSummary
            summary={phase.summary}
            durationMs={phase.durationMs}
            migrationWarnings={phase.migrationWarnings}
            hookOutput={phase.hook}
            dryRun={phase.dryRun}
          />
        </CommandFrame>
      );
    case 'cancelled':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false}>
          <Box flexDirection="column">
            <Alert variant="info">Cancelled</Alert>
            <Text dimColor>{phase.reason}</Text>
          </Box>
        </CommandFrame>
      );
    case 'error': {
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
    default:
      return assertNever(phase);
  }
}

export const description = 'Update the installed shard to its latest version';
