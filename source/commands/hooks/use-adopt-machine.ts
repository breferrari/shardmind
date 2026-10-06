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
 * (`commands/headless/adopt.ts`). Reuses `useSigintRollback` and
 * `appendHookOutput` from `shared.ts`, so install / update / adopt can't
 * drift on either.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useStdin } from 'ink';

import { ShardMindError } from '../../runtime/types.js';
import { DownloadCancelledError } from '../../core/download.js';
import { resolveEngineVersion } from './cli-version.js';
import { useVaultLock } from './use-vault-lock.js';
import type { AdoptPlan, AdoptClassification } from '../../core/adopt-planner.js';
import type { AdoptApplyKind, AdoptResolutions, AdoptSummary as AdoptSummaryData } from '../../core/adopt-executor.js';
import type { ShardManifest } from '../../runtime/types.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { type HookOutcome } from '../../core/hook-orchestrator.js';
import { rollbackDetail } from '../../core/rollback-report.js';
import {
  runAdoptFlow,
  adoptRolledBack,
  FlowCancelled,
  type AdoptAnswer,
  type AdoptFileChoice,
  type AdoptFlowIO,
  type AdoptMode,
  type AdoptQuestion,
} from '../../core/flows/adopt.js';
import type { PreparedShard } from '../../core/flows/prepare-shard.js';
import type { ValueAnswers } from '../../core/flows/values.js';
import {
  appendHookOutput,
  useSigintRollback,
  isCancelledRun,
  newRunAbort,
  stopRun,
  trackRun,
  type RunInFlight,
} from './shared.js';

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
export type PreparedContext = PreparedShard & { prefillValues: Record<string, unknown> };

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

/** The question the flow is waiting on, answered from its prompt's handler only. */
interface PendingAnswer {
  kind: AdoptQuestion['kind'];
  resolve: (answer: unknown) => void;
  reject: (err: Error) => void;
}

export function useAdoptMachine(input: UseAdoptMachineInput): UseAdoptMachineOutput {
  const { shardRef, valuesFile, yes, mode, fromVersion, verbose, dryRun, vaultRoot } = input;
  const { exit } = useApp();

  // Without a terminal the flow never prompts: it takes `--values`, or
  // refuses (#139). Ink would otherwise throw "Raw mode is not supported"
  // from inside its own render tree and adopt NOTHING while exiting 0.
  const { isRawModeSupported } = useStdin();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });

  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  // The adopt in flight, which a Ctrl+C stops and waits for (#249).
  const runRef = useRef<RunInFlight | null>(null);
  const hookAbortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingAnswer | null>(null);

  // One run per vault (#253); --dry-run writes nothing and takes no lock.
  const { take: takeLock, release: releaseLock } = useVaultLock(vaultRoot, 'adopt', !dryRun);

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (next.kind === 'summary' || next.kind === 'cancelled' || next.kind === 'error') {
        if (next.kind === 'error') process.exitCode = 1;
        // The run is over: the next one may start (#253).
        releaseLock();
        setTimeout(() => exit(), 100);
      }
    },
    [exit, releaseLock],
  );

  // Mid-write SIGINT: the flow's executor rolls back once the abort stops
  // it. Tempdir cleanup fires on every Ctrl+C so we don't leak the
  // extracted shard. Mirrors `useUpdateMachine`'s rollback wiring.
  useSigintRollback({
    isActive: () => !dryRun && runRef.current !== null,
    rollback: () => stopRun(runRef.current),
    cleanup: async () => {
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
    // The `--values` prefill the values page shows; known once asked.
    let prefillValues: Record<string, unknown> = {};
    const ctxOf = (shard: PreparedShard): PreparedContext => ({ ...shard, prefillValues });
    const history: string[] = [];

    const ask = <Q extends AdoptQuestion>(question: Q): Promise<AdoptAnswer<Q>> =>
      new Promise<AdoptAnswer<Q>>((resolve, reject) => {
        if (disposed) {
          reject(new FlowCancelled('Superseded by a newer run.'));
          return;
        }
        pendingRef.current = { kind: question.kind, resolve: resolve as (answer: unknown) => void, reject };
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
      });

    const io: AdoptFlowIO = {
      ask,
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
        runRef.current = trackRun(abort, run);
      },
      // state.json is on disk: drop the run before the hooks, so a Ctrl+C
      // during them can't walk the adopt back.
      onCommitted: () => {
        runRef.current = null;
      },
      onHookAbort: (abort) => {
        hookAbortRef.current = abort;
      },
    };

    runAdoptFlow(
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
        stop: stop.signal,
      },
      io,
    ).then(
      (result) => {
        if (disposed) return;
        // A plan comes back only under --json, which runs headless.
        if (result.kind === 'plan') {
          finish({ kind: 'cancelled', reason: 'Plan only (--json).' });
          return;
        }
        finish({
          kind: 'summary',
          manifest: result.shard.manifest,
          vaultRoot,
          summary: result.summary,
          durationMs: result.durationMs,
          hooks: result.hooks,
          dryRun,
          externalTools: result.externalTools,
        });
      },
      (err: unknown) => {
        runRef.current = null;
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
          detail: adoptRolledBack(err) ? rollbackDetail(err, 'Rolled back partial adopt.') : undefined,
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
  }, [shardRef, valuesFile, yes, vaultRoot, isRawModeSupported, dryRun, fromVersion]);

  /**
   * Settle the question the flow waits on, if it is the one this prompt
   * answers: a late or doubled handler never answers the next question.
   */
  const settle = useCallback((kind: AdoptQuestion['kind'], outcome: { value: unknown } | { error: Error }) => {
    const pending = pendingRef.current;
    if (pending?.kind !== kind) return;
    pendingRef.current = null;
    if ('error' in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
  }, []);

  const onWizardComplete = useCallback((result: ValueAnswers) => settle('values', { value: result }), [settle]);
  const onWizardCancel = useCallback(() => settle('values', { error: new FlowCancelled('User cancelled in wizard.') }), [settle]);
  const onWizardError = useCallback((err: Error) => settle('values', { error: err }), [settle]);
  const onModeSelect = useCallback((selected: AdoptMode) => settle('mode', { value: selected }), [settle]);
  const onDiffChoice = useCallback((action: AdoptFileChoice) => settle('per-file', { value: action }), [settle]);

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
