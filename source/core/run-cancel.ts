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
 * behind (the cancel is then the cause of `ROLLBACK_INCOMPLETE`), and when
 * an update across shards carries it as one shard's error (#407): the
 * cause chain is followed. One test for the terminal machines, the
 * headless runners and the update flow, which loads no React (§4.29).
 */
export function isCancelledRun(err: unknown): boolean {
  // Bounded: a cause chain is a few links, and a cycle must not spin.
  for (let at = err, depth = 0; typeof at === 'object' && at !== null && depth < 8; depth++) {
    if ((at as { code?: unknown }).code === 'CANCELLED') return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}
