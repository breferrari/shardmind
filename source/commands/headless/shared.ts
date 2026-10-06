/**
 * What the headless `--json` runners share (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30. Each runner turns its options into a
 * document; the parsing, the failure document, the vault lock of a real run,
 * and Ctrl+C (a cleanup before the run, a rollback during it, #348) are here.
 */

import { parseCommandArgv } from '../../cli-kit/parse.js';
import { DownloadCancelledError } from '../../core/download.js';
import { acquireVaultLock } from '../../core/vault-lock.js';
import { emitJson, jsonFailure, jsonSuccess, type JsonCommand } from '../../core/json-output.js';
import type { HookRunUi } from '../../core/hook-orchestrator.js';
import { ShardMindError } from '../../runtime/types.js';
import { exitProcess, onSigint } from '../../core/process-control.js';

export type Write = (chunk: string) => void;

export const writeStdout: Write = (chunk) => void process.stdout.write(chunk);

/**
 * `argv` parsed as the Pastel run parses it; its error is `ARGS_INVALID`
 * with Pastel's message and `help` as the hint.
 */
export function parseArgsOrThrow<A extends unknown[], O>(
  argv: readonly string[],
  schemas: Parameters<typeof parseCommandArgv>[1],
  help: string,
): { args: A; options: O } {
  try {
    return parseCommandArgv<A, O>(argv, schemas);
  } catch (err) {
    throw new ShardMindError(err instanceof Error ? err.message : String(err), 'ARGS_INVALID', help);
  }
}

/** A flow's io under `--json`: it shows nothing, and owns the lock and Ctrl+C. */
export interface HeadlessFlowIO {
  phase: () => void;
  progress: () => void;
  hooks: Omit<HookRunUi, 'signal'>;
  lock: () => { release(): void };
  onCleanup: (cleanup: () => Promise<void>) => void;
  newRunAbort: () => AbortController;
  onRun: (abort: AbortController, run: Promise<unknown>) => void;
  onCommitted: () => void;
  onHookAbort: (abort: AbortController | null) => void;
}

/**
 * A run stopped by Ctrl+C, rolled back fully or not. The same test as the
 * terminal machines' `isCancelledRun`, kept here so a headless run loads no
 * React (§4.29).
 */
function isCancelledRun(err: unknown): boolean {
  const code = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(err) === 'CANCELLED' || code((err as { cause?: unknown } | null)?.cause) === 'CANCELLED';
}

/** The failure a Ctrl+C before the run's transaction existed answers with. */
function cancelledBeforeRun(): ShardMindError {
  return new ShardMindError('Cancelled.', 'CANCELLED', 'The run was stopped with Ctrl+C before it wrote anything.');
}

/**
 * Runs a flow-backed `--json` command and returns its exit code: 0 with the
 * document `run` returns, 1 with a failure document, 130 after a Ctrl+C.
 * Every exit writes exactly one document (#348). The flow takes the vault
 * lock through `io.lock` only for a real run, never a dry run; it is
 * released when the run ends. A Ctrl+C:
 * - before the run's transaction exists (download, planning): removes the
 *   temp dir and exits 130 with a `CANCELLED` document;
 * - during the write: aborts the run, whose own rollback finishes before the
 *   flow rejects; the document is its `CANCELLED` (or `ROLLBACK_INCOMPLETE`)
 *   failure, exit 130;
 * - during the hooks, after `state.json` is written: cuts the hooks short;
 *   the run is committed, so the document is its result, exit 130.
 */
export async function runFlowJson(
  command: JsonCommand,
  write: Write,
  run: (io: HeadlessFlowIO) => Promise<unknown>,
): Promise<number> {
  let cleanup: (() => Promise<void>) | undefined;
  let lock: { release(): void } | undefined;
  let inFlight: AbortController | undefined;
  let hookAbort: AbortController | null = null;
  let cancelled = false;
  // Once per run: a Ctrl+C handler and the run's own catch can both reach here.
  let emitted = false;
  const emitOnce = (envelope: Parameters<typeof emitJson>[0]) => {
    if (emitted) return;
    emitted = true;
    emitJson(envelope, write);
  };
  const offSigint = onSigint(() => {
    // A second Ctrl+C changes nothing: the first one's ending is under way.
    if (cancelled) return;
    cancelled = true;
    if (hookAbort) {
      hookAbort.abort();
      return;
    }
    if (inFlight) {
      inFlight.abort();
      return;
    }
    void Promise.resolve()
      .then(() => cleanup?.())
      .catch(() => {})
      .finally(() => {
        emitOnce(jsonFailure(command, cancelledBeforeRun()));
        lock?.release();
        exitProcess(130);
      });
  });
  try {
    const document = await run({
      phase: () => {},
      progress: () => {},
      // Hook output goes to the hook's log, never to stdout.
      hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
      lock: () => {
        lock = acquireVaultLock(process.cwd(), command === 'adopt' ? 'adopt' : 'update');
        return { release: () => lock?.release() };
      },
      onCleanup: (c) => {
        cleanup = c;
      },
      newRunAbort: () => {
        const abort = new AbortController();
        if (cancelled) abort.abort();
        return abort;
      },
      onRun: (abort) => {
        inFlight = abort;
      },
      onCommitted: () => {
        inFlight = undefined;
      },
      onHookAbort: (abort) => {
        hookAbort = abort;
        if (abort && cancelled) abort.abort();
      },
    });
    emitOnce(jsonSuccess(command, document));
    return cancelled ? 130 : 0;
  } catch (err) {
    if (cancelled || isCancelledRun(err) || err instanceof DownloadCancelledError) {
      emitOnce(jsonFailure(command, isCancelledRun(err) ? err : cancelledBeforeRun()));
      return 130;
    }
    emitOnce(jsonFailure(command, err));
    return 1;
  } finally {
    lock?.release();
    offSigint();
  }
}
