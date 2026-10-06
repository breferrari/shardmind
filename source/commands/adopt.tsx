import { Box, Text } from 'ink';
import type zod from 'zod';

import { assertNever } from '../runtime/types.js';
import ErrorView from '../components/ErrorView.js';
import { resolveEngineVersion } from './hooks/cli-version.js';

import { Spinner, Alert } from '../components/ui.js';
import AdoptValuesGate from '../components/AdoptValuesGate.js';
import AdoptModePicker from '../components/AdoptModePicker.js';
import AdoptDiffView from '../components/AdoptDiffView.js';
import AdoptSummary from '../components/AdoptSummary.js';
import CommandFrame from '../components/CommandFrame.js';
import CommandProgress from '../components/CommandProgress.js';
import HookProgress from '../components/HookProgress.js';

import { useAdoptMachine } from './hooks/use-adopt-machine.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';

// Ink-free, so the headless `--json` run parses with the same args and options (#302).
import { args, options } from './options/adopt.js';

export { args, options };

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function Adopt({ args, options }: Props) {
  const [shardRef] = args;
  // `--json` never reaches this component: cli.ts answers it headless (#302).
  const { values: valuesFile, yes, mode, fromVersion, verbose, dryRun, updateCheck } = options;

  const {
    phase,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onModeSelect,
    onDiffChoice,
  } = useAdoptMachine({
    shardRef: shardRef!,
    valuesFile,
    yes,
    mode,
    fromVersion,
    verbose,
    dryRun,
    vaultRoot: process.cwd(),
  });

  const { banner } = useSelfUpdateBanner({ updateCheck });

  // Exhaustive switch: adding a new Phase variant without a case here is
  // a compile error, not a silent render-nothing bug.
  switch (phase.kind) {
    case 'booting':
    case 'loading': {
      const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <Box gap={1}>
            <Spinner />
            <Text>{msg}</Text>
          </Box>
        </CommandFrame>
      );
    }
    case 'wizard':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          {/* Adopt opens on a values confirm-or-override page (#104)
              instead of the full install wizard: the user already has a
              populated vault, so a single "here's what will drive
              classification" page beats a fresh-install-style interview.
              "Override individually" inside the gate drops into the
              InstallWizard for per-value + module editing. */}
          <AdoptValuesGate
            manifest={phase.ctx.manifest}
            schema={phase.ctx.schema}
            prefillValues={phase.ctx.prefillValues}
            onComplete={onWizardComplete}
            onCancel={onWizardCancel}
            onError={onWizardError}
          />
        </CommandFrame>
      );
    case 'planning':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <Box gap={1}>
            <Spinner />
            <Text>Comparing your vault with the shard…</Text>
          </Box>
        </CommandFrame>
      );
    case 'mode-select':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <AdoptModePicker
            differsCount={phase.plan.differs.length}
            onSelect={onModeSelect}
          />
        </CommandFrame>
      );
    case 'diff-review': {
      const target = phase.queue[phase.currentIndex];
      if (!target || target.kind !== 'differs') return null;
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <AdoptDiffView
            path={target.path}
            index={phase.currentIndex + 1}
            total={phase.queue.length}
            shardContent={target.shardContent}
            userContent={target.userContent}
            isBinary={target.isBinary}
            onChoice={onDiffChoice}
          />
        </CommandFrame>
      );
    }
    case 'executing':
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
          <AdoptSummary
            manifest={phase.manifest}
            vaultRoot={phase.vaultRoot}
            summary={phase.summary}
            durationMs={phase.durationMs}
            hooks={phase.hooks}
            dryRun={phase.dryRun}
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

export const description =
  'Adopt the engine into a vault that was already cloned without shardmind';
