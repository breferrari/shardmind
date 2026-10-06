/**
 * What every command's Ink machine needs around its UI-free flow (#302).
 * Spec: docs/IMPLEMENTATION.md §4.30 step 10. The machine keeps how its
 * questions, progress and result show; this hook holds the rest:
 *
 * - the question the flow waits on, answered only from its own prompt
 *   (`settle`), and ended with `FlowCancelled` when the run is superseded;
 * - the run handle a Ctrl+C stops and waits for (#249), cleared only by
 *   the run that set it; the hooks' abort; the temp dir's cleanup, run on
 *   every Ctrl+C and on supersession (`useSigintRollback`);
 * - the vault lock (#253), released when the run ends;
 * - the end of the run: the final phase, the exit code, the error view's
 *   rollback line.
 */

import { useCallback, useRef, useState } from 'react';
import { useApp } from 'ink';
import { DownloadCancelledError } from '../../core/download.js';
import { FlowCancelled } from '../../core/flows/cancelled.js';
import type { FlowRunIO } from '../../core/flows/run.js';
import type { RunningHookPhase } from '../../core/hook.js';
import { rollbackDetail, wasRolledBack } from '../../core/rollback-report.js';
import { useVaultLock } from './use-vault-lock.js';
import { appendHookOutput, isCancelledRun, newRunAbort, stopRun, trackRun, useSigintRollback, type RunInFlight } from './shared.js';

/** The phases every machine has, besides its own. */
export type BasePhase = { kind: 'cancelled'; reason: string } | { kind: 'error'; error: Error; detail?: string } | RunningHookPhase;

/** The question the flow waits on: its kind, and for an iterated question its index. */
interface PendingAnswer {
  kind: string;
  index?: number;
  resolve: (answer: unknown) => void;
  reject: (err: Error) => void;
}

/** What `launch`'s `start` gets: the flow's io, less the members each command adds. */
export interface FlowRunContext<P> {
  io: FlowRunIO;
  /** Ask the flow's question: `show` renders it; the answer comes from `settle`. */
  ask<A>(question: { kind: string }, index: number | undefined, show: () => void): Promise<A>;
  /** Set the phase, unless this run was superseded. */
  show(next: P | ((prev: P) => P)): void;
  /** Aborted when this run is superseded. */
  stop: AbortSignal;
}

export function useFlowRun<P extends { kind: string }>(opts: {
  vaultRoot: string;
  command: 'install' | 'update' | 'adopt';
  dryRun: boolean;
  initial: P;
  /** The phases that end the run: the lock is released and the app exits. */
  isFinal: (phase: P) => boolean;
  /** The error view's line when the run rolled the vault back. */
  rolledBackLine: string;
  /**
   * `(p) => p`: compiles only when the machine's phases include the ones
   * every machine has (cancelled, error, a running hook), so none is cast.
   */
  asPhase: (phase: BasePhase) => P;
}) {
  const { vaultRoot, command, dryRun, rolledBackLine, asPhase } = opts;
  const { exit } = useApp();
  const [phase, setPhase] = useState<P>(opts.initial);
  // A prompt's handler reads the phase it answers (the file on screen).
  const phaseRef = useRef<P>(phase);
  phaseRef.current = phase;

  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const runRef = useRef<RunInFlight | null>(null);
  // The hooks' abort while they run: a Ctrl+C kills the hook but does NOT
  // roll the run back, since state.json is written.
  const hookAbortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingAnswer | null>(null);

  // One run per vault (#253); --dry-run writes nothing and takes no lock.
  const { take: takeLock, release: releaseLock } = useVaultLock(vaultRoot, command, !dryRun);

  const finish = useCallback(
    (next: P) => {
      setPhase(next);
      if (opts.isFinal(next)) {
        // Non-zero on error so scripts can tell; cancelled is the user's choice.
        if (next.kind === 'error') process.exitCode = 1;
        // The run is over: the next one may start (#253).
        releaseLock();
        setTimeout(() => exit(), 100);
      }
    },
    // `isFinal` is a fresh arrow on every render with the same answer; a dep
    // on it would make `finish`, and so `launch`, change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exit, releaseLock],
  );

  // Mid-write, a Ctrl+C stops the run and waits for its rollback; the temp
  // dir goes on every Ctrl+C, so cancelling at a prompt leaks no shard.
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

  /**
   * Start a run: `start` calls the flow and maps its result to a final
   * phase. Returns the effect's cleanup, which supersedes the run.
   */
  const launch = useCallback(
    (start: (ctx: FlowRunContext<P>) => Promise<P>): (() => void) => {
      let disposed = false;
      const stop = new AbortController();
      const show = (next: P | ((prev: P) => P)) => {
        if (!disposed) setPhase(next);
      };
      // This run's handle: a superseded run never clears its successor's.
      let mine: RunInFlight | null = null;
      const dropMine = () => {
        if (runRef.current === mine) runRef.current = null;
      };

      const ctx: FlowRunContext<P> = {
        show,
        stop: stop.signal,
        ask: <A>(question: { kind: string }, index: number | undefined, render: () => void) =>
          new Promise<A>((resolve, reject) => {
            if (disposed) {
              reject(new FlowCancelled('Superseded by a newer run.'));
              return;
            }
            pendingRef.current = { kind: question.kind, index, resolve: resolve as (answer: unknown) => void, reject };
            render();
          }),
        io: {
          hooks: {
            setPhase: (p) => show(asPhase(p)),
            onStdout: (chunk) => {
              if (!disposed) appendHookOutput(setPhase, chunk);
            },
            onStderr: (chunk) => {
              if (!disposed) appendHookOutput(setPhase, chunk);
            },
          },
          // A transaction that makes its vault folder takes the lock once it
          // exists, and releases it if it rolls back (§4.28 step 1a).
          lock: () => {
            takeLock();
            return { release: releaseLock };
          },
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
          // during them can't walk the run back.
          onCommitted: dropMine,
          onHookAbort: (abort) => {
            hookAbortRef.current = abort;
          },
        },
      };

      start(ctx).then(
        (final) => {
          if (!disposed) finish(final);
        },
        (err: unknown) => {
          dropMine();
          // A Ctrl+C mid-download stops the fetch; the command is exiting, so
          // that is not an error to render.
          if (disposed || err instanceof DownloadCancelledError) return;
          if (err instanceof FlowCancelled) {
            finish(asPhase({ kind: 'cancelled', reason: err.reason }));
            return;
          }
          if (isCancelledRun(err)) {
            // The Ctrl+C handler reports any rollback failure and exits 130.
            finish(asPhase({ kind: 'cancelled', reason: 'Cancelled with Ctrl+C.' }));
            return;
          }
          finish(
            asPhase({
              kind: 'error',
              error: err as Error,
              detail: wasRolledBack(err) ? rollbackDetail(err, rolledBackLine) : undefined,
            }),
          );
        },
      );

      return () => {
        disposed = true;
        stop.abort();
        // A question the superseded run waits on ends it.
        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.reject(new FlowCancelled('Superseded by a newer run.'));
        if (ctxCleanupRef.current) ctxCleanupRef.current().catch(() => {});
      };
    },
    // `asPhase` is a fresh identity arrow on every render: a dep on it would
    // change `launch` every render for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finish, takeLock, releaseLock, rolledBackLine],
  );

  /**
   * Settle the question the flow waits on, if it is the one this prompt
   * answers (an iterated question: the same index): a late or doubled
   * handler never answers the next question.
   */
  const settle = useCallback((kind: string, outcome: { value: unknown } | { error: Error }, index?: number) => {
    const pending = pendingRef.current;
    if (pending?.kind !== kind || pending.index !== index) return;
    pendingRef.current = null;
    if ('error' in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
  }, []);

  return { phase, setPhase, phaseRef, launch, settle };
}
