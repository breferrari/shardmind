/**
 * State machine + async orchestration for the update command.
 *
 * Sibling of `use-install-machine.ts`. Owns every side-effecting
 * transition (resolve, download, migrate, prompt, drift, plan, merge,
 * write, hook, rollback) behind a hook interface so commands/update.tsx
 * stays thin presentation.
 *
 * Phase ordering (see docs/IMPLEMENTATION.md §3):
 *   booting → loading → (no-install | up-to-date | migrating →
 *   prompt-new-values → prompt-new-modules → prompt-removed-files →
 *   resolving-conflicts → writing → summary)
 *
 * Any exception between `writing` start and `writing` end triggers
 * rollback via the executor's snapshot before surfacing an error phase.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import path from 'node:path';
import { useApp } from 'ink';
import { loadValuesYaml } from '../../core/values-io.js';
import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  ResolvedShard,
  ModuleSelections,
  ModuleDefinition,
  MigrationChange,
} from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';

import { resolve as resolveRef } from '../../core/registry.js';
import { primeLatestVersion } from '../../core/update-check.js';
import { downloadShard } from '../../core/download.js';
import { parseManifest } from '../../core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../core/schema.js';
import { readState } from '../../core/state.js';
import { detectDrift } from '../../core/drift.js';
import { applyMigrations } from '../../core/migrator.js';
import {
  computeSchemaAdditions,
  mergeModuleSelections,
  removedFilesNeedingDecision,
  planUpdate,
  renderNewShard,
  type UpdatePlan,
  type ConflictResolution,
  type NewFilePlan,
} from '../../core/update-planner.js';
import { runUpdate, rollbackUpdate, type UpdateSummary } from '../../core/update-executor.js';
import { runPostUpdateHook } from '../../core/hook.js';
import { summarizeHook, useSigintRollback } from './shared.js';
import { buildRenderContext } from '../../core/renderer.js';
import { VALUES_FILE } from '../../runtime/vault-paths.js';
import type { DiffAction } from '../../components/DiffView.js';

export interface UseUpdateMachineInput {
  vaultRoot: string;
  yes: boolean;
  verbose: boolean;
  dryRun: boolean;
}

export interface PreparedContext {
  state: ShardState;
  oldSchema: ShardSchema;
  resolved: ResolvedShard;
  newManifest: ShardManifest;
  newSchema: ShardSchema;
  newTempDir: string;
  newTarballSha: string;
  cleanup: () => Promise<void>;
  oldValues: Record<string, unknown>;
  migratedValues: Record<string, unknown>;
  migrationApplied: MigrationChange[];
  migrationWarnings: string[];
  newRequiredKeys: string[];
  newOptionalModules: Array<{ id: string; def: ModuleDefinition }>;
}

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'no-install' }
  | { kind: 'up-to-date'; manifest: ShardManifest; state: ShardState }
  | { kind: 'prompt-new-values'; ctx: PreparedContext }
  | { kind: 'prompt-new-modules'; ctx: PreparedContext; values: Record<string, unknown> }
  | {
      kind: 'prompt-removed-files';
      ctx: PreparedContext;
      values: Record<string, unknown>;
      selections: ModuleSelections;
      paths: string[];
      newFilePlan: NewFilePlan;
    }
  | {
      kind: 'resolving-conflicts';
      ctx: PreparedContext;
      plan: UpdatePlan;
      values: Record<string, unknown>;
      selections: ModuleSelections;
      currentIndex: number;
      resolutions: Record<string, ConflictResolution>;
    }
  | {
      kind: 'writing';
      total: number;
      current: number;
      label: string;
      history: string[];
    }
  | {
      kind: 'summary';
      summary: UpdateSummary;
      migrationWarnings: string[];
      hook: { deferred?: boolean; stdout?: string; exitCode?: number } | null;
      durationMs: number;
      dryRun: boolean;
    }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseUpdateMachineOutput {
  phase: Phase;
  onNewValuesComplete: (values: Record<string, unknown>) => void;
  onNewModulesComplete: (choices: Record<string, 'included' | 'excluded'>) => void;
  onRemovedFilesComplete: (decisions: Record<string, 'delete' | 'keep'>) => void;
  onConflictChoice: (action: DiffAction) => void;
  onCancel: (reason?: string) => void;
}

export function useUpdateMachine(input: UseUpdateMachineInput): UseUpdateMachineOutput {
  const { vaultRoot, yes, verbose, dryRun } = input;
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const backupDirRef = useRef<string | null>(null);
  const writingRef = useRef(false);
  const addedPathsRef = useRef<string[]>([]);

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (
        next.kind === 'summary' ||
        next.kind === 'cancelled' ||
        next.kind === 'error' ||
        next.kind === 'no-install' ||
        next.kind === 'up-to-date'
      ) {
        setTimeout(() => exit(), 100);
      }
    },
    [exit],
  );

  // If we're mid-write, walk the executor's snapshot back before exiting.
  // Tempdir cleanup fires on every Ctrl-C — otherwise cancelling during the
  // download/plan phase would leak the extracted shard on disk.
  // `rollbackUpdate` returns a failure list; we ignore it here (the
  // process is about to exit), but SIGINT-mid-write is rare enough that
  // the silent path is acceptable — the disk state is best-effort anyway.
  useSigintRollback({
    isActive: () => !dryRun && writingRef.current && backupDirRef.current !== null,
    rollback: async () => {
      if (backupDirRef.current) {
        await rollbackUpdate(vaultRoot, backupDirRef.current, addedPathsRef.current);
      }
    },
    cleanup: () => (ctxCleanupRef.current ? ctxCleanupRef.current() : Promise.resolve()),
  });

  // Boot pipeline: state → resolve → download → parse → migrate → branch.
  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        setPhase({ kind: 'loading', message: 'Reading install state…' });
        const state = await readState(vaultRoot);
        if (!state) {
          finish({ kind: 'no-install' });
          return;
        }

        setPhase({ kind: 'loading', message: `Resolving ${state.source}…` });
        const resolved = await resolveRef(state.source);
        // Warm the update-check cache so the next `shardmind` (status) run
        // answers "latest version" instantly instead of paying for another
        // GitHub API call. Swallows errors — a cache-priming failure must
        // not cascade into an update failure.
        void primeLatestVersion(vaultRoot, state.source, resolved.version).catch(() => {
          /* swallow */
        });

        setPhase({
          kind: 'loading',
          message: `Downloading ${resolved.namespace}/${resolved.name}@${resolved.version}…`,
        });
        const temp = await downloadShard(resolved.tarballUrl);
        ctxCleanupRef.current = temp.cleanup;

        setPhase({ kind: 'loading', message: 'Parsing new manifest and schema…' });
        const newManifest = await parseManifest(temp.manifest);
        const newSchema = await parseSchema(temp.schema);

        if (
          newManifest.version === state.version &&
          temp.tarball_sha256 === state.tarball_sha256
        ) {
          if (disposed) return;
          finish({ kind: 'up-to-date', manifest: newManifest, state });
          return;
        }

        setPhase({ kind: 'loading', message: 'Loading current values…' });
        const oldValues = await loadCurrentValues(vaultRoot);
        const oldSchema = await loadCachedSchema(vaultRoot, state);

        setPhase({ kind: 'loading', message: 'Applying migrations…' });
        const migration = applyMigrations(
          oldValues,
          state.version,
          newManifest.version,
          newSchema.migrations,
        );

        const additions = computeSchemaAdditions(newSchema, state.modules, migration.values);

        const ctx: PreparedContext = {
          state,
          oldSchema,
          resolved,
          newManifest,
          newSchema,
          newTempDir: temp.tempDir,
          newTarballSha: temp.tarball_sha256,
          cleanup: temp.cleanup,
          oldValues,
          migratedValues: migration.values,
          migrationApplied: migration.applied,
          migrationWarnings: migration.warnings,
          newRequiredKeys: additions.newRequiredKeys,
          newOptionalModules: additions.newOptionalModules,
        };

        if (disposed) return;

        if (yes) {
          await runNonInteractive(ctx);
          return;
        }

        if (ctx.newRequiredKeys.length > 0) {
          setPhase({ kind: 'prompt-new-values', ctx });
          return;
        }
        continueAfterValues(ctx, ctx.migratedValues);
      } catch (err) {
        if (disposed) return;
        finish({ kind: 'error', error: err as Error });
      }
    })();

    return () => {
      disposed = true;
      if (ctxCleanupRef.current) {
        ctxCleanupRef.current().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultRoot, yes]);

  const runNonInteractive = useCallback(
    async (ctx: PreparedContext) => {
      if (ctx.newRequiredKeys.length > 0) {
        throw new ShardMindError(
          `Missing required values for --yes: ${ctx.newRequiredKeys.join(', ')}`,
          'VALUES_MISSING',
          'Drop --yes and answer interactively, or add the missing keys to shard-values.yaml first.',
        );
      }
      const selections = mergeModuleSelections(
        ctx.state.modules,
        ctx.newSchema,
        Object.fromEntries(ctx.newOptionalModules.map((m) => [m.id, 'included'])),
      );
      const values = validateValues(ctx.newSchema, ctx.migratedValues);
      await continueWithRemovedPrompt(ctx, values, selections);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const continueAfterValues = useCallback(
    (ctx: PreparedContext, values: Record<string, unknown>) => {
      const validated = validateValues(ctx.newSchema, values);
      if (ctx.newOptionalModules.length > 0) {
        setPhase({ kind: 'prompt-new-modules', ctx, values: validated });
        return;
      }
      const selections = mergeModuleSelections(ctx.state.modules, ctx.newSchema, {});
      void continueWithRemovedPrompt(ctx, validated, selections);
    },
    [],
  );

  const continueWithRemovedPrompt = useCallback(
    async (
      ctx: PreparedContext,
      values: Record<string, unknown>,
      selections: ModuleSelections,
    ) => {
      try {
        // Render the new shard once and thread the result through to
        // `runPlanAndResolve`. The planner reuses this plan instead of
        // rendering a second time.
        const newRenderContext = buildRenderContext(ctx.newManifest, values, selections);
        const [drift, newFilePlan] = await Promise.all([
          detectDrift(vaultRoot, ctx.state),
          renderNewShard(ctx.newSchema, ctx.newTempDir, selections, newRenderContext),
        ]);
        const newPaths = new Set(newFilePlan.outputs.map((o) => o.outputPath));
        const removedModified = removedFilesNeedingDecision(drift, newPaths);

        if (removedModified.length === 0 || yes) {
          await runPlanAndResolve(ctx, values, selections, {}, { drift, newFilePlan });
          return;
        }
        setPhase({
          kind: 'prompt-removed-files',
          ctx,
          values,
          selections,
          paths: removedModified,
          newFilePlan,
        });
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultRoot, yes, finish],
  );

  const runPlanAndResolve = useCallback(
    async (
      ctx: PreparedContext,
      values: Record<string, unknown>,
      selections: ModuleSelections,
      removedDecisions: Record<string, 'delete' | 'keep'>,
      precomputed?: { drift?: Awaited<ReturnType<typeof detectDrift>>; newFilePlan?: NewFilePlan },
    ) => {
      try {
        setPhase({ kind: 'loading', message: 'Planning update…' });
        const newRenderContext = buildRenderContext(ctx.newManifest, values, selections);
        const drift = precomputed?.drift ?? (await detectDrift(vaultRoot, ctx.state));
        const plan = await planUpdate({
          vault: { root: vaultRoot, state: ctx.state, drift },
          values: { old: ctx.oldValues, new: values },
          newShard: {
            schema: ctx.newSchema,
            selections,
            tempDir: ctx.newTempDir,
            renderContext: newRenderContext,
            filePlan: precomputed?.newFilePlan,
          },
          removedFileDecisions: removedDecisions,
        });

        if (plan.pendingConflicts.length > 0 && !yes) {
          setPhase({
            kind: 'resolving-conflicts',
            ctx,
            plan,
            values,
            selections,
            currentIndex: 0,
            resolutions: {},
          });
          return;
        }

        // --yes: auto-resolve conflicts by keeping the user's copy.
        const autoResolutions: Record<string, ConflictResolution> = {};
        for (const pc of plan.pendingConflicts) {
          autoResolutions[pc.path] = 'keep_mine';
        }
        await executeWrite(ctx, plan, values, selections, autoResolutions);
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultRoot, yes, finish],
  );

  const executeWrite = useCallback(
    async (
      ctx: PreparedContext,
      plan: UpdatePlan,
      values: Record<string, unknown>,
      selections: ModuleSelections,
      resolutions: Record<string, ConflictResolution>,
    ) => {
      const start = Date.now();
      const history: string[] = [];

      setPhase({ kind: 'writing', total: 0, current: 0, label: 'Preparing…', history });
      writingRef.current = true;
      addedPathsRef.current = [];
      backupDirRef.current = null;

      try {
        const result = await runUpdate({
          vaultRoot,
          plan,
          conflictResolutions: resolutions,
          currentState: ctx.state,
          newManifest: ctx.newManifest,
          newSchema: ctx.newSchema,
          newValues: values,
          newSelections: selections,
          resolved: ctx.resolved,
          tarballSha256: ctx.newTarballSha,
          newTempDir: ctx.newTempDir,
          dryRun,
          // Populate the refs EAGERLY so a mid-write SIGINT can actually
          // find the backup dir and the list of paths to erase. The
          // post-runUpdate assignment below still runs for the
          // non-cancelled success path; these streaming callbacks make
          // the same values available while the run is in flight.
          onBackupReady: (dir) => {
            backupDirRef.current = dir;
          },
          onFileTouched: (_outputPath, introduced) => {
            if (introduced) addedPathsRef.current.push(_outputPath);
          },
          onProgress: (ev) => {
            if (ev.kind === 'start') {
              setPhase((prev) =>
                prev.kind === 'writing' ? { ...prev, total: ev.total, current: 0, label: 'Starting…' } : prev,
              );
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(`${labelForAction(ev.action)} ${ev.outputPath}`);
                if (history.length > 5) history.shift();
              }
              setPhase((prev) => {
                if (prev.kind !== 'writing') return prev;
                return {
                  ...prev,
                  current: ev.index,
                  total: ev.total,
                  label: ev.outputPath,
                  history: verbose ? [...history] : prev.history,
                };
              });
            }
          },
        });
        backupDirRef.current = result.backupDir;

        const hookResult = dryRun
          ? { kind: 'absent' as const }
          : await runPostUpdateHook(ctx.newTempDir, ctx.newManifest);

        writingRef.current = false;

        finish({
          kind: 'summary',
          summary: result.summary,
          migrationWarnings: ctx.migrationWarnings,
          hook: summarizeHook(hookResult),
          durationMs: Date.now() - start,
          dryRun,
        });
      } catch (err) {
        writingRef.current = false;
        finish({
          kind: 'error',
          error: err as Error,
          detail: dryRun ? undefined : 'Rolled back partial update.',
        });
      }
    },
    [vaultRoot, dryRun, verbose, finish],
  );

  const onNewValuesComplete = useCallback(
    (values: Record<string, unknown>) => {
      const current = phaseRef.current;
      if (current.kind !== 'prompt-new-values') return;
      try {
        continueAfterValues(current.ctx, { ...current.ctx.migratedValues, ...values });
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    [continueAfterValues, finish],
  );

  const onNewModulesComplete = useCallback(
    (choices: Record<string, 'included' | 'excluded'>) => {
      const current = phaseRef.current;
      if (current.kind !== 'prompt-new-modules') return;
      const selections = mergeModuleSelections(current.ctx.state.modules, current.ctx.newSchema, choices);
      void continueWithRemovedPrompt(current.ctx, current.values, selections);
    },
    [continueWithRemovedPrompt],
  );

  const onRemovedFilesComplete = useCallback(
    (decisions: Record<string, 'delete' | 'keep'>) => {
      const current = phaseRef.current;
      if (current.kind !== 'prompt-removed-files') return;
      void runPlanAndResolve(current.ctx, current.values, current.selections, decisions, {
        newFilePlan: current.newFilePlan,
      });
    },
    [runPlanAndResolve],
  );

  const onConflictChoice = useCallback(
    (action: DiffAction) => {
      const current = phaseRef.current;
      if (current.kind !== 'resolving-conflicts') return;
      const pc = current.plan.pendingConflicts[current.currentIndex];
      if (!pc) return;
      const nextResolutions = { ...current.resolutions, [pc.path]: action };
      const nextIndex = current.currentIndex + 1;
      if (nextIndex < current.plan.pendingConflicts.length) {
        setPhase({ ...current, currentIndex: nextIndex, resolutions: nextResolutions });
        return;
      }
      void executeWrite(current.ctx, current.plan, current.values, current.selections, nextResolutions);
    },
    [executeWrite],
  );

  const onCancel = useCallback(
    (reason: string = 'User cancelled.') => finish({ kind: 'cancelled', reason }),
    [finish],
  );

  return {
    phase,
    onNewValuesComplete,
    onNewModulesComplete,
    onRemovedFilesComplete,
    onConflictChoice,
    onCancel,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadCurrentValues(vaultRoot: string): Promise<Record<string, unknown>> {
  return loadValuesYaml(path.join(vaultRoot, VALUES_FILE), {
    label: VALUES_FILE,
    errors: { readFailed: 'VALUES_READ_FAILED', invalid: 'VALUES_INVALID' },
  });
}

async function loadCachedSchema(vaultRoot: string, state: ShardState): Promise<ShardSchema> {
  try {
    return await parseSchema(path.join(vaultRoot, '.shardmind', 'shard-schema.yaml'));
  } catch (err) {
    throw new ShardMindError(
      'Cached schema missing or corrupt',
      'UPDATE_CACHE_MISSING',
      `Re-run \`shardmind install ${state.source}\` to regenerate .shardmind/. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validateValues(schema: ShardSchema, values: Record<string, unknown>): Record<string, unknown> {
  const validator = buildValuesValidator(schema);
  return validator.parse(values) as Record<string, unknown>;
}

function labelForAction(kind: string): string {
  switch (kind) {
    case 'overwrite': return '↻';
    case 'auto_merge': return '⚙';
    case 'conflict': return '✎';
    case 'add': return '+';
    case 'delete': return '✗';
    case 'restore_missing': return '↺';
    default: return '·';
  }
}
