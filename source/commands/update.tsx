import { Box, Text } from 'ink';
import type zod from 'zod';

import { Spinner, StatusMessage, Alert } from '../components/ui.js';
import { assertNever } from '../runtime/types.js';
import ErrorView from '../components/ErrorView.js';
import { resolveEngineVersion } from './hooks/cli-version.js';

import DiffView from '../components/DiffView.js';
import NewValuesPrompt from '../components/NewValuesPrompt.js';
import NewModulesReview from '../components/NewModulesReview.js';
import RemovedFilesReview from '../components/RemovedFilesReview.js';
import CommandProgress from '../components/CommandProgress.js';
import HookProgress from '../components/HookProgress.js';
import UpdateSummary from '../components/UpdateSummary.js';
import UpdateShardsSummary from '../components/UpdateShardsSummary.js';
import HookSummarySection from '../components/HookSummarySection.js';
import ExternalToolsSection from '../components/ExternalToolsSection.js';
import CommandFrame from '../components/CommandFrame.js';
import Header from '../components/Header.js';

import { useUpdateMachine } from './hooks/use-update-machine.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';

// Ink-free, so the headless `--json` run parses with the same args and options (#302).
import { args, options } from './options/update.js';

export { args, options };

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function Update({ args, options }: Props) {
  const [shard] = args;
  // `--json` never reaches this component: cli.ts answers it headless (#302).
  const { yes, verbose, dryRun, release, includePrerelease, adoptPreexisting, updateCheck } = options;

  const {
    phase,
    onNewValuesComplete,
    onNewModulesComplete,
    onRemovedFilesComplete,
    onConflictChoice,
    canEdit,
  } = useUpdateMachine({
    vaultRoot: process.cwd(),
    shard,
    yes,
    verbose,
    dryRun,
    release,
    includePrerelease,
    adoptPreexisting,
    skipHooks: options.skipHooks,
  });

  const { banner } = useSelfUpdateBanner({ updateCheck });

  switch (phase.kind) {
    case 'booting':
    case 'loading': {
      const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <Box gap={1}>
            <Spinner />
            <Text>{msg}</Text>
          </Box>
        </CommandFrame>
      );
    }
    case 'up-to-date':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <Box flexDirection="column" gap={1}>
            <Header manifest={phase.manifest} />
            <StatusMessage variant="success">
              Already up to date at v{phase.state.version}.
            </StatusMessage>
            {/* An owed bootstrap (#199) the run ran, previewed (dry run) or skipped (--skip-hooks), shown as any summary shows hooks. */}
            {phase.hooks.length > 0 && <HookSummarySection outcomes={phase.hooks} />}
            <ExternalToolsSection lines={phase.externalTools} />
          </Box>
        </CommandFrame>
      );
    case 'prompt-new-values':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <Header manifest={phase.ctx.newManifest} />
          <NewValuesPrompt
            key={phase.ctx.target.label}
            schema={phase.ctx.newSchema}
            keys={phase.ctx.newRequiredKeys}
            existingValues={phase.ctx.migratedValues}
            onComplete={onNewValuesComplete}
          />
        </CommandFrame>
      );
    case 'prompt-new-modules':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <Header manifest={phase.ctx.newManifest} />
          <NewModulesReview
            key={phase.ctx.target.label}
            offered={phase.ctx.newOptionalModules}
            onSubmit={onNewModulesComplete}
          />
        </CommandFrame>
      );
    case 'prompt-removed-files':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <Header manifest={phase.ctx.newManifest} />
          <RemovedFilesReview
            key={phase.ctx.target.label}
            paths={phase.paths}
            onSubmit={onRemovedFilesComplete}
          />
        </CommandFrame>
      );
    case 'resolving-conflicts': {
      const pending = phase.plan.pendingConflicts[phase.currentIndex];
      if (!pending) return null;
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          {/* Several shards (#407): whose conflict this is. */}
          {phase.ctx.target.label !== undefined && <Text bold>{phase.ctx.target.label}</Text>}
          <DiffView
            key={phase.ctx.target.label}
            path={pending.path}
            index={phase.currentIndex + 1}
            total={phase.plan.pendingConflicts.length}
            result={pending.result}
            preexisting={pending.preexisting}
            adoptPreexisting={adoptPreexisting}
            canEdit={canEdit}
            editNote={phase.edit?.note}
            editHasMarkers={phase.edit?.pendingContent !== undefined}
            attempt={phase.edit?.attempt ?? 0}
            onChoice={onConflictChoice}
          />
        </CommandFrame>
      );
    }
    case 'writing':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
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
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <HookProgress
            stage={phase.stage}
            output={phase.output}
            shardLabel={phase.shardLabel}
            index={phase.index}
            total={phase.total}
          />
        </CommandFrame>
      );
    case 'summary':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <UpdateSummary
            summary={phase.summary}
            durationMs={phase.durationMs}
            migrationWarnings={phase.migrationWarnings}
            hooks={phase.hooks}
            dryRun={phase.dryRun}
            backupDir={phase.backupDir}
            externalTools={phase.externalTools}
          />
        </CommandFrame>
      );
    case 'shards':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <UpdateShardsSummary runs={phase.runs} dryRun={phase.dryRun} version={resolveEngineVersion()} />
        </CommandFrame>
      );
    case 'cancelled':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <Box flexDirection="column">
            <Alert variant="info">Cancelled</Alert>
            <Text dimColor>{phase.reason}</Text>
          </Box>
        </CommandFrame>
      );
    case 'error':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <ErrorView error={phase.error} detail={phase.detail} version={resolveEngineVersion()} />
        </CommandFrame>
      );
    default:
      return assertNever(phase);
  }
}

export const description = 'Update every shard in the vault to its latest version, or the one named';
