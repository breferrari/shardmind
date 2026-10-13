import { Box, Text, useApp } from 'ink';
import { useEffect, useState } from 'react';
import { Spinner, Alert } from '../components/ui.js';
import zod from 'zod';
import { updateCheckOption } from './hooks/update-check-option.js';
import { skipHooksOption } from './hooks/skip-hooks-option.js';

import { assertNever } from '../runtime/types.js';
import ErrorView from '../components/ErrorView.js';
import { resolveEngineVersion } from './hooks/cli-version.js';

import InstallWizard from '../components/InstallWizard.js';
import CollisionReview from '../components/CollisionReview.js';
import CommandProgress from '../components/CommandProgress.js';
import HookProgress from '../components/HookProgress.js';
import Summary from '../components/Summary.js';
import CommandFrame from '../components/CommandFrame.js';

import { useAddMachine } from './hooks/use-add-machine.js';
import { assertAddFlags, findVault } from '../core/flows/add.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';
import { setExitCode } from '../core/process-control.js';

export const args = zod.tuple([
  zod.string().describe('Shard reference of the overlay, e.g. "acme/research" or "github:owner/repo"'),
]);

/** install's options but `--force`: there is no install to reinstall over (#396). */
export const options = zod.object({
  values: zod.string().optional().describe("Path to a YAML file prefilling the overlay's value answers"),
  yes: zod.boolean().default(false).describe('Skip all prompts; accept defaults for everything'),
  defaults: zod.boolean().default(false).describe("Use the overlay's schema defaults for every value; skips the wizard. Mutually exclusive with --values."),
  verbose: zod.boolean().default(false).describe('Show per-file rendering progress'),
  dryRun: zod.boolean().default(false).describe('Preview what would be added without writing'),
  skipHooks: skipHooksOption,
  updateCheck: updateCheckOption,
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

/**
 * Finds the vault first (#396): this folder or the nearest one above it
 * holding `.shardmind/state.json`. A refusal (a flag conflict, no vault) ends
 * the run before the lock, the download or any prompt.
 */
export default function Add({ args, options }: Props) {
  const [shardRef] = args;
  const { exit } = useApp();
  const [vault, setVault] = useState<{ root: string } | { error: unknown } | null>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      assertAddFlags({ defaults: options.defaults, valuesFile: options.values });
      return findVault(process.cwd());
    })().then(
      (root) => !disposed && setVault({ root }),
      (error: unknown) => {
        if (disposed) return;
        setExitCode(1);
        setVault({ error });
        setTimeout(() => exit(), 100);
      },
    );
    return () => {
      disposed = true;
    };
  }, [options.defaults, options.values, exit]);

  if (vault !== null && 'root' in vault) return <AddRun shardRef={shardRef} options={options} vaultRoot={vault.root} />;
  return (
    <CommandFrame dryRun={options.dryRun} showLegend={false}>
      {vault === null ? null : <ErrorView error={vault.error} version={resolveEngineVersion()} />}
    </CommandFrame>
  );
}

function AddRun({ shardRef, options, vaultRoot }: { shardRef: string; options: Props['options']; vaultRoot: string }) {
  const { values: valuesFile, yes, defaults, verbose, dryRun, skipHooks, updateCheck } = options;
  const { phase, onWizardComplete, onWizardCancel, onWizardError, onCollisionChoice } = useAddMachine({
    shardRef,
    valuesFile,
    yes,
    defaults,
    verbose,
    dryRun,
    skipHooks,
    vaultRoot,
  });
  const { banner } = useSelfUpdateBanner({ updateCheck });

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
            moduleFileCounts={phase.ctx.moduleFileCounts}
            alwaysIncludedFileCount={phase.ctx.alwaysIncludedFileCount}
            onComplete={onWizardComplete}
            onCancel={onWizardCancel}
            onError={onWizardError}
          />
        </CommandFrame>
      );
    case 'collision':
      return (
        <CommandFrame dryRun={dryRun} selfUpdateBanner={banner}>
          <CollisionReview collisions={phase.collisions} onChoice={onCollisionChoice} />
        </CommandFrame>
      );
    case 'installing':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <CommandProgress current={phase.current} total={phase.total} label={phase.label} verbose={verbose} history={phase.history} />
        </CommandFrame>
      );
    case 'running-hook':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <HookProgress stage={phase.stage} output={phase.output} shardLabel={phase.shardLabel} index={phase.index} total={phase.total} />
        </CommandFrame>
      );
    case 'summary':
      return (
        <CommandFrame dryRun={dryRun} showLegend={false} selfUpdateBanner={banner}>
          <Summary
            manifest={phase.manifest}
            vaultRoot={phase.vaultRoot}
            fileCount={phase.fileCount}
            durationMs={phase.durationMs}
            backups={phase.backups}
            replaced={phase.replaced}
            hooks={phase.hooks}
            dryRun={phase.dryRun}
            externalTools={phase.externalTools}
            addedTo={phase.base}
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

export const description = 'Add an overlay shard to this vault, beside the shard installed';
