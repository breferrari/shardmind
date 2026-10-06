/**
 * The update command's Ink adapter over its UI-free flow (#302).
 *
 * `core/flows/update.ts` runs the update: it reads the install, fetches the
 * new release, migrates the values, plans, writes and runs the hooks. This
 * hook renders what the flow reports as phases and answers the flow's
 * questions from the prompts:
 *   new-values    → `prompt-new-values` (NewValuesPrompt)
 *   new-modules   → `prompt-new-modules` (NewModulesReview)
 *   removed-files → `prompt-removed-files` (RemovedFilesReview)
 *   conflict      → `resolving-conflicts` (DiffView), once per file
 * A conflict's editor rounds (#50) are this hook's: the editor takes the
 * terminal, so only the file's final resolution goes back to the flow.
 *
 * Phase ordering (see docs/IMPLEMENTATION.md §3 and §4.30):
 *   booting → loading → (up-to-date | prompt-new-values →
 *   prompt-new-modules → prompt-removed-files → resolving-conflicts →
 *   writing → running-hook → summary)
 *
 * `--json` never reaches this hook: cli.ts answers it headless
 * (`commands/headless/update.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import path from 'node:path';
import type { ReadStream as TtyReadStream } from 'node:tty';
import { useApp, useStdin } from 'ink';
import type { ShardManifest, ShardState, ModuleSelections } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { DownloadCancelledError } from '../../core/download.js';
import { resolveEngineVersion } from './cli-version.js';
import { useVaultLock } from './use-vault-lock.js';
import type { UpdatePlan, ConflictResolution, NewFilePlan } from '../../core/update-planner.js';
import type { UpdateSummary } from '../../core/update-executor.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { type HookOutcome } from '../../core/hook-orchestrator.js';
import { rollbackDetail } from '../../core/rollback-report.js';
import { FlowCancelled } from '../../core/flows/cancelled.js';
import {
  runUpdateFlow,
  updateRolledBack,
  type UpdateAnswer,
  type UpdateContext,
  type UpdateFlowIO,
  type UpdateQuestion,
} from '../../core/flows/update.js';
import {
  appendHookOutput,
  useSigintRollback,
  isCancelledRun,
  newRunAbort,
  stopRun,
  trackRun,
  type RunInFlight,
} from './shared.js';
import type { DiffAction } from '../../components/DiffView.js';
import { editInEditor, hasConflictMarkers, resolveEditorCommand, withSigintHeld, withTerminalReleased } from '../../core/editor.js';

export interface UseUpdateMachineInput {
  vaultRoot: string;
  yes: boolean;
  verbose: boolean;
  dryRun: boolean;
  /**
   * `--release <v>`: pin to an exact tag (stable or prerelease). Named
   * `--release` rather than `--version` because Pastel reserves the
   * program-level `--version` for printing the package version
   * (`shardmind --version`); a per-command `--version` would collide.
   */
  release?: string;
  /** `--include-prerelease`: widen latest-release resolution to all releases. */
  includePrerelease: boolean;
  /**
   * `--adopt-preexisting` (#61): track a kept add-collision file as the
   * user's modified copy instead of leaving it untracked.
   */
  adoptPreexisting?: boolean;
}

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'up-to-date'; manifest: ShardManifest; state: ShardState }
  | { kind: 'prompt-new-values'; ctx: UpdateContext }
  | { kind: 'prompt-new-modules'; ctx: UpdateContext; values: Record<string, unknown> }
  | {
      kind: 'prompt-removed-files';
      ctx: UpdateContext;
      values: Record<string, unknown>;
      selections: ModuleSelections;
      paths: string[];
      newFilePlan: NewFilePlan;
    }
  | {
      kind: 'resolving-conflicts';
      ctx: UpdateContext;
      plan: UpdatePlan;
      values: Record<string, unknown>;
      selections: ModuleSelections;
      currentIndex: number;
      resolutions: Record<string, ConflictResolution>;
      /** The current file's editor round (#50): attempts, why the last came back, an edit that kept markers. */
      edit?: ConflictEditState;
    }
  | {
      kind: 'writing';
      total: number;
      current: number;
      label: string;
      history: string[];
    }
  | RunningHookPhase // a lifecycle hook (bootstrap re-run / post-update) is
      // streaming output. We are already past the point-of-no-return
      // (state.json written by `runUpdate`); Ctrl+C here kills the child but
      // does NOT roll the update back (Helm semantics, docs/ARCHITECTURE.md
      // §9.3). Shape shared with install via core/hook.ts so
      // `shared.ts::appendHookOutput` narrows generically.
  | {
      kind: 'summary';
      summary: UpdateSummary;
      migrationWarnings: string[];
      hooks: HookOutcome[];
      durationMs: number;
      dryRun: boolean;
      /** Vault-relative POSIX path of the pre-update snapshot; `null` in a dry run. */
      backupDir: string | null;
      externalTools: string[];
    }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseUpdateMachineOutput {
  phase: Phase;
  onNewValuesComplete: (values: Record<string, unknown>) => void;
  onNewModulesComplete: (choices: Record<string, 'included' | 'excluded'>) => void;
  onRemovedFilesComplete: (decisions: Record<string, 'delete' | 'keep'>) => void;
  onConflictChoice: (action: DiffAction) => void;
  /** An editor is set ($VISUAL or $EDITOR), so the conflict prompt offers Open in editor (#50). */
  canEdit: boolean;
}

/** The question the flow is waiting on, answered from its prompt's handler only. */
interface PendingAnswer {
  kind: UpdateQuestion['kind'];
  /** A conflict's file: consecutive conflicts share their kind. */
  index?: number;
  resolve: (answer: unknown) => void;
  reject: (err: Error) => void;
}

export function useUpdateMachine(input: UseUpdateMachineInput): UseUpdateMachineOutput {
  const { vaultRoot, yes, verbose, dryRun, release, includePrerelease, adoptPreexisting = false } = input;
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });
  // The conflict prompt's editor rounds read the file it is on.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  // The update in flight, which a Ctrl+C stops and waits for (#249).
  const runRef = useRef<RunInFlight | null>(null);
  // The hooks' abort while they run: a Ctrl+C then kills the hook but does
  // NOT roll the update back, since `runUpdate` has written state.json.
  const hookAbortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingAnswer | null>(null);

  // One run per vault (#253); --dry-run writes nothing and takes no lock.
  const { take: takeLock, release: releaseLock } = useVaultLock(vaultRoot, 'update', !dryRun);

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (next.kind === 'summary' || next.kind === 'cancelled' || next.kind === 'error' || next.kind === 'up-to-date') {
        // Non-zero exit on error so scripting / CI can detect failure.
        // cancelled + up-to-date + summary are all "successful outcomes"
        // from the engine's perspective and keep the default exit 0.
        if (next.kind === 'error') process.exitCode = 1;
        // The run is over: the next one may start (#253).
        releaseLock();
        setTimeout(() => exit(), 100);
      }
    },
    [exit, releaseLock],
  );

  // Mid-write, a Ctrl+C stops the run and waits for its rollback. Tempdir
  // cleanup fires on every Ctrl+C — otherwise cancelling during the
  // download/plan phase would leak the extracted shard on disk. What the
  // run's rollback could not restore is printed before the exit (#247).
  useSigintRollback({
    isActive: () => !dryRun && runRef.current !== null,
    rollback: () => stopRun(runRef.current),
    cleanup: async () => {
      // A hook in flight dies on every Ctrl+C: past state.json `isActive` is
      // false, and the child must still exit for the parent to.
      hookAbortRef.current?.abort();
      if (ctxCleanupRef.current) await ctxCleanupRef.current();
    },
  });

  useEffect(() => {
    let disposed = false;
    // Stops this run if the effect is superseded before it writes.
    const stop = new AbortController();
    // A superseded run's reports go nowhere.
    const show = (next: Phase | ((prev: Phase) => Phase)) => {
      if (!disposed) setPhase(next);
    };
    const history: string[] = [];
    // This run's handle: a superseded run never clears its successor's.
    let mine: RunInFlight | null = null;
    const dropMine = () => {
      if (runRef.current === mine) runRef.current = null;
    };

    const ask = <Q extends UpdateQuestion>(question: Q): Promise<UpdateAnswer<Q>> =>
      new Promise<UpdateAnswer<Q>>((resolve, reject) => {
        if (disposed) {
          reject(new FlowCancelled('Superseded by a newer run.'));
          return;
        }
        pendingRef.current = {
          kind: question.kind,
          index: question.kind === 'conflict' ? question.currentIndex : undefined,
          resolve: resolve as (answer: unknown) => void,
          reject,
        };
        switch (question.kind) {
          case 'new-values':
            show({ kind: 'prompt-new-values', ctx: question.ctx });
            return;
          case 'new-modules':
            show({ kind: 'prompt-new-modules', ctx: question.ctx, values: question.values });
            return;
          case 'removed-files':
            show({
              kind: 'prompt-removed-files',
              ctx: question.ctx,
              values: question.values,
              selections: question.selections,
              paths: question.paths,
              newFilePlan: question.newFilePlan,
            });
            return;
          case 'conflict':
            show({
              kind: 'resolving-conflicts',
              ctx: question.ctx,
              plan: question.plan,
              values: question.values,
              selections: question.selections,
              currentIndex: question.currentIndex,
              resolutions: question.resolutions,
            });
            return;
        }
      });

    const io: UpdateFlowIO = {
      ask,
      phase: (p) => {
        if (p.kind === 'loading') show({ kind: 'loading', message: p.message });
        else show({ kind: 'writing', total: 0, current: 0, label: 'Preparing…', history });
      },
      progress: (ev) => {
        if (ev.kind === 'start') {
          show((prev) => (prev.kind === 'writing' ? { ...prev, total: ev.total, current: 0, label: 'Starting…' } : prev));
        } else if (ev.kind === 'file') {
          if (verbose) {
            history.push(`${labelForAction(ev.action)} ${ev.outputPath}`);
            if (history.length > 5) history.shift();
          }
          show((prev) =>
            prev.kind === 'writing'
              ? { ...prev, current: ev.index, total: ev.total, label: ev.outputPath, history: verbose ? [...history] : prev.history }
              : prev,
          );
        }
      },
      hooks: {
        setPhase: (p) => show(p),
        onStdout: (chunk) => {
          if (!disposed) appendHookOutput(setPhase, chunk);
        },
        onStderr: (chunk) => {
          if (!disposed) appendHookOutput(setPhase, chunk);
        },
      },
      takeLock,
      onCleanup: (cleanup) => {
        // A superseded run removes its own dir instead of taking the ref.
        if (disposed) void cleanup().catch(() => {});
        else ctxCleanupRef.current = cleanup;
      },
      newRunAbort,
      onRun: (abort, run) => {
        mine = trackRun(abort, run);
        runRef.current = mine;
      },
      // state.json is on disk: drop the run before the hooks, so a Ctrl+C
      // during them can't walk the update back.
      onCommitted: dropMine,
      onHookAbort: (abort) => {
        hookAbortRef.current = abort;
      },
    };

    runUpdateFlow(
      {
        vaultRoot,
        yes,
        dryRun,
        json: false,
        release,
        includePrerelease,
        adoptPreexisting,
        engineVersion: resolveEngineVersion(),
        stop: stop.signal,
      },
      io,
    ).then(
      (result) => {
        if (disposed) return;
        if (result.kind === 'up-to-date') {
          finish({ kind: 'up-to-date', manifest: result.manifest, state: result.state });
          return;
        }
        // A plan comes back only under --json, which runs headless: a bug here.
        if (result.kind === 'plan') {
          finish({ kind: 'error', error: new Error('update flow returned a --json plan to the terminal run') });
          return;
        }
        finish({
          kind: 'summary',
          summary: result.summary,
          migrationWarnings: result.migrationWarnings,
          hooks: result.hooks,
          durationMs: result.durationMs,
          dryRun,
          backupDir: result.backupDir,
          externalTools: result.externalTools,
        });
      },
      (err: unknown) => {
        dropMine();
        // A Ctrl+C mid-download stops the fetch; the command is exiting, so
        // that is not an error to render.
        if (disposed || err instanceof DownloadCancelledError) return;
        if (err instanceof FlowCancelled) {
          finish({ kind: 'cancelled', reason: err.reason });
          return;
        }
        if (isCancelledRun(err)) {
          // The Ctrl+C handler reports any rollback failure and exits 130.
          finish({ kind: 'cancelled', reason: 'Cancelled with Ctrl+C.' });
          return;
        }
        finish({
          kind: 'error',
          error: err as Error,
          detail: updateRolledBack(err) ? rollbackDetail(err, 'Rolled back partial update.') : undefined,
        });
      },
    );

    return () => {
      disposed = true;
      stop.abort();
      // A question the superseded run waits on ends it.
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.reject(new FlowCancelled('Superseded by a newer run.'));
      if (ctxCleanupRef.current) {
        ctxCleanupRef.current().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultRoot, yes, release, includePrerelease]);

  /**
   * Settle the question the flow waits on, if it is the one this prompt
   * answers (a conflict: the same file): a late or doubled handler never
   * answers the next question.
   */
  const settle = useCallback((kind: UpdateQuestion['kind'], outcome: { value: unknown } | { error: Error }, index?: number) => {
    const pending = pendingRef.current;
    if (pending?.kind !== kind || pending.index !== index) return;
    pendingRef.current = null;
    if ('error' in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
  }, []);

  const onNewValuesComplete = useCallback(
    (values: Record<string, unknown>) => settle('new-values', { value: values }),
    [settle],
  );
  const onNewModulesComplete = useCallback(
    (choices: Record<string, 'included' | 'excluded'>) => settle('new-modules', { value: choices }),
    [settle],
  );
  const onRemovedFilesComplete = useCallback(
    (decisions: Record<string, 'delete' | 'keep'>) => settle('removed-files', { value: decisions }),
    [settle],
  );

  const { stdin, isRawModeSupported } = useStdin();
  // The stream's own raw mode, not Ink's setter: Ink counts its users and
  // would leave raw mode on while the prompt holds it (#50). Ink 8 types
  // stdin as any readable stream, so the TTY's setRawMode is checked for.
  const setStreamRawMode = useMemo(
    () =>
      isRawModeSupported && 'setRawMode' in stdin && typeof stdin.setRawMode === 'function'
        ? (on: boolean) => void (stdin as TtyReadStream).setRawMode(on)
        : undefined,
    [stdin, isRawModeSupported],
  );
  // $VISUAL, then $EDITOR; with neither, the prompt offers no editor (#50).
  const [editorCommand] = useState(() => resolveEditorCommand(process.env));

  const onConflictChoice = useCallback(
    (action: DiffAction) => {
      const current = phaseRef.current;
      if (current.kind !== 'resolving-conflicts') return;
      const pc = current.plan.pendingConflicts[current.currentIndex];
      if (!pc) return;
      const edit = current.edit ?? { attempt: 0 };
      const resolve = (resolution: ConflictResolution) => settle('conflict', { value: resolution }, current.currentIndex);

      if (action === 'use_edit') {
        // The one way conflict markers reach the vault: chosen, by name (#50).
        if (edit.pendingContent !== undefined) resolve({ kind: 'edited', content: edit.pendingContent });
        return;
      }
      if (action === 'open_editor' || action === 'edit_again') {
        if (!editorCommand) return;
        const start = action === 'edit_again' && edit.pendingContent !== undefined ? edit.pendingContent : pc.result.content;
        // The editor owns the terminal meanwhile; raw mode comes back on every
        // path, and a Ctrl+C in the editor cancels the edit, not the update.
        // The handoff stops the stdin read too: a TTY pause leaves the libuv
        // read running, and its line-mode ReadConsoleW cancel strands ConPTY (#282).
        const outcome = withSigintHeld(() =>
          withTerminalReleased(setStreamRawMode, () =>
            editInEditor(start, path.basename(pc.path), { command: editorCommand, dir: current.ctx.newTempDir }),
          ),
        );
        if (outcome.kind === 'saved' && !hasConflictMarkers(outcome.content)) {
          resolve({ kind: 'edited', content: outcome.content });
          return;
        }
        // Back to this file's prompt: a cancel is never an accept, and markers
        // left in the edit wait for an explicit choice.
        setPhase({
          ...current,
          edit:
            outcome.kind === 'saved'
              ? { attempt: edit.attempt + 1, pendingContent: outcome.content }
              : { ...edit, attempt: edit.attempt + 1, note: `${outcome.detail} Nothing was written; choose again.` },
        });
        return;
      }
      resolve(action);
    },
    [settle, editorCommand, setStreamRawMode],
  );

  return {
    phase,
    // Only with an editor set and a terminal to hand it (#50).
    canEdit: editorCommand !== undefined && setStreamRawMode !== undefined,
    onNewValuesComplete,
    onNewModulesComplete,
    onRemovedFilesComplete,
    onConflictChoice,
  };
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

/** One file's editor round in the conflict prompt (#50). */
interface ConflictEditState {
  /** Edits started on this file: each return is a new prompt round. */
  attempt: number;
  /** Why the last edit came back without a resolution. */
  note?: string;
  /** Saved text that still has conflict markers, waiting for edit again / use as is / keep mine. */
  pendingContent?: string;
}
