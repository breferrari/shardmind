import { Box, Text } from 'ink';
import zod from 'zod';

import { ShardMindError, assertNever } from '../runtime/types.js';

import { Spinner, StatusMessage, Alert } from '../components/ui.js';
import InstallWizard from '../components/InstallWizard.js';
import AdoptDiffView from '../components/AdoptDiffView.js';
import AdoptSummary from '../components/AdoptSummary.js';
import CommandFrame from '../components/CommandFrame.js';
import CommandProgress from '../components/CommandProgress.js';
import HookProgress from '../components/HookProgress.js';

import { useAdoptMachine } from './hooks/use-adopt-machine.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';

export const args = zod.tuple([
  zod
    .string()
    .describe(
      'Shard reference, e.g. "breferrari/obsidian-mind" or "github:owner/repo"',
    ),
]);

export const options = zod.object({
  values: zod.string().optional().describe('Path to a YAML file prefilling value answers'),
  yes: zod
    .boolean()
    .default(false)
    .describe('Skip prompts; auto-keep your version on every differs decision'),
  verbose: zod.boolean().default(false).describe('Show per-file action history during adopt'),
  dryRun: zod
    .boolean()
    .default(false)
    .describe('Preview classification + plan without writing'),
  noUpdateCheck: zod
    .boolean()
    .default(false)
    .describe('Disable the once-per-day npm registry check for newer shardmind versions'),
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function Adopt({ args, options }: Props) {
  const [shardRef] = args;
  const { values: valuesFile, yes, verbose, dryRun, noUpdateCheck } = options;

  const {
    phase,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onDiffChoice,
  } = useAdoptMachine({
    shardRef: shardRef!,
    valuesFile,
    yes,
    verbose,
    dryRun,
    vaultRoot: process.cwd(),
  });

  const banner = useSelfUpdateBanner({ noUpdateCheck });

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
          <InstallWizard
            manifest={phase.ctx.manifest}
            schema={phase.ctx.schema}
            prefillValues={phase.ctx.prefillValues}
            // Adopt's wizard reuses install's value-collection UI but
            // shows file counts as zero — adopt has no clean
            // "X files would be installed" guess at this point because
            // the planner needs values first. We pass empty maps so the
            // module-review step still renders cleanly without bogus
            // counts; the Summary view shows the real bucket counts at
            // the end.
            moduleFileCounts={Object.fromEntries(
              Object.keys(phase.ctx.schema.modules).map((id) => [id, 0]),
            )}
            alwaysIncludedFileCount={0}
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
    case 'diff-review': {
      const target = phase.plan.differs[phase.currentIndex];
      if (!target || target.kind !== 'differs') return null;
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <AdoptDiffView
            path={target.path}
            index={phase.currentIndex + 1}
            total={phase.plan.differs.length}
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
            hookOutput={phase.hook}
            dryRun={phase.dryRun}
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
    case 'error': {
      const err = phase.error;
      const code = err instanceof ShardMindError ? err.code : null;
      const hint = err instanceof ShardMindError ? err.hint : null;
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
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

export const description =
  'Adopt the engine into a vault that was already cloned without shardmind';
