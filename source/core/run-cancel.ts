/**
 * Stopping a run between two writes once Ctrl+C aborted it (#249).
 *
 * Kept apart from `cancellation.ts`, which `cli.ts` loads before chalk and
 * so imports nothing beyond node built-ins.
 */

import { ShardMindError } from '../runtime/types.js';

/**
 * Stop a run between two writes once Ctrl+C aborted `signal`. Each executor
 * calls this before every write and before the engine metadata, so the
 * rollback that follows never races a write still in progress.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ShardMindError('Cancelled.', 'CANCELLED', 'The run was stopped with Ctrl+C.');
  }
}

/**
 * A run stopped by Ctrl+C, whether or not its rollback then left files
 * behind (the cancel is then the cause of `ROLLBACK_INCOMPLETE`). One test
 * for the terminal machines, the headless runners and the update flow,
 * which loads no React (§4.29).
 */
export function isCancelledRun(err: unknown): boolean {
  const code = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(err) === 'CANCELLED' || code((err as { cause?: unknown } | null)?.cause) === 'CANCELLED';
}
