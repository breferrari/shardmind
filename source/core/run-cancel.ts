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
