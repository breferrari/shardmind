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

import { useEffect, useRef } from 'react';
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
 * of whether writes had started. All callbacks swallow failures: the
 * process is about to exit anyway.
 *
 * The handler registers ONCE on mount and deregisters on unmount. The
 * callbacks are reached through refs so React doesn't thrash
 * process.on/off on every render when the caller passes inline arrows.
 */
export function useSigintRollback(opts: {
  isActive: () => boolean;
  rollback: () => Promise<void>;
  cleanup?: () => Promise<void>;
}): void {
  // Refs hold the latest callbacks; the handler reads through them so
  // it always sees current vaultRoot / backupDir / addedPaths state
  // even though the handler itself is registered only once.
  const isActiveRef = useRef(opts.isActive);
  const rollbackRef = useRef(opts.rollback);
  const cleanupRef = useRef(opts.cleanup);
  isActiveRef.current = opts.isActive;
  rollbackRef.current = opts.rollback;
  cleanupRef.current = opts.cleanup;

  useEffect(() => {
    const handler = async () => {
      try {
        if (isActiveRef.current()) await rollbackRef.current();
      } catch {
        // swallow; process is about to exit
      }
      try {
        const c = cleanupRef.current;
        if (c) await c();
      } catch {
        // swallow
      }
      process.exit(130);
    };
    process.on('SIGINT', handler);
    return () => {
      process.off('SIGINT', handler);
    };
  }, []);
}
