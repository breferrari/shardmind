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

import type React from 'react';
import { useEffect, useRef } from 'react';
import { attemptRollback, formatRollbackFailures, type RollbackFailure } from '../../core/rollback-report.js';
import {
  tailAtUtf8Boundary,
  summarizeHook,
  type HookSummary,
  type RunningHookPhase,
} from '../../core/hook.js';

/**
 * Re-export so existing callers that reach for `HookSummary` / `summarizeHook`
 * via this module (install/update machines) don't need to update their
 * imports. The canonical home is `source/core/hook.ts` — `summarizeHook`
 * moved there so the hook orchestrator (also core) can use it without
 * crossing the module boundary (core must not import from commands).
 */
export type { HookSummary };
export { summarizeHook };

/**
 * Maximum bytes of hook output we keep in the UI live-progress buffer
 * before dropping the oldest. The final `HookResult` has its own 256 KB
 * cap per stream (see source/core/hook.ts::STREAM_CAP_BYTES); this is a
 * tighter UI-side budget because the buffer lives in React state and
 * re-renders on every chunk. A runaway `console.log` loop is pathological
 * for Ink's renderer at 256 KB but fine at 64 KB.
 */
export const HOOK_OUTPUT_UI_CAP_BYTES = 64 * 1024;

/**
 * Append a chunk of subprocess output into a running-hook phase's `output`
 * buffer. Called once per chunk by the `onStdout` / `onStderr` callbacks
 * the install and update machines hand to `executeHook`.
 *
 * No-op when the current phase is not `running-hook` — the machine may
 * have advanced past the hook (clean exit), or an abort may have landed
 * between the child's `'data'` event and this `setPhase` call.
 *
 * The updater preserves React's same-reference "no change" signal on the
 * non-`running-hook` branch so `useState` doesn't queue a redundant
 * render. Generic over the full Phase union of whichever machine calls
 * this — both machines' unions include `RunningHookPhase`, so the
 * narrowing is sound.
 */
export function appendHookOutput<P extends { kind: string }>(
  setPhase: React.Dispatch<React.SetStateAction<P>>,
  chunk: string,
): void {
  setPhase((prev) => {
    if (prev.kind !== 'running-hook') return prev;
    const rh = prev as unknown as RunningHookPhase;
    // Tail-trim in BYTES not JS `.length` — the latter is UTF-16 code
    // units, which drift 2-4× wider than bytes for multibyte output
    // (emoji / CJK) and would let the buffer exceed the cap. `tailAtUtf8Boundary`
    // also steps past any orphaned continuation bytes at the cut so the
    // trimmed tail is always a valid UTF-8 string (no U+FFFD).
    const combined = rh.output + chunk;
    const trimmed = tailAtUtf8Boundary(combined, HOOK_OUTPUT_UI_CAP_BYTES);
    return { ...prev, output: trimmed };
  });
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
 * process is about to exit anyway. What `rollback` returns it could not
 * restore is printed to stderr before the exit (#247): a Ctrl+C rollback
 * that left files behind never ends silently.
 *
 * The handler registers ONCE on mount and deregisters on unmount. The
 * callbacks are reached through refs so React doesn't thrash
 * process.on/off on every render when the caller passes inline arrows.
 */
export function useSigintRollback(opts: {
  isActive: () => boolean;
  rollback: () => Promise<readonly RollbackFailure[] | void>;
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
      // Once per process, whatever the source (see `sigintRollbackStarted`).
      if (sigintRollbackStarted) return;
      sigintRollbackStarted = true;
      try {
        if (isActiveRef.current()) {
          // A rollback that throws partway is reported too (attemptRollback).
          const failures = await attemptRollback(async () => [...((await rollbackRef.current()) ?? [])]);
          if (failures.length > 0) process.stderr.write(`\n${formatRollbackFailures(failures)}\n`);
        }
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
    sigintHandlers.add(handler);
    return () => {
      // Once a rollback has started, keep the listener: in a TTY the first
      // Ctrl+C also makes Ink unmount the tree, and a second Ctrl+C that
      // finds no SIGINT listener would let Node's default action kill the
      // rollback halfway. The handler absorbs it; the run ends in exit(130).
      if (sigintRollbackStarted) return;
      process.off('SIGINT', handler);
      sigintHandlers.delete(handler);
    };
  }, []);
}

/**
 * Set by the first SIGINT any `useSigintRollback` instance handles, and
 * never cleared: that run ends the process with exit(130). Module scope,
 * not per effect, so a second Ctrl+C (a kernel SIGINT or the stdin
 * bridge's, #155) is absorbed even by a remounted or second instance, and
 * never starts a rollback racing the first on the same paths.
 */
let sigintRollbackStarted = false;
const sigintHandlers = new Set<() => Promise<void>>();

/**
 * Tests mock `process.exit`, so the process outlives the run: clear the
 * latch and drop the listeners a started run kept registered.
 */
export function resetSigintRollbackForTests(): void {
  sigintRollbackStarted = false;
  for (const handler of sigintHandlers) process.off('SIGINT', handler);
  sigintHandlers.clear();
}
