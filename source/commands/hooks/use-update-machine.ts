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

import { useCallback, useEffect, useMemo, useState } from 'react';
import path from 'node:path';
import type { ReadStream as TtyReadStream } from 'node:tty';
import { useStdin } from 'ink';
import type { ShardManifest, ShardState, ModuleSelections } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { resolveEngineVersion } from './cli-version.js';
import { useFlowRun } from './use-flow-run.js';
import type { UpdatePlan, ConflictResolution, NewFilePlan } from '../../core/update-planner.js';
import type { UpdateSummary } from '../../core/update-executor.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { type HookOutcome } from '../../core/hook-orchestrator.js';
import {
  runUpdateFlow,
  type UpdateAnswer,
  type UpdateContext,
  type UpdateFlowIO,
  type UpdateQuestion,
} from '../../core/flows/update.js';
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

export function useUpdateMachine(input: UseUpdateMachineInput): UseUpdateMachineOutput {
  const { vaultRoot, yes, verbose, dryRun, release, includePrerelease, adoptPreexisting = false } = input;

  const { phase, setPhase, phaseRef, launch, settle } = useFlowRun<Phase>({
    vaultRoot,
    command: 'update',
    dryRun,
    initial: { kind: 'booting' },
    // cancelled, up-to-date and summary are all successful outcomes and keep exit 0.
    isFinal: (p) => p.kind === 'summary' || p.kind === 'cancelled' || p.kind === 'error' || p.kind === 'up-to-date',
    rolledBack: 'Rolled back partial update.',
    asPhase: (p) => p,
  });

  useEffect(
    () =>
      launch(async ({ io: base, ask, show, stop }) => {
        const history: string[] = [];
        const io: UpdateFlowIO = {
          ...base,
          ask: <Q extends UpdateQuestion>(question: Q) =>
            ask<UpdateAnswer<Q>>(question, question.kind === 'conflict' ? question.currentIndex : undefined, () => {
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
            }),
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
        };
        const result = await runUpdateFlow(
          {
            vaultRoot,
            yes,
            dryRun,
            json: false,
            release,
            includePrerelease,
            adoptPreexisting,
            engineVersion: resolveEngineVersion(),
            stop,
          },
          io,
        );
        if (result.kind === 'up-to-date') return { kind: 'up-to-date', manifest: result.manifest, state: result.state };
        // A plan comes back only under --json, which runs headless: a bug here.
        if (result.kind === 'plan') return { kind: 'error', error: new Error('update flow returned a --json plan to the terminal run') };
        return {
          kind: 'summary',
          summary: result.summary,
          migrationWarnings: result.migrationWarnings,
          hooks: result.hooks,
          durationMs: result.durationMs,
          dryRun,
          backupDir: result.backupDir,
          externalTools: result.externalTools,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultRoot, yes, release, includePrerelease],
  );

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
    [settle, phaseRef, setPhase, editorCommand, setStreamRawMode],
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
