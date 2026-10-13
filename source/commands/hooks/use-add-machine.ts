/**
 * The add command's Ink adapter over its UI-free flow (#396).
 *
 * `core/flows/add.ts` runs the add: it fetches the overlay, asks what it
 * needs, refuses a path another shard owns, writes on the vault's `add`
 * transaction and runs the overlay's hooks. This hook renders what the flow
 * reports as phases and answers its questions from the prompts:
 *   values    → `wizard` (InstallWizard)
 *   collision → `collision` (CollisionReview)
 *
 * Phase ordering (docs/IMPLEMENTATION.md §4.30 step 10):
 *   booting → loading → wizard → (collision) → installing → running-hook → summary
 *
 * The vault was found before the run (`findVault`), so the lock is taken on
 * it. The wiring every machine shares is `useFlowRun`'s.
 */

import { useCallback, useEffect } from 'react';
import { useStdin } from 'ink';

import type { ShardManifest } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import type { Collision } from '../../core/install-planner.js';
import type { BackupRecord } from '../../core/install-executor.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { type HookOutcome } from '../../core/hook-orchestrator.js';
import { FlowCancelled } from '../../core/flows/cancelled.js';
import { runAddFlow, type AddAnswer, type AddFlowIO, type AddQuestion, type AddShard } from '../../core/flows/add.js';
import { resolveEngineVersion } from './cli-version.js';
import { useFlowRun } from './use-flow-run.js';

import type { WizardResult } from '../../components/InstallWizard.js';
import type { CollisionAction } from '../../components/CollisionReview.js';

export type AddPhase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'wizard'; ctx: AddShard }
  | { kind: 'collision'; collisions: Collision[]; ctx: AddShard }
  | { kind: 'installing'; total: number; current: number; label: string; history: string[] }
  // The overlay's hooks; past state.json, a Ctrl+C kills the child but does
  // not roll the add back (ARCHITECTURE §9.3).
  | RunningHookPhase
  | { kind: 'summary'; manifest: ShardManifest; vaultRoot: string; base: string; fileCount: number; durationMs: number; backups: BackupRecord[]; replaced: string[]; hooks: HookOutcome[]; dryRun: boolean; externalTools: string[] }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseAddMachineInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  defaults: boolean;
  verbose: boolean;
  dryRun: boolean;
  skipHooks: boolean;
  /** The vault the overlay goes into, found before the run. */
  vaultRoot: string;
}

export interface UseAddMachineOutput {
  phase: AddPhase;
  onWizardComplete: (result: WizardResult) => void;
  onWizardCancel: () => void;
  onWizardError: (err: Error) => void;
  onCollisionChoice: (action: CollisionAction) => void;
}

export function useAddMachine(input: UseAddMachineInput): UseAddMachineOutput {
  const { shardRef, valuesFile, yes, defaults, verbose, dryRun, skipHooks, vaultRoot } = input;
  // Without a terminal to prompt on, the flow never asks (#139).
  const { isRawModeSupported } = useStdin();

  const { phase, launch, settle } = useFlowRun<AddPhase>({
    vaultRoot,
    command: 'add',
    dryRun,
    initial: { kind: 'booting' },
    isFinal: (p) => p.kind === 'summary' || p.kind === 'cancelled' || p.kind === 'error',
    rolledBackLine: 'Rolled back the partial add: the vault is as it was.',
    asPhase: (p) => p,
  });

  useEffect(
    () =>
      launch(async ({ io: base, ask, show, stop }) => {
        const history: string[] = [];
        const io: AddFlowIO = {
          ...base,
          ask: <Q extends AddQuestion>(question: Q) =>
            ask<AddAnswer<Q>>(question, undefined, () => {
              if (question.kind === 'values') show({ kind: 'wizard', ctx: question.shard });
              else show({ kind: 'collision', collisions: question.collisions, ctx: question.shard });
            }),
          phase: (p) => {
            if (p.kind === 'loading') show({ kind: 'loading', message: p.message });
            else show({ kind: 'installing', total: 0, current: 0, label: 'Preparing…', history });
          },
          progress: (ev) => {
            if (ev.kind === 'start') {
              show((prev) => (prev.kind === 'installing' ? { ...prev, total: ev.total, current: 0, label: 'Starting…' } : prev));
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(ev.outputPath);
                if (history.length > 5) history.shift();
              }
              show((prev) =>
                prev.kind === 'installing'
                  ? { ...prev, current: ev.index, total: ev.total, label: ev.label, history: verbose ? [...history] : prev.history }
                  : prev,
              );
            }
          },
        };
        const result = await runAddFlow(
          {
            shardRef,
            valuesFile,
            yes,
            defaults,
            dryRun,
            skipHooks,
            interactive: isRawModeSupported,
            vaultRoot,
            engineVersion: resolveEngineVersion(),
            stop,
          },
          io,
        );
        return { ...result, kind: 'summary' };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shardRef, valuesFile, yes, defaults, isRawModeSupported],
  );

  const onWizardComplete = useCallback((result: WizardResult) => settle('values', { value: result }), [settle]);
  const onWizardCancel = useCallback(() => settle('values', { error: new FlowCancelled('User cancelled in wizard.') }), [settle]);
  const onWizardError = useCallback((err: Error) => settle('values', { error: err }), [settle]);
  const onCollisionChoice = useCallback((action: CollisionAction) => settle('collision', { value: action }), [settle]);

  return { phase, onWizardComplete, onWizardCancel, onWizardError, onCollisionChoice };
}
