/**
 * The install command's Ink adapter over its UI-free flow (#302).
 *
 * `core/flows/install.ts` runs the install: it fetches the shard, asks what
 * it needs, plans, writes on the vault transaction and runs the hooks. This
 * hook renders what the flow reports as phases and answers the flow's
 * questions from the prompts:
 *   gate      → `gate` (ExistingInstallGate)
 *   values    → `wizard` (InstallWizard)
 *   collision → `collision` (CollisionReview)
 *
 * Phase ordering (see docs/IMPLEMENTATION.md §4.30 step 9):
 *   booting → loading → (gate) → wizard → (collision) → installing →
 *   running-hook → summary
 *
 * The destination was decided before the run (`install-destination.ts`,
 * #333). The wiring every machine shares (the pending question, the run a
 * Ctrl+C stops, the lock, the end of the run) is `useFlowRun`'s.
 */

import { useCallback, useEffect } from 'react';
import { useStdin } from 'ink';

import type { ShardManifest, ShardState } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import type { Collision } from '../../core/install-planner.js';
import type { BackupRecord } from '../../core/install-executor.js';
import type { InstallDestination } from '../../core/install-destination.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { type HookOutcome } from '../../core/hook-orchestrator.js';
import { FlowCancelled } from '../../core/flows/cancelled.js';
import {
  runInstallFlow,
  type InstallAnswer,
  type InstallFlowIO,
  type InstallQuestion,
  type InstallShard,
} from '../../core/flows/install.js';
import { resolveEngineVersion } from './cli-version.js';
import { useFlowRun } from './use-flow-run.js';

import type { WizardResult } from '../../components/InstallWizard.js';
import type { CollisionAction } from '../../components/CollisionReview.js';
import type { GateChoice } from '../../components/ExistingInstallGate.js';

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'gate'; state: ShardState; ctx: InstallShard }
  | { kind: 'wizard'; ctx: InstallShard }
  | { kind: 'collision'; collisions: Collision[]; ctx: InstallShard }
  | { kind: 'installing'; total: number; current: number; label: string; history: string[] }
  | RunningHookPhase // a lifecycle hook (bootstrap / personalize / legacy
      // post-install) is streaming output. We are already past the
      // point-of-no-return (state.json written); a Ctrl+C here kills the child
      // but does NOT roll the install back. See docs/ARCHITECTURE.md §9.3 for
      // the Helm-style contract.
  | { kind: 'summary'; manifest: ShardManifest; vaultRoot: string; folder: string | null; fileCount: number; durationMs: number; backups: BackupRecord[]; replaced: string[]; removed: string[]; keptStale: string[]; hooks: HookOutcome[]; dryRun: boolean; externalTools: string[] }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseInstallMachineInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  /**
   * `--defaults` — Invariant 1 mode. Mutually exclusive with `--values`;
   * refuses to overwrite an existing install. Implies `--yes` semantics.
   */
  defaults: boolean;
  /**
   * `--force` (#55) — answer both destructive prompts: reinstall over an
   * existing install without the gate, and overwrite colliding files
   * without a backup. Answers nothing else; values come as usual.
   */
  force: boolean;
  verbose: boolean;
  dryRun: boolean;
  /** Where the vault goes (#333), decided before the run (`install-destination.ts`). */
  destination: InstallDestination;
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
  const { shardRef, valuesFile, yes, defaults, force, verbose, dryRun, destination } = input;

  // Whether a prompt can run at all, from Ink's own stdin (the injected stub
  // under ink-testing-library, the real handle in production). Without one
  // the flow never asks: Ink would throw "Raw mode is not supported" inside
  // its render tree, install NOTHING and exit 0 (#139).
  const { isRawModeSupported } = useStdin();

  const { phase, launch, settle } = useFlowRun<Phase>({
    vaultRoot: destination.root,
    command: 'install',
    dryRun,
    initial: { kind: 'booting' },
    isFinal: (p) => p.kind === 'summary' || p.kind === 'cancelled' || p.kind === 'error',
    rolledBackLine: 'Rolled back partial install (including any pre-install backups).',
    asPhase: (p) => p,
  });

  useEffect(
    () =>
      launch(async ({ io: base, ask, show, stop }) => {
        const history: string[] = [];
        const io: InstallFlowIO = {
          ...base,
          ask: <Q extends InstallQuestion>(question: Q) =>
            ask<InstallAnswer<Q>>(question, undefined, () => {
              switch (question.kind) {
                case 'gate':
                  show({ kind: 'gate', state: question.state, ctx: question.shard });
                  return;
                case 'values':
                  show({ kind: 'wizard', ctx: question.shard });
                  return;
                case 'collision':
                  show({ kind: 'collision', collisions: question.collisions, ctx: question.shard });
                  return;
              }
            }),
          phase: (p) => {
            if (p.kind === 'loading') show({ kind: 'loading', message: p.message });
            else show({ kind: 'installing', total: 0, current: 0, label: 'Preparing…', history });
          },
          progress: (ev) => {
            if (ev.kind === 'start') {
              show((prev) =>
                prev.kind === 'installing' && (prev.total !== ev.total || prev.current !== 0)
                  ? { ...prev, total: ev.total, current: 0, label: 'Starting…' }
                  : prev,
              );
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(ev.outputPath);
                if (history.length > 5) history.shift();
              }
              show((prev) => {
                if (prev.kind !== 'installing') return prev;
                if (prev.current === ev.index && prev.label === ev.label) return prev;
                return { ...prev, current: ev.index, total: ev.total, label: ev.label, history: verbose ? [...history] : prev.history };
              });
            }
          },
        };
        const result = await runInstallFlow(
          {
            shardRef,
            valuesFile,
            yes,
            defaults,
            force,
            dryRun,
            interactive: isRawModeSupported,
            destination,
            engineVersion: resolveEngineVersion(),
            stop,
          },
          io,
        );
        return { ...result, kind: 'summary' };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shardRef, valuesFile, yes, defaults, force, isRawModeSupported],
  );

  const onGateChoice = useCallback((choice: GateChoice) => settle('gate', { value: choice }), [settle]);
  const onWizardComplete = useCallback((result: WizardResult) => settle('values', { value: result }), [settle]);
  const onWizardCancel = useCallback(() => settle('values', { error: new FlowCancelled('User cancelled in wizard.') }), [settle]);
  const onWizardError = useCallback((err: Error) => settle('values', { error: err }), [settle]);
  const onCollisionChoice = useCallback((action: CollisionAction) => settle('collision', { value: action }), [settle]);

  return {
    phase,
    onGateChoice,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onCollisionChoice,
  };
}
