/**
 * Async loader hook for the status command.
 *
 * Sibling of `use-install-machine.ts` and `use-update-machine.ts` but much
 * simpler: status is read-only, non-interactive, and has a single terminal
 * state per load. Rather than model a full state machine we expose a
 * discriminated phase variable so the render layer can pattern-match
 * exactly as it does for the interactive commands.
 *
 * Phases:
 *   - `booting`      — mount tick before the effect runs
 *   - `loading`      — `buildStatusReport` is in flight
 *   - `not-in-vault` — `state.json` was absent (report is `null`)
 *   - `ready`        — `StatusReport` is available
 *   - `error`        — builder threw; carry the error + optional detail
 *
 * Calling `exit()` on a terminal phase matches the pattern in the other
 * two commands so `pastel`'s lifecycle behaves identically: Ink mounts,
 * renders once, the render exits, and the process returns with a clean
 * shutdown rather than waiting on stdin.
 */

import { useEffect, useState } from 'react';
import { useApp } from 'ink';
import type { StatusReport } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { buildStatusReport } from '../../core/status.js';

export interface UseStatusReportInput {
  vaultRoot: string;
  verbose: boolean;
  /** Skip the update-check network call (CI / offline-first test modes). */
  skipUpdateCheck?: boolean;
  /** Lift the report's list caps (`--json` lists every file, #139). */
  uncapped?: boolean;
  /** Don't exit yet, even on a terminal phase (the self-update cache read, #285). */
  holdExit?: boolean;
}

export type StatusPhase =
  | { kind: 'booting' }
  | { kind: 'loading' }
  | { kind: 'not-in-vault' }
  | { kind: 'ready'; report: StatusReport }
  | { kind: 'error'; error: ShardMindError | Error };

export interface UseStatusReportOutput {
  phase: StatusPhase;
}

export function useStatusReport(input: UseStatusReportInput): UseStatusReportOutput {
  const { vaultRoot, verbose, skipUpdateCheck, uncapped, holdExit = false } = input;
  const { exit } = useApp();
  const [phase, setPhase] = useState<StatusPhase>({ kind: 'booting' });
  const terminal = phase.kind !== 'booting' && phase.kind !== 'loading';

  // Exit once the phase is terminal and nothing holds it. Deferred so Ink
  // has a chance to render the final frame before stdout is torn down —
  // same pattern as the install / update commands. The cleanup clears the
  // timer, so an unmount (Ctrl-C) between the phase and the 50 ms fire
  // never calls `exit()` on a torn-down Ink app.
  useEffect(() => {
    if (!terminal || holdExit) return;
    const handle = setTimeout(() => exit(), 50);
    return () => clearTimeout(handle);
  }, [terminal, holdExit, exit]);

  useEffect(() => {
    let disposed = false;

    const finish = (next: StatusPhase) => {
      if (disposed) return;
      setPhase(next);
    };

    (async () => {
      if (disposed) return;
      setPhase({ kind: 'loading' });
      try {
        const report = await buildStatusReport(vaultRoot, {
          verbose,
          skipUpdateCheck: skipUpdateCheck ?? false,
          uncapped,
        });
        if (disposed) return;
        if (!report) {
          finish({ kind: 'not-in-vault' });
          return;
        }
        finish({ kind: 'ready', report });
      } catch (err) {
        finish({
          kind: 'error',
          error:
            err instanceof ShardMindError
              ? err
              : err instanceof Error
                ? err
                : new Error(String(err)),
        });
      }
    })();

    return () => {
      disposed = true;
    };
    // `vaultRoot` and `verbose` are const per command invocation; exit is
    // stable across renders. Kept in the dep array for lint cleanliness.
  }, [vaultRoot, verbose, skipUpdateCheck, uncapped, exit]);

  return { phase };
}
