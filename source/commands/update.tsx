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
import CommandFrame from '../components/CommandFrame.js';
import Header from '../components/Header.js';

import { useUpdateMachine } from './hooks/use-update-machine.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';

// Ink-free, so the headless `--json` run parses with the same options (#302).
import { options } from './options/update.js';

export { options };

type Props = {
  options: zod.infer<typeof options>;
};

export default function Update({ options }: Props) {
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
    yes,
    verbose,
    dryRun,
    release,
    includePrerelease,
    adoptPreexisting,
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
          </Box>
        </CommandFrame>
      );
    case 'prompt-new-values':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
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
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <Header manifest={phase.ctx.newManifest} />
          <NewModulesReview
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
          <DiffView
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

export const description = 'Update the installed shard to its latest version';
