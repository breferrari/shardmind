import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
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
import { SHARDMIND_DIR, VALUES_FILE } from '../runtime/vault-paths.js';

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
  alwaysIncludedFileCount: number;
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

  // Refs tracked during runInstall so a SIGINT handler can roll back
  // any files written so far and restore any backups created during
  // collision handling.
  const writtenPathsRef = useRef<string[]>([]);
  const backupsRef = useRef<BackupRecord[]>([]);
  const installingRef = useRef(false);
  // Mutable pointer to the latest handleWizardComplete closure so
  // runNonInteractive can call it without circular useCallback deps.
  const handleWizardCompleteRef = useRef<(r: WizardResult, c: PreparedContext) => Promise<void>>(
    async () => {},
  );

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (next.kind === 'summary' || next.kind === 'cancelled' || next.kind === 'error') {
        setTimeout(() => exit(), 100);
      }
    },
    [exit],
  );

  // SIGINT handler: if a render is in progress when the user hits Ctrl+C,
  // roll back partial writes and restore backups before exiting. Default
  // Ink behavior exits without knowing about our bookkeeping.
  useEffect(() => {
    const handler = () => {
      if (installingRef.current && !dryRun) {
        // Fire-and-forget; process is about to exit anyway.
        rollbackInstall(vaultRoot, writtenPathsRef.current, backupsRef.current)
          .catch(() => {})
          .finally(() => process.exit(130));
      } else {
        process.exit(130);
      }
    };
    process.on('SIGINT', handler);
    return () => {
      process.off('SIGINT', handler);
    };
  }, [dryRun, vaultRoot]);

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

        const prefill = valuesFile ? await loadValuesFile(valuesFile, schema) : {};
        const merged = mergePrefill(schema, prefill);

        const { moduleFileCounts, alwaysIncludedFileCount } = await planOutputs(
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
          alwaysIncludedFileCount,
        };
        ctxForCleanup = ctx;

        const existing = await readState(vaultRoot);
        if (existing) {
          if (disposed) return;
          setPhase({ kind: 'gate', state: existing, ctx });
          return;
        }

        if (disposed) return;
        if (yes) {
          await runNonInteractive(ctx);
        } else {
          setPhase({ kind: 'wizard', ctx });
        }
      } catch (err) {
        if (disposed) return;
        finish({ kind: 'error', error: err as Error });
      }
    })();

    return () => {
      disposed = true;
      if (ctxForCleanup) {
        ctxForCleanup.cleanup().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shardRef, valuesFile, yes]);

  const runNonInteractive = useCallback(
    async (ctx: PreparedContext) => {
      const missing = missingValueKeys(ctx.schema, ctx.prefillValues);
      if (missing.length > 0) {
        throw new ShardMindError(
          `Missing required values for --yes: ${missing.join(', ')}`,
          'VALUES_MISSING',
          'Provide them via --values <file> or drop --yes to prompt interactively.',
        );
      }
      const validator = buildValuesValidator(ctx.schema);
      const validated = validator.parse(
        resolveComputedDefaults(ctx.schema, ctx.prefillValues),
      ) as Record<string, unknown>;
      await handleWizardCompleteRef.current(
        { values: validated, selections: defaultModuleSelections(ctx.schema) },
        ctx,
      );
    },
    [],
  );

  const executeInstall = useCallback(
    async (ctx: PreparedContext, result: WizardResult, backups: BackupRecord[]) => {
      const start = Date.now();
      const history: string[] = [];

      // Register backups + reset writtenPaths so the SIGINT handler sees
      // live state from the first byte written.
      backupsRef.current = backups;
      writtenPathsRef.current = [];
      installingRef.current = true;

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
          onFileWritten: (outputPath) => {
            writtenPathsRef.current.push(outputPath);
          },
          onProgress: (ev) => {
            if (ev.kind === 'start') {
              setPhase((prev) =>
                prev.kind === 'installing' && (prev.total !== ev.total || prev.current !== 0)
                  ? { ...prev, total: ev.total, current: 0, label: 'Starting…' }
                  : prev,
              );
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(ev.outputPath);
                if (history.length > 5) history.shift();
              }
              setPhase((prev) => {
                if (prev.kind !== 'installing') return prev;
                if (prev.current === ev.index && prev.label === ev.label) return prev;
                return {
                  ...prev,
                  current: ev.index,
                  total: ev.total,
                  label: ev.label,
                  history: verbose ? [...history] : prev.history,
                };
              });
            }
          },
        });
        written = runResult.writtenPaths;

        const hookResult = dryRun
          ? { kind: 'absent' as const }
          : await runPostInstallHook(ctx.tempDir, ctx.manifest);
        const hookSummary = summarizeHook(hookResult);

        installingRef.current = false;

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
          await rollbackInstall(vaultRoot, written, backups).catch(() => {});
        }
        installingRef.current = false;
        finish({
          kind: 'error',
          error: err as Error,
          detail: dryRun ? undefined : 'Rolled back partial install (including any pre-install backups).',
        });
      }
    },
    [vaultRoot, verbose, dryRun, finish],
  );

  const handleWizardComplete = useCallback(
    async (result: WizardResult, ctx: PreparedContext) => {
      try {
        const validator = buildValuesValidator(ctx.schema);
        const validated = validator.parse(result.values) as Record<string, unknown>;
        const validatedResult: WizardResult = { values: validated, selections: result.selections };

        const { outputs } = await planOutputs(ctx.schema, ctx.tempDir, validatedResult.selections);
        const collisions = await detectCollisions(vaultRoot, outputs.map((o) => o.outputPath));

        if (collisions.length > 0) {
          if (yes) {
            // --yes policy: auto-backup. Dry-run must skip the disk action.
            const backups = dryRun ? [] : await backupCollisions(collisions);
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
    [yes, dryRun, vaultRoot, executeInstall, finish],
  );

  useEffect(() => {
    handleWizardCompleteRef.current = handleWizardComplete;
  }, [handleWizardComplete]);

  const handleCollisionChoice = useCallback(
    async (action: CollisionAction) => {
      if (phase.kind !== 'collision') return;
      const { collisions, result, ctx } = phase;
      if (action === 'cancel') {
        finish({ kind: 'cancelled', reason: 'User cancelled at collision review.' });
        return;
      }

      try {
        if (action === 'backup') {
          const backups = await backupCollisions(collisions);
          await executeInstall(ctx, result, backups);
          return;
        }
        // Overwrite: remove colliding paths so writeFile doesn't hit EISDIR
        // when a directory sits at a planned file path. User authorized the loss.
        await Promise.all(
          collisions.map((c) => fsp.rm(c.absolutePath, { recursive: true, force: true })),
        );
        await executeInstall(ctx, result, []);
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
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
          reason: 'Existing install preserved. `shardmind update` is not yet available (Milestone 4); re-run `install` and pick Reinstall when you want a fresh start.',
        });
        return;
      }
      if (choice === 'reinstall') {
        if (dryRun) {
          finish({
            kind: 'cancelled',
            reason: 'Reinstall is destructive and cannot run under --dry-run. Drop --dry-run to reinstall.',
          });
          return;
        }
        (async () => {
          try {
            await Promise.all([
              fsp.rm(path.join(vaultRoot, SHARDMIND_DIR), { recursive: true, force: true }),
              fsp.rm(path.join(vaultRoot, VALUES_FILE), { force: true }),
            ]);
            if (yes) {
              await runNonInteractive(phase.ctx);
            } else {
              setPhase({ kind: 'wizard', ctx: phase.ctx });
            }
          } catch (err) {
            finish({ kind: 'error', error: err as Error });
          }
        })();
      }
    },
    [phase, vaultRoot, yes, dryRun, finish, runNonInteractive],
  );

  if (phase.kind === 'booting' || phase.kind === 'loading') {
    const msg = phase.kind === 'loading' ? phase.message : 'Starting…';
    return (
      <RootFrame dryRun={Boolean(dryRun)} showLegend={false}>
        <Box gap={1}>
          <Spinner />
          <Text>{msg}</Text>
        </Box>
      </RootFrame>
    );
  }

  if (phase.kind === 'gate') {
    return (
      <RootFrame dryRun={Boolean(dryRun)}>
        <ExistingInstallGate state={phase.state} onChoice={handleGateChoice} />
      </RootFrame>
    );
  }

  if (phase.kind === 'wizard') {
    return (
      <RootFrame dryRun={Boolean(dryRun)}>
        <InstallWizard
          manifest={phase.ctx.manifest}
          schema={phase.ctx.schema}
          prefillValues={phase.ctx.prefillValues}
          moduleFileCounts={phase.ctx.moduleFileCounts}
          alwaysIncludedFileCount={phase.ctx.alwaysIncludedFileCount}
          onComplete={(result) => handleWizardComplete(result, phase.ctx)}
          onCancel={() => finish({ kind: 'cancelled', reason: 'User cancelled in wizard.' })}
          onError={(err) => finish({ kind: 'error', error: err })}
        />
      </RootFrame>
    );
  }

  if (phase.kind === 'collision') {
    return (
      <RootFrame dryRun={Boolean(dryRun)}>
        <CollisionReview collisions={phase.collisions} onChoice={handleCollisionChoice} />
      </RootFrame>
    );
  }

  if (phase.kind === 'installing') {
    return (
      <RootFrame dryRun={Boolean(dryRun)} showLegend={false}>
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
      <RootFrame dryRun={Boolean(dryRun)} showLegend={false}>
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
      <RootFrame dryRun={Boolean(dryRun)} showLegend={false}>
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
    <RootFrame dryRun={Boolean(dryRun)} showLegend={false}>
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

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ShardMindError(
      `--values file is not valid YAML: ${filePath}`,
      'VALUES_FILE_INVALID',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShardMindError(
      `--values file must be a YAML mapping: ${filePath}`,
      'VALUES_FILE_INVALID',
      'Top level must be { key: value } entries matching shard schema value IDs.',
    );
  }

  // Unknown keys are silently ignored so a values file can be reused
  // across shard versions that have added or removed entries.
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
