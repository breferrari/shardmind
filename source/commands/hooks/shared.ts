/**
 * Cross-machine utilities for install and update state hooks.
 *
 * Every command machine needs the same two pieces of plumbing:
 *
 *   1. A way to summarize a `HookResult` for the summary view, since
 *      both commands render the same "hook output" shape.
 *   2. SIGINT handling that rolls back any in-progress mutation before
 *      the process dies — Ink's default exit ignores our bookkeeping.
 *
 * Keeping them here means install and update can't drift on the
 * summary shape or the rollback policy.
 */

import { useEffect } from 'react';
import type { HookResult } from '../../core/hook.js';

export interface HookSummary {
  deferred?: boolean;
  stdout?: string;
  exitCode?: number;
}

export function summarizeHook(result: HookResult): HookSummary | null {
  switch (result.kind) {
    case 'absent':
      return null;
    case 'deferred':
      return { deferred: true };
    case 'ran':
      return { stdout: result.stdout, exitCode: result.exitCode };
    case 'failed':
      return { stdout: result.message, exitCode: 1 };
  }
}

/**
 * Attach a SIGINT listener that runs `rollback()` when a mutation is
 * in progress, then exits with the conventional 130 code. The caller
 * supplies `isActive` so the handler can distinguish "Ctrl-C during
 * network fetch" (just exit) from "Ctrl-C mid-write" (roll back first).
 *
 * `cleanup` runs on every Ctrl-C (active or not) — use it for things
 * like deleting the downloaded-shard tempdir that must die regardless
 * of whether writes had started. All callbacks are swallow-failures:
 * the process is about to exit anyway.
 *
 * Returns nothing; the effect registers + cleans up the listener for
 * as long as the component is mounted.
 */
export function useSigintRollback(opts: {
  isActive: () => boolean;
  rollback: () => Promise<void>;
  cleanup?: () => Promise<void>;
}): void {
  const { isActive, rollback, cleanup } = opts;
  useEffect(() => {
    const handler = async () => {
      try {
        if (isActive()) await rollback();
      } catch {
        // swallow; process is about to exit
      }
      try {
        if (cleanup) await cleanup();
      } catch {
        // swallow
      }
      process.exit(130);
    };
    process.on('SIGINT', handler);
    return () => {
      process.off('SIGINT', handler);
    };
  }, [isActive, rollback, cleanup]);
}
