/**
 * The adopt command's Ink adapter over its UI-free flow (#302).
 *
 * `core/flows/adopt.ts` runs the adopt: it fetches the shard, reads the
 * vault, settles the differing files, writes the engine metadata and runs
 * the hooks. This hook renders what the flow reports as phases and answers
 * the flow's questions from the prompts:
 *   values   → `wizard` (AdoptValuesGate, #104)
 *   mode     → `mode-select` (AdoptModePicker)
 *   per-file → `diff-review` (AdoptDiffView), once per file
 *
 * Phase ordering (see docs/IMPLEMENTATION.md §3.5 and §4.30):
 *   booting → loading → wizard → planning →
 *   mode-select → diff-review (loop) → executing → running-hook → summary
 *
 * `--json` never reaches this hook: cli.ts answers it headless
 * (`commands/headless/adopt.ts`). The wiring every machine shares (the
 * pending question, the run a Ctrl+C stops, the lock, the end of the run)
 * is `useFlowRun`'s.
 */

import { useCallback, useEffect } from 'react';
import { useStdin } from 'ink';

import { ShardMindError } from '../../runtime/types.js';
import { resolveEngineVersion } from './cli-version.js';
import { useFlowRun } from './use-flow-run.js';
import type { AdoptPlan, AdoptClassification } from '../../core/adopt-planner.js';
import type { AdoptApplyKind, AdoptResolutions, AdoptSummary as AdoptSummaryData } from '../../core/adopt-executor.js';
import type { ShardManifest } from '../../runtime/types.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { type HookOutcome } from '../../core/hook-orchestrator.js';
import {
  runAdoptFlow,
  type AdoptAnswer,
  type AdoptFileChoice,
  type AdoptFlowIO,
  type AdoptMode,
  type AdoptQuestion,
} from '../../core/flows/adopt.js';
import type { PreparedShard } from '../../core/flows/prepare-shard.js';
import { FlowCancelled } from '../../core/flows/cancelled.js';
import type { ValueAnswers } from '../../core/flows/values.js';

export interface UseAdoptMachineInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  /** Non-interactive batch mode from `--mode`; overrides the picker. */
  mode: AdoptMode | undefined;
  /** `--from-version`: the release the vault was cloned from (#179). */
  fromVersion?: string;
  verbose: boolean;
  dryRun: boolean;
  vaultRoot: string;
}

/** The prepared shard, with the `--values` prefill the values page shows. */
type PreparedContext = PreparedShard & { prefillValues: Record<string, unknown> };

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'wizard'; ctx: PreparedContext }
  | {
      kind: 'planning';
      ctx: PreparedContext;
      result: ValueAnswers;
    }
  | {
      kind: 'mode-select';
      ctx: PreparedContext;
      result: ValueAnswers;
      plan: AdoptPlan;
    }
  | {
      kind: 'diff-review';
      ctx: PreparedContext;
      result: ValueAnswers;
      plan: AdoptPlan;
      // The files that still need a per-file decision. For `decide-per-file`
      // this is every `differs`; for `auto-merge` it's only the conflicting
      // ones (the rest are pre-resolved in `resolutions`).
      queue: AdoptClassification[];
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
  | RunningHookPhase // a lifecycle hook (bootstrap / personalize / legacy
      // post-install) is streaming output. We are already past the
      // point-of-no-return (state.json written by `runAdopt`); a Ctrl+C here
      // kills the child but does NOT roll the adopt back. Helm semantics,
      // docs/ARCHITECTURE.md §9.3. Shape shared with install/update.
  | {
      kind: 'summary';
      manifest: ShardManifest;
      vaultRoot: string;
      summary: AdoptSummaryData;
      durationMs: number;
      hooks: HookOutcome[];
      dryRun: boolean;
      externalTools: string[];
    }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

export interface UseAdoptMachineOutput {
  phase: Phase;
  onWizardComplete: (result: ValueAnswers) => void;
  onWizardCancel: () => void;
  onWizardError: (err: Error) => void;
  onModeSelect: (mode: AdoptMode) => void;
  onDiffChoice: (action: AdoptFileChoice) => void;
}

export function useAdoptMachine(input: UseAdoptMachineInput): UseAdoptMachineOutput {
  const { shardRef, valuesFile, yes, mode, fromVersion, verbose, dryRun, vaultRoot } = input;

  // Without a terminal the flow never prompts: it takes `--values`, or
  // refuses (#139). Ink would otherwise throw "Raw mode is not supported"
  // from inside its own render tree and adopt NOTHING while exiting 0.
  const { isRawModeSupported } = useStdin();

  const { phase, phaseRef, launch, settle } = useFlowRun<Phase>({
    vaultRoot,
    command: 'adopt',
    dryRun,
    initial: { kind: 'booting' },
    isFinal: (p) => p.kind === 'summary' || p.kind === 'cancelled' || p.kind === 'error',
    rolledBackLine: 'Rolled back partial adopt.',
    asPhase: (p) => p,
  });

  useEffect(
    () =>
      launch(async ({ io: base, ask, show, stop }) => {
        // The `--values` prefill the values page shows; known once asked.
        let prefillValues: Record<string, unknown> = {};
        const ctxOf = (shard: PreparedShard): PreparedContext => ({ ...shard, prefillValues });
        const history: string[] = [];
        const io: AdoptFlowIO = {
          ...base,
          ask: <Q extends AdoptQuestion>(question: Q) =>
            ask<AdoptAnswer<Q>>(question, question.kind === 'per-file' ? question.currentIndex : undefined, () => {
              switch (question.kind) {
                case 'values':
                  prefillValues = question.prefill;
                  show({ kind: 'wizard', ctx: ctxOf(question.shard) });
                  return;
                case 'mode':
                  show({ kind: 'mode-select', ctx: ctxOf(question.shard), result: question.answers, plan: question.plan });
                  return;
                case 'per-file':
                  show({
                    kind: 'diff-review',
                    ctx: ctxOf(question.shard),
                    result: question.answers,
                    plan: question.plan,
                    queue: question.queue,
                    currentIndex: question.currentIndex,
                    resolutions: question.resolutions,
                  });
                  return;
              }
            }),
          phase: (p) => {
            if (p.kind === 'loading') show({ kind: 'loading', message: p.message });
            else if (p.kind === 'planning') show({ kind: 'planning', ctx: ctxOf(p.shard), result: p.answers });
            else show({ kind: 'executing', total: 0, current: 0, label: 'Preparing…', history });
          },
          progress: (ev) => {
            if (ev.kind === 'start') {
              show((prev) => (prev.kind === 'executing' ? { ...prev, total: ev.total, current: 0, label: 'Starting…' } : prev));
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(`${labelForAction(ev.action)} ${ev.outputPath}`);
                if (history.length > 5) history.shift();
              }
              show((prev) =>
                prev.kind === 'executing'
                  ? { ...prev, current: ev.index, total: ev.total, label: ev.label, history: verbose ? [...history] : prev.history }
                  : prev,
              );
            }
          },
        };
        const result = await runAdoptFlow(
          {
            shardRef,
            valuesFile,
            yes,
            mode,
            fromVersion,
            dryRun,
            json: false,
            interactive: isRawModeSupported,
            vaultRoot,
            engineVersion: resolveEngineVersion(),
            stop,
          },
          io,
        );
        // A plan comes back only under --json, which runs headless: a bug here.
        if (result.kind === 'plan') return { kind: 'error', error: new Error('adopt flow returned a --json plan to the terminal run') };
        return {
          kind: 'summary',
          manifest: result.shard.manifest,
          vaultRoot,
          summary: result.summary,
          durationMs: result.durationMs,
          hooks: result.hooks,
          dryRun,
          externalTools: result.externalTools,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shardRef, valuesFile, yes, vaultRoot, isRawModeSupported, dryRun, fromVersion],
  );

  const onWizardComplete = useCallback((result: ValueAnswers) => settle('values', { value: result }), [settle]);
  const onWizardCancel = useCallback(() => settle('values', { error: new FlowCancelled('User cancelled in wizard.') }), [settle]);
  const onWizardError = useCallback((err: Error) => settle('values', { error: err }), [settle]);
  const onModeSelect = useCallback((selected: AdoptMode) => settle('mode', { value: selected }), [settle]);
  // The file on screen: a choice made before the next file renders answers
  // only its own file, never the next one's question.
  const onDiffChoice = useCallback(
    (action: AdoptFileChoice) => {
      const current = phaseRef.current;
      if (current.kind === 'diff-review') settle('per-file', { value: action }, current.currentIndex);
    },
    [settle, phaseRef],
  );

  return {
    phase,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onModeSelect,
    onDiffChoice,
  };
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
    case 'differs-merged':
      return '⊕';
  }
}
