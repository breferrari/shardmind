import { useEffect, useState, useCallback } from 'react';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage, Alert } from '@inkjs/ui';
import { parse as parseYaml } from 'yaml';
import zod from 'zod';

import type { ShardManifest, ShardSchema, ShardState, ResolvedShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

import { resolve as resolveRef } from '../core/registry.js';
import { downloadShard } from '../core/download.js';
import { parseManifest } from '../core/manifest.js';
import { parseSchema, buildValuesValidator } from '../core/schema.js';
import { readState } from '../core/state.js';
import {
  planOutputs,
  runInstall,
  rollbackInstall,
} from '../core/install-runner.js';
import {
  detectCollisions,
  backupCollisions,
  mergePrefill,
  resolveComputedDefaults,
  missingValueKeys,
  defaultModuleSelections,
  type Collision,
  type BackupRecord,
} from '../core/install-plan.js';
import { runPostInstallHook, type HookResult } from '../core/hook.js';

import InstallWizard, { type WizardResult } from '../components/InstallWizard.js';
import CollisionReview, { type CollisionAction } from '../components/CollisionReview.js';
import ExistingInstallGate, { type GateChoice } from '../components/ExistingInstallGate.js';
import InstallProgress from '../components/InstallProgress.js';
import Summary from '../components/Summary.js';

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

type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'gate'; state: ShardState; ctx: PreparedContext }
  | { kind: 'wizard'; ctx: PreparedContext }
  | { kind: 'collision'; collisions: Collision[]; result: WizardResult; ctx: PreparedContext }
  | { kind: 'installing'; total: number; current: number; label: string; history: string[]; ctx: PreparedContext; result: WizardResult; backups: BackupRecord[] }
  | { kind: 'summary'; manifest: ShardManifest; vaultRoot: string; fileCount: number; durationMs: number; backups: BackupRecord[]; hook: HookSummary | null; dryRun: boolean }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

interface PreparedContext {
  resolved: ResolvedShard;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  cleanup: () => Promise<void>;
  prefillValues: Record<string, unknown>;
  moduleFileCounts: Record<string, number>;
}

interface HookSummary {
  deferred?: boolean;
  stdout?: string;
  exitCode?: number;
}

export default function Install({ args, options }: Props) {
  const [shardRef] = args;
  const { values: valuesFile, yes, verbose, dryRun } = options;
  const vaultRoot = process.cwd();
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (next.kind === 'summary' || next.kind === 'cancelled' || next.kind === 'error') {
        setTimeout(() => exit(), 100);
      }
    },
    [exit],
  );

  // Boot → preparation
  useEffect(() => {
    let disposed = false;
    let ctxForCleanup: PreparedContext | null = null;

    (async () => {
      try {
        setPhase({ kind: 'loading', message: `Resolving ${shardRef}…` });
        const resolved = await resolveRef(shardRef!);

        setPhase({ kind: 'loading', message: `Downloading ${resolved.namespace}/${resolved.name}@${resolved.version}…` });
        const temp = await downloadShard(resolved.tarballUrl);

        setPhase({ kind: 'loading', message: 'Parsing manifest and schema…' });
        const manifest = await parseManifest(temp.manifest);
        const schema = await parseSchema(temp.schema);

        // Prefill values from --values if given; merge with static defaults.
        const prefill = valuesFile ? await loadValuesFile(valuesFile, schema) : {};
        const merged = mergePrefill(schema, prefill);

        // Precompute module file counts for the wizard preview (requires
        // scanning the temp directory with current default selections).
        const { moduleFileCounts } = await planOutputs(
          schema,
          temp.tempDir,
          defaultModuleSelections(schema),
        );

        const ctx: PreparedContext = {
          resolved,
          manifest,
          schema,
          tempDir: temp.tempDir,
          cleanup: temp.cleanup,
          prefillValues: merged,
          moduleFileCounts,
        };
        ctxForCleanup = ctx;

        // Check for existing install.
        const existing = await readState(vaultRoot);
        if (existing) {
          if (disposed) return;
          setPhase({ kind: 'gate', state: existing, ctx });
          return;
        }

        if (disposed) return;
        await proceedToWizardOrYes(ctx);
      } catch (err) {
        if (disposed) return;
        finish({ kind: 'error', error: err as Error });
      }
    })();

    async function proceedToWizardOrYes(ctx: PreparedContext) {
      if (yes) {
        // Non-interactive: resolve computed defaults, use default module selections,
        // run straight into collision/install phases.
        const missing = missingValueKeys(ctx.schema, ctx.prefillValues);
        if (missing.length > 0) {
          throw new ShardMindError(
            `Missing required values for --yes: ${missing.join(', ')}`,
            'VALUES_MISSING',
            'Provide them via --values <file> or drop --yes to prompt interactively.',
          );
        }
        const validator = buildValuesValidator(ctx.schema);
        const resolvedValues = resolveComputedDefaults(ctx.schema, ctx.prefillValues);
        const validated = validator.parse(resolvedValues);
        const selections = defaultModuleSelections(ctx.schema);
        await handleWizardComplete({ values: validated, selections }, ctx);
        return;
      }
      setPhase({ kind: 'wizard', ctx });
    }

    return () => {
      disposed = true;
      if (ctxForCleanup) {
        ctxForCleanup.cleanup().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shardRef, valuesFile, yes]);

  const handleWizardComplete = useCallback(
    async (result: WizardResult, ctx: PreparedContext) => {
      try {
        // Validate values against generated zod validator.
        const validator = buildValuesValidator(ctx.schema);
        const validated = validator.parse(result.values) as Record<string, unknown>;
        const validatedResult: WizardResult = { values: validated, selections: result.selections };

        // Enumerate planned outputs under the chosen selections.
        const { outputs } = await planOutputs(ctx.schema, ctx.tempDir, validatedResult.selections);
        const paths = outputs.map((o) => o.outputPath);
        const collisions = await detectCollisions(vaultRoot, paths);

        if (collisions.length > 0) {
          if (yes) {
            // Non-interactive policy: back up and continue.
            const backups = await backupCollisions(collisions);
            await executeInstall(ctx, validatedResult, backups);
          } else {
            setPhase({ kind: 'collision', collisions, result: validatedResult, ctx });
          }
          return;
        }

        await executeInstall(ctx, validatedResult, []);
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    [yes, vaultRoot, finish],
  );

  const executeInstall = useCallback(
    async (ctx: PreparedContext, result: WizardResult, backups: BackupRecord[]) => {
      const start = Date.now();
      const history: string[] = [];

      setPhase({
        kind: 'installing',
        total: 0,
        current: 0,
        label: 'Preparing…',
        history,
        ctx,
        result,
        backups,
      });

      let written: string[] = [];
      try {
        const runResult = await runInstall({
          vaultRoot,
          manifest: ctx.manifest,
          schema: ctx.schema,
          tempDir: ctx.tempDir,
          resolved: ctx.resolved,
          values: result.values,
          selections: result.selections,
          dryRun,
          onProgress: (ev) => {
            if (ev.kind === 'start') {
              setPhase((prev) =>
                prev.kind === 'installing'
                  ? { ...prev, total: ev.total, current: 0, label: 'Starting…' }
                  : prev,
              );
            } else if (ev.kind === 'file') {
              if (verbose) history.push(ev.outputPath);
              setPhase((prev) =>
                prev.kind === 'installing'
                  ? {
                      ...prev,
                      current: ev.index,
                      total: ev.total,
                      label: ev.label,
                      history: [...history],
                    }
                  : prev,
              );
            }
          },
        });
        written = runResult.writtenPaths;

        const hookResult = dryRun
          ? { kind: 'absent' as const }
          : await runPostInstallHook(ctx.tempDir, ctx.manifest);
        const hookSummary = summarizeHook(hookResult);

        finish({
          kind: 'summary',
          manifest: ctx.manifest,
          vaultRoot,
          fileCount: runResult.fileCount,
          durationMs: Date.now() - start,
          backups,
          hook: hookSummary,
          dryRun: Boolean(dryRun),
        });
      } catch (err) {
        if (!dryRun) {
          await rollbackInstall(vaultRoot, written).catch(() => {});
        }
        finish({ kind: 'error', error: err as Error, detail: 'Rolled back partial install.' });
      }
    },
    [vaultRoot, verbose, dryRun, finish],
  );

  const handleCollisionChoice = useCallback(
    async (action: CollisionAction) => {
      if (phase.kind !== 'collision') return;
      const { collisions, result, ctx } = phase;
      if (action === 'cancel') {
        finish({ kind: 'cancelled', reason: 'User cancelled at collision review.' });
        return;
      }
      const backups = action === 'backup' ? await backupCollisions(collisions) : [];
      await executeInstall(ctx, result, backups);
    },
    [phase, finish, executeInstall],
  );

  const handleGateChoice = useCallback(
    (choice: GateChoice) => {
      if (phase.kind !== 'gate') return;
      if (choice === 'cancel') {
        finish({ kind: 'cancelled', reason: 'User cancelled at existing-install gate.' });
        return;
      }
      if (choice === 'update') {
        finish({
          kind: 'cancelled',
          reason: 'Run `shardmind update` instead. (Install declined.)',
        });
        return;
      }
      if (choice === 'reinstall') {
        // Delete existing state + values, then fall through to wizard.
        (async () => {
          try {
            await fsp.rm(path.join(vaultRoot, '.shardmind'), { recursive: true, force: true });
            await fsp.rm(path.join(vaultRoot, 'shard-values.yaml'), { force: true });
            if (yes) {
              const missing = missingValueKeys(phase.ctx.schema, phase.ctx.prefillValues);
              if (missing.length > 0) {
                throw new ShardMindError(
                  `Missing required values for --yes: ${missing.join(', ')}`,
                  'VALUES_MISSING',
                  'Provide them via --values <file> or drop --yes to prompt interactively.',
                );
              }
              const validator = buildValuesValidator(phase.ctx.schema);
              const resolvedValues = resolveComputedDefaults(phase.ctx.schema, phase.ctx.prefillValues);
              const validated = validator.parse(resolvedValues);
              await handleWizardComplete(
                { values: validated, selections: defaultModuleSelections(phase.ctx.schema) },
                phase.ctx,
              );
            } else {
              setPhase({ kind: 'wizard', ctx: phase.ctx });
            }
          } catch (err) {
            finish({ kind: 'error', error: err as Error });
          }
        })();
      }
    },
    [phase, vaultRoot, yes, finish, handleWizardComplete],
  );

  // Render tree per phase.
  if (phase.kind === 'booting' || phase.kind === 'loading') {
    const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
    return (
      <Box gap={1}>
        <Spinner />
        <Text>{msg}</Text>
      </Box>
    );
  }

  if (phase.kind === 'gate') {
    return <ExistingInstallGate state={phase.state} onChoice={handleGateChoice} />;
  }

  if (phase.kind === 'wizard') {
    return (
      <InstallWizard
        manifest={phase.ctx.manifest}
        schema={phase.ctx.schema}
        prefillValues={phase.ctx.prefillValues}
        moduleFileCounts={phase.ctx.moduleFileCounts}
        onComplete={(result) => handleWizardComplete(result, phase.ctx)}
        onCancel={() => finish({ kind: 'cancelled', reason: 'User cancelled in wizard.' })}
      />
    );
  }

  if (phase.kind === 'collision') {
    return <CollisionReview collisions={phase.collisions} onChoice={handleCollisionChoice} />;
  }

  if (phase.kind === 'installing') {
    return (
      <InstallProgress
        current={phase.current}
        total={phase.total}
        label={phase.label}
        verbose={verbose}
        history={phase.history}
      />
    );
  }

  if (phase.kind === 'summary') {
    return (
      <Summary
        manifest={phase.manifest}
        vaultRoot={phase.vaultRoot}
        fileCount={phase.fileCount}
        durationMs={phase.durationMs}
        backups={phase.backups}
        hookOutput={phase.hook}
        dryRun={phase.dryRun}
      />
    );
  }

  if (phase.kind === 'cancelled') {
    return (
      <Box flexDirection="column">
        <Alert variant="info">Cancelled</Alert>
        <Text dimColor>{phase.reason}</Text>
      </Box>
    );
  }

  // error
  const err = phase.error;
  const code = err instanceof ShardMindError ? err.code : null;
  const hint = err instanceof ShardMindError ? err.hint : null;
  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant="error">{err.message}</StatusMessage>
      {code && <Text dimColor>code: {code}</Text>}
      {hint && <Text>{hint}</Text>}
      {phase.detail && <Text dimColor>{phase.detail}</Text>}
    </Box>
  );
}

async function loadValuesFile(
  filePath: string,
  schema: ShardSchema,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new ShardMindError(
      `Could not read --values file: ${filePath}`,
      'VALUES_FILE_READ_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShardMindError(
      `--values file must be a YAML mapping: ${filePath}`,
      'VALUES_FILE_INVALID',
      'Top level must be { key: value } entries matching shard schema value IDs.',
    );
  }

  // Filter to known schema keys only — unknown keys are ignored silently
  // so the file can be reused across shard versions.
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(schema.values)) {
    if (key in (parsed as Record<string, unknown>)) {
      filtered[key] = (parsed as Record<string, unknown>)[key];
    }
  }
  return filtered;
}

function summarizeHook(result: HookResult): HookSummary | null {
  switch (result.kind) {
    case 'absent':
      return null;
    case 'deferred':
      return { deferred: true };
    case 'ran':
      return { stdout: result.stdout, exitCode: result.exitCode };
    case 'failed':
      return { stdout: result.message, exitCode: 1 };
  }
}

export const description = 'Install a shard into the current directory';
