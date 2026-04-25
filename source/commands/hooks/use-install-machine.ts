/**
 * State machine + async orchestration for the install command.
 *
 * Owns every side-effecting transition (resolve, download, parse,
 * collision detection, backup, render, rollback, hook invocation)
 * behind a hook interface so commands/install.tsx stays thin
 * presentation. The update command (Milestone 4) is expected to
 * reuse the same machine with a few added phase variants.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { useApp } from 'ink';
import { loadValuesYaml } from '../../core/values-io.js';

import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  ResolvedShard,
} from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';

import { resolve as resolveRef } from '../../core/registry.js';
import { downloadShard } from '../../core/download.js';
import { parseManifest } from '../../core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../core/schema.js';
import { readState, rehashManagedFiles, writeState } from '../../core/state.js';
import { valuesAreDefaults } from '../../core/values-defaults.js';
import {
  planOutputs,
  detectCollisions,
  mergePrefill,
  resolveComputedDefaults,
  missingValueKeys,
  defaultModuleSelections,
  type Collision,
} from '../../core/install-planner.js';
import {
  backupCollisions,
  runInstall,
  rollbackInstall,
  type BackupRecord,
} from '../../core/install-executor.js';
import { runPostInstallHook, type RunningHookPhase } from '../../core/hook.js';
import { SHARDMIND_DIR, VALUES_FILE } from '../../runtime/vault-paths.js';
import { appendHookOutput, summarizeHook, useSigintRollback, type HookSummary } from './shared.js';

import type { WizardResult } from '../../components/InstallWizard.js';
import type { CollisionAction } from '../../components/CollisionReview.js';
import type { GateChoice } from '../../components/ExistingInstallGate.js';

export interface PreparedContext {
  resolved: ResolvedShard;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  tarballSha256: string;
  cleanup: () => Promise<void>;
  prefillValues: Record<string, unknown>;
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
}

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'gate'; state: ShardState; ctx: PreparedContext }
  | { kind: 'wizard'; ctx: PreparedContext }
  | { kind: 'collision'; collisions: Collision[]; result: WizardResult; ctx: PreparedContext }
  | { kind: 'installing'; total: number; current: number; label: string; history: string[]; ctx: PreparedContext; result: WizardResult; backups: BackupRecord[] }
  | (RunningHookPhase & {
      // Subprocess-backed post-install hook is streaming output. We are
      // already past the point-of-no-return (state.json written); a Ctrl+C
      // in this phase kills the child but does NOT roll the install back.
      // See docs/ARCHITECTURE.md §9.3 for the Helm-style contract.
      //
      // The variant's shape is defined in `source/core/hook.ts` as
      // `RunningHookPhase` and shared between install and update so
      // `appendHookOutput` in shared.ts can narrow generically.
      stage: 'post-install';
    })
  | { kind: 'summary'; manifest: ShardManifest; vaultRoot: string; fileCount: number; durationMs: number; backups: BackupRecord[]; hook: HookSummary | null; dryRun: boolean }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseInstallMachineInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  verbose: boolean;
  dryRun: boolean;
  vaultRoot: string;
}

export interface UseInstallMachineOutput {
  phase: Phase;
  onGateChoice: (choice: GateChoice) => void;
  onWizardComplete: (result: WizardResult) => void;
  onWizardCancel: () => void;
  onWizardError: (err: Error) => void;
  onCollisionChoice: (action: CollisionAction) => void;
}

export function useInstallMachine(input: UseInstallMachineInput): UseInstallMachineOutput {
  const { shardRef, valuesFile, yes, verbose, dryRun, vaultRoot } = input;
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });

  // Refs tracked during runInstall so a SIGINT handler can roll back
  // any files written so far and restore any backups created during
  // collision handling.
  const writtenPathsRef = useRef<string[]>([]);
  const backupsRef = useRef<BackupRecord[]>([]);
  const installingRef = useRef(false);
  // AbortController that owns the currently-executing post-install hook.
  // Null when no hook is in flight. Ctrl+C in the running-hook phase
  // aborts the subprocess but does NOT roll back the install (we're
  // already past the point-of-no-return — see the running-hook phase
  // docstring for the Helm-style contract).
  const hookAbortRef = useRef<AbortController | null>(null);
  // Shard tempdir cleanup, populated once the shard download completes.
  // A SIGINT between download and wizard-submit needs to run this.
  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  // Mutable pointer to the latest handleWizardComplete closure so
  // runNonInteractive can call it without circular useCallback deps.
  const handleWizardCompleteRef = useRef<(r: WizardResult, c: PreparedContext) => Promise<void>>(
    async () => {},
  );

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (next.kind === 'summary' || next.kind === 'cancelled' || next.kind === 'error') {
        // Set the exit code BEFORE scheduling the Ink teardown so the
        // process exits non-zero on error. Success and user-cancel stay
        // at 0 — cancelled is the user's choice, not a failure.
        if (next.kind === 'error') process.exitCode = 1;
        setTimeout(() => exit(), 100);
      }
    },
    [exit],
  );

  // If a render is in progress when the user hits Ctrl+C, roll back
  // partial writes and restore backups before exiting. `cleanup` drops
  // the shard tempdir regardless of phase — without it, cancelling at
  // the wizard or collision screens leaks the extracted shard on disk.
  useSigintRollback({
    isActive: () => !dryRun && installingRef.current,
    rollback: () => rollbackInstall(vaultRoot, writtenPathsRef.current, backupsRef.current),
    cleanup: async () => {
      // Abort any in-flight post-install hook subprocess. Intentionally
      // runs on every Ctrl+C, regardless of `isActive` — during the
      // running-hook phase `isActive` is already false (state.json has
      // been written) so the install-rollback path won't fire, and we
      // still need the child to die so the parent process exits.
      hookAbortRef.current?.abort();
      if (ctxCleanupRef.current) await ctxCleanupRef.current();
    },
  });

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        setPhase({ kind: 'loading', message: `Resolving ${shardRef}…` });
        const resolved = await resolveRef(shardRef);

        setPhase({ kind: 'loading', message: `Downloading ${resolved.namespace}/${resolved.name}@${resolved.version}…` });
        const temp = await downloadShard(resolved.tarballUrl);
        ctxCleanupRef.current = temp.cleanup;

        setPhase({ kind: 'loading', message: 'Parsing manifest and schema…' });
        const manifest = await parseManifest(temp.manifest);
        const schema = await parseSchema(temp.schema);

        const prefill = valuesFile ? await loadValuesFile(valuesFile, schema) : {};

        const { moduleFileCounts, alwaysIncludedFileCount } = await planOutputs(
          schema,
          temp.tempDir,
          defaultModuleSelections(schema),
        );

        // `prefillValues` carries the *raw* user input from --values (or {}).
        // Both the wizard and the non-interactive path merge schema defaults
        // in themselves (`mergePrefill`). Threading raw user input lets the
        // wizard distinguish user-supplied vs default-supplied values, which
        // matters under v6 where every value has a default.
        const ctx: PreparedContext = {
          resolved,
          manifest,
          schema,
          tempDir: temp.tempDir,
          tarballSha256: temp.tarball_sha256,
          cleanup: temp.cleanup,
          prefillValues: prefill,
          moduleFileCounts,
          alwaysIncludedFileCount,
        };

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
      if (ctxCleanupRef.current) {
        ctxCleanupRef.current().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shardRef, valuesFile, yes]);

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
          tarballSha256: ctx.tarballSha256,
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

        // State.json is now on disk — we're past the point-of-no-return.
        // Clear the rollback guard BEFORE firing the hook so a SIGINT
        // during hook execution can't walk the install back. The only
        // remaining work (hook subprocess) is non-fatal per spec §9.3.
        installingRef.current = false;

        let hookSummary: HookSummary | null = null;
        if (!ctx.manifest.hooks?.['post-install']) {
          // No hook declared — nothing to render.
          hookSummary = null;
        } else if (dryRun) {
          // Dry run: call runPostInstallHook WITHOUT a ctx so the hook
          // module surfaces `deferred` (its "lookup only" shape). The
          // summary renders this as a dim "skipped (dry run)" note per
          // the contract in docs/ARCHITECTURE.md §9.3. A dry run must
          // still tell the user the hook WOULD have fired — going
          // silent here contradicts the rest of the dry-run UX.
          hookSummary = summarizeHook(await runPostInstallHook(ctx.tempDir, ctx.manifest));
        } else {
          // Live-output phase while the hook runs. A fresh AbortController
          // per run; cleared in a finally so repeat installs (test harness)
          // get a clean slate.
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
              // Spec: empty on a clean install — every file is new, so the
              // signal would be uninformative. Adopt (#77) populates this
              // separately when the same hook fires after a 2-way diff.
              newFiles: [],
              removedFiles: [],
            };
            const hookResult = await runPostInstallHook(ctx.tempDir, ctx.manifest, hookCtx, {
              signal: hookAbortRef.current.signal,
              onStdout: (chunk) => appendHookOutput(setPhase, chunk),
              onStderr: (chunk) => appendHookOutput(setPhase, chunk),
            });
            hookSummary = summarizeHook(hookResult);
          } finally {
            hookAbortRef.current = null;
          }

          // Re-hash managed files after the hook exits — success OR
          // failure. The hook contract is non-fatal (Helm pattern), but
          // state.json must reflect actual file content so the next
          // status run doesn't surface spurious drift on paths the hook
          // legitimately edited. See docs/SHARD-LAYOUT.md §Hooks, state,
          // and re-hash semantics.
          try {
            const rehash = await rehashManagedFiles(vaultRoot, runResult.state);
            if (rehash.changed.length > 0 || rehash.missing.length > 0 || rehash.failed.length > 0) {
              await writeState(vaultRoot, rehash.state);
            }
          } catch {
            // Defensive: rehash should not throw (per-file errors are
            // tolerated internally). If something at the writeState
            // layer does, the prior state.json stays — drift detection
            // surfaces the discrepancy on the next status run.
          }
        }

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

  const onCollisionChoice = useCallback(
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

  const onGateChoice = useCallback(
    (choice: GateChoice) => {
      if (phase.kind !== 'gate') return;
      if (choice === 'cancel') {
        finish({ kind: 'cancelled', reason: 'User cancelled at existing-install gate.' });
        return;
      }
      if (choice === 'update') {
        finish({
          kind: 'cancelled',
          reason: 'Existing install preserved. Run `shardmind update` to pick up a newer version, or re-run `install` and pick Reinstall for a fresh start.',
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

  const onWizardComplete = useCallback(
    (result: WizardResult) => {
      if (phase.kind !== 'wizard') return;
      void handleWizardComplete(result, phase.ctx);
    },
    [phase, handleWizardComplete],
  );

  const onWizardCancel = useCallback(
    () => finish({ kind: 'cancelled', reason: 'User cancelled in wizard.' }),
    [finish],
  );

  const onWizardError = useCallback(
    (err: Error) => finish({ kind: 'error', error: err }),
    [finish],
  );

  return {
    phase,
    onGateChoice,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onCollisionChoice,
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

