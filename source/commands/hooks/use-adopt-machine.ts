/**
 * State machine + async orchestration for the adopt command.
 *
 * Sibling of `use-install-machine.ts` and `use-update-machine.ts`. Adopt
 * fetches a shard, reads the user's vault as it exists today, lets the
 * user reconcile differences via a 2-way diff, then writes the engine
 * metadata an install would have produced.
 *
 * Phase ordering (see docs/IMPLEMENTATION.md §3.5 — Data Flow: Adopt):
 *   booting → loading → wizard → planning →
 *   diff-review (loop over `differs`) → executing →
 *   running-hook → summary
 *
 * Reuses `useSigintRollback`, `appendHookOutput`, `summarizeHook`, and
 * `postHookRehash` from `shared.ts` so install / update / adopt can't
 * drift on any of those concerns.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from 'ink';

import type {
  ResolvedShard,
  ShardManifest,
  ShardSchema,
} from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { resolve as resolveRef } from '../../core/registry.js';
import { downloadShard } from '../../core/download.js';
import { parseManifest } from '../../core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../core/schema.js';
import { loadValuesYaml } from '../../core/values-io.js';
import {
  classifyAdoption,
  type AdoptPlan,
} from '../../core/adopt-planner.js';
import {
  assertAdoptable,
  rollbackAdopt,
  runAdopt,
  type AdoptApplyKind,
  type AdoptResolutions,
  type AdoptSummary as AdoptSummaryData,
} from '../../core/adopt-executor.js';
import {
  defaultModuleSelections,
  mergePrefill,
  missingValueKeys,
  resolveComputedDefaults,
} from '../../core/install-planner.js';
import { runPostInstallHook, type RunningHookPhase } from '../../core/hook.js';
import { valuesAreDefaults } from '../../core/values-defaults.js';
import {
  appendHookOutput,
  postHookRehash,
  summarizeHook,
  useSigintRollback,
  type HookSummary,
} from './shared.js';

import type { WizardResult } from '../../components/InstallWizard.js';
import type { AdoptDiffAction } from '../../components/AdoptDiffView.js';

export interface UseAdoptMachineInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  verbose: boolean;
  dryRun: boolean;
  vaultRoot: string;
}

export interface PreparedContext {
  resolved: ResolvedShard;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  tarballSha256: string;
  cleanup: () => Promise<void>;
  prefillValues: Record<string, unknown>;
}

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'wizard'; ctx: PreparedContext }
  | {
      kind: 'planning';
      ctx: PreparedContext;
      result: WizardResult;
    }
  | {
      kind: 'diff-review';
      ctx: PreparedContext;
      result: WizardResult;
      plan: AdoptPlan;
      currentIndex: number;
      resolutions: AdoptResolutions;
    }
  | {
      kind: 'executing';
      total: number;
      current: number;
      label: string;
      history: string[];
    }
  | (RunningHookPhase & {
      // Subprocess-backed post-install hook is streaming output. We are
      // already past the point-of-no-return (state.json written by
      // `runAdopt`); a Ctrl+C in this phase kills the child but does NOT
      // roll the adopt back. Mirrors install/update — Helm semantics
      // (docs/ARCHITECTURE.md §9.3).
      stage: 'post-install';
    })
  | {
      kind: 'summary';
      manifest: ShardManifest;
      vaultRoot: string;
      summary: AdoptSummaryData;
      durationMs: number;
      hook: HookSummary | null;
      dryRun: boolean;
    }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseAdoptMachineOutput {
  phase: Phase;
  onWizardComplete: (result: WizardResult) => void;
  onWizardCancel: () => void;
  onWizardError: (err: Error) => void;
  onDiffChoice: (action: AdoptDiffAction) => void;
}

export function useAdoptMachine(input: UseAdoptMachineInput): UseAdoptMachineOutput {
  const { shardRef, valuesFile, yes, verbose, dryRun, vaultRoot } = input;
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const backupDirRef = useRef<string | null>(null);
  const writingRef = useRef(false);
  const addedPathsRef = useRef<string[]>([]);
  const hookAbortRef = useRef<AbortController | null>(null);

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (
        next.kind === 'summary' ||
        next.kind === 'cancelled' ||
        next.kind === 'error'
      ) {
        if (next.kind === 'error') process.exitCode = 1;
        setTimeout(() => exit(), 100);
      }
    },
    [exit],
  );

  // Mid-write SIGINT: walk the executor's snapshot back. Tempdir cleanup
  // fires on every Ctrl+C so we don't leak the extracted shard under
  // /tmp/. Mirrors `useUpdateMachine`'s rollback wiring.
  useSigintRollback({
    isActive: () => !dryRun && writingRef.current && backupDirRef.current !== null,
    rollback: async () => {
      if (backupDirRef.current) {
        await rollbackAdopt(vaultRoot, backupDirRef.current, addedPathsRef.current);
      }
    },
    cleanup: async () => {
      hookAbortRef.current?.abort();
      if (ctxCleanupRef.current) await ctxCleanupRef.current();
    },
  });

  // Boot pipeline: guard → resolve → download → parse → wizard.
  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        // Pre-flight guard runs FIRST, before any network call. Saves
        // the user a multi-second wait on a downloads-and-then-rejects
        // path that's deterministically wrong from byte zero.
        await assertAdoptable(vaultRoot);

        setPhase({ kind: 'loading', message: `Resolving ${shardRef}…` });
        const resolved = await resolveRef(shardRef);

        setPhase({
          kind: 'loading',
          message: `Downloading ${resolved.namespace}/${resolved.name}@${resolved.version}…`,
        });
        const temp = await downloadShard(resolved.tarballUrl);
        ctxCleanupRef.current = temp.cleanup;

        setPhase({ kind: 'loading', message: 'Parsing manifest and schema…' });
        const manifest = await parseManifest(temp.manifest);
        const schema = await parseSchema(temp.schema);

        const prefill = valuesFile ? await loadValuesFile(valuesFile, schema) : {};

        const ctx: PreparedContext = {
          resolved,
          manifest,
          schema,
          tempDir: temp.tempDir,
          tarballSha256: temp.tarball_sha256,
          cleanup: temp.cleanup,
          prefillValues: prefill,
        };

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
      if (ctxCleanupRef.current) {
        ctxCleanupRef.current().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shardRef, valuesFile, yes, vaultRoot]);

  const runNonInteractive = useCallback(
    async (ctx: PreparedContext) => {
      const merged = mergePrefill(ctx.schema, ctx.prefillValues);
      const missing = missingValueKeys(ctx.schema, merged);
      if (missing.length > 0) {
        throw new ShardMindError(
          `Missing required values for --yes: ${missing.join(', ')}`,
          'VALUES_MISSING',
          'Provide them via --values <file> or drop --yes to prompt interactively.',
        );
      }
      const validator = buildValuesValidator(ctx.schema);
      const validated = validator.parse(
        resolveComputedDefaults(ctx.schema, merged),
      ) as Record<string, unknown>;
      await runPlanning(ctx, {
        values: validated,
        selections: defaultModuleSelections(ctx.schema),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const runPlanning = useCallback(
    async (ctx: PreparedContext, result: WizardResult) => {
      try {
        const validator = buildValuesValidator(ctx.schema);
        const validated = validator.parse(result.values) as Record<string, unknown>;
        const validatedResult: WizardResult = {
          values: validated,
          selections: result.selections,
        };

        setPhase({ kind: 'planning', ctx, result: validatedResult });

        const plan = await classifyAdoption({
          vaultRoot,
          schema: ctx.schema,
          manifest: ctx.manifest,
          tempDir: ctx.tempDir,
          values: validated,
          selections: validatedResult.selections,
        });

        if (plan.differs.length === 0 || yes) {
          // --yes auto-resolves every differs as `keep_mine` — preserves
          // the user's bytes, which is the safe default for retroactive
          // adoption (the user opted into keeping the vault they already
          // had). They can re-run with explicit decisions if they want.
          const resolutions: AdoptResolutions = {};
          for (const c of plan.differs) resolutions[c.path] = 'keep_mine';
          await executeAdopt(ctx, validatedResult, plan, resolutions);
          return;
        }

        setPhase({
          kind: 'diff-review',
          ctx,
          result: validatedResult,
          plan,
          currentIndex: 0,
          resolutions: {},
        });
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultRoot, yes, finish],
  );

  const executeAdopt = useCallback(
    async (
      ctx: PreparedContext,
      result: WizardResult,
      plan: AdoptPlan,
      resolutions: AdoptResolutions,
    ) => {
      const start = Date.now();
      const history: string[] = [];

      writingRef.current = true;
      addedPathsRef.current = [];
      backupDirRef.current = null;

      setPhase({
        kind: 'executing',
        total: 0,
        current: 0,
        label: 'Preparing…',
        history,
      });

      try {
        const runResult = await runAdopt({
          vaultRoot,
          manifest: ctx.manifest,
          schema: ctx.schema,
          tempDir: ctx.tempDir,
          resolved: ctx.resolved,
          tarballSha256: ctx.tarballSha256,
          values: result.values,
          selections: result.selections,
          plan,
          resolutions,
          dryRun,
          onBackupReady: (dir) => {
            backupDirRef.current = dir;
          },
          onFileTouched: (rel, introduced) => {
            if (introduced) addedPathsRef.current.push(rel);
          },
          onProgress: (ev) => {
            if (ev.kind === 'start') {
              setPhase((prev) =>
                prev.kind === 'executing'
                  ? { ...prev, total: ev.total, current: 0, label: 'Starting…' }
                  : prev,
              );
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(`${labelForAction(ev.action)} ${ev.outputPath}`);
                if (history.length > 5) history.shift();
              }
              setPhase((prev) => {
                if (prev.kind !== 'executing') return prev;
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

        // State.json is now on disk — past the point-of-no-return.
        // Clear the write guard BEFORE firing the hook so a SIGINT
        // during hook execution can't walk the adopt back. Mirrors
        // install/update.
        writingRef.current = false;

        let hookSummary: HookSummary | null = null;
        if (!ctx.manifest.hooks?.['post-install']) {
          hookSummary = null;
        } else if (dryRun) {
          hookSummary = summarizeHook(await runPostInstallHook(ctx.tempDir, ctx.manifest));
        } else {
          hookAbortRef.current = new AbortController();
          setPhase({
            kind: 'running-hook',
            stage: 'post-install',
            output: '',
            shardLabel: `${ctx.manifest.namespace}/${ctx.manifest.name}`,
          });
          try {
            const hookCtx = {
              vaultRoot,
              values: result.values,
              modules: result.selections,
              shard: { name: ctx.manifest.name, version: ctx.manifest.version },
              valuesAreDefaults: valuesAreDefaults(result.values, ctx.schema),
              newFiles: runResult.summary.installedFresh,
              removedFiles: [],
            };
            const hookResult = await runPostInstallHook(
              ctx.tempDir,
              ctx.manifest,
              hookCtx,
              {
                signal: hookAbortRef.current.signal,
                onStdout: (chunk) => appendHookOutput(setPhase, chunk),
                onStderr: (chunk) => appendHookOutput(setPhase, chunk),
              },
            );
            hookSummary = summarizeHook(hookResult);
          } finally {
            hookAbortRef.current = null;
          }

          await postHookRehash(vaultRoot, runResult.state);
        }

        finish({
          kind: 'summary',
          manifest: ctx.manifest,
          vaultRoot,
          summary: runResult.summary,
          durationMs: Date.now() - start,
          hook: hookSummary,
          dryRun: Boolean(dryRun),
        });
      } catch (err) {
        writingRef.current = false;
        finish({
          kind: 'error',
          error: err as Error,
          detail: dryRun ? undefined : 'Rolled back partial adopt.',
        });
      }
    },
    [vaultRoot, dryRun, verbose, finish],
  );

  const onWizardComplete = useCallback(
    (result: WizardResult) => {
      const current = phaseRef.current;
      if (current.kind !== 'wizard') return;
      void runPlanning(current.ctx, result);
    },
    [runPlanning],
  );

  const onWizardCancel = useCallback(
    () => finish({ kind: 'cancelled', reason: 'User cancelled in wizard.' }),
    [finish],
  );

  const onWizardError = useCallback(
    (err: Error) => finish({ kind: 'error', error: err }),
    [finish],
  );

  const onDiffChoice = useCallback(
    (action: AdoptDiffAction) => {
      const current = phaseRef.current;
      if (current.kind !== 'diff-review') return;
      const target = current.plan.differs[current.currentIndex];
      if (!target) return;
      const next = { ...current.resolutions, [target.path]: action };
      const nextIndex = current.currentIndex + 1;
      if (nextIndex < current.plan.differs.length) {
        setPhase({ ...current, currentIndex: nextIndex, resolutions: next });
        return;
      }
      void executeAdopt(current.ctx, current.result, current.plan, next);
    },
    [executeAdopt],
  );

  return {
    phase,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onDiffChoice,
  };
}

async function loadValuesFile(
  filePath: string,
  schema: ShardSchema,
): Promise<Record<string, unknown>> {
  return loadValuesYaml(filePath, {
    label: '--values file',
    schemaFilter: schema,
    errors: { readFailed: 'VALUES_FILE_READ_FAILED', invalid: 'VALUES_FILE_INVALID' },
  });
}

function labelForAction(kind: AdoptApplyKind): string {
  switch (kind) {
    case 'matches':
      return '✓';
    case 'shard-only':
      return '+';
    case 'differs-keep-mine':
      return '→';
    case 'differs-use-shard':
      return '↻';
  }
}
