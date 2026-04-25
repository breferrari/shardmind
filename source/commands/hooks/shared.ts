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
import {
  tailAtUtf8Boundary,
  type HookResult,
  type HookSummary,
  type RunningHookPhase,
} from '../../core/hook.js';
import { rehashManagedFiles, writeState } from '../../core/state.js';
import { assertNever, type ShardState } from '../../runtime/types.js';

/**
 * Re-export so existing callers that reach for `HookSummary` via this
 * module (install/update machines) don't need to update their imports.
 * The canonical home is `source/core/hook.ts` — components must import
 * from there directly per CLAUDE.md §Module Boundaries (components
 * can import from core, not from commands).
 */
export type { HookSummary };

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
 * Collapse a `HookResult` into the `HookSummary` shape the install and
 * update summary views both render.
 *
 * - `absent` → null (nothing happened; render nothing).
 * - `deferred` → `{ deferred: true }` (hook exists but was suppressed,
 *   e.g. dry run; UI shows a "skipped" note).
 * - `ran` → `{ stdout, stderr, exitCode }` (subprocess completed; the UI
 *   renders stdout + stderr separately with an exit-code-dependent headline).
 * - `failed` → `{ stdout, stderr, exitCode: 1 }` where `stderr` is prefixed
 *   with the failure reason (timeout / cancel / spawn error). The UI treats
 *   `failed` identically to a non-zero `ran` — from the user's perspective
 *   the hook didn't complete, and the message belongs in stderr alongside
 *   any output the child produced before dying.
 */
export function summarizeHook(result: HookResult): HookSummary | null {
  switch (result.kind) {
    case 'absent':
      return null;
    case 'deferred':
      return { deferred: true };
    case 'ran':
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    case 'failed': {
      const prefix = `hook ${result.message}`;
      const stderr = result.stderr ? `${prefix}\n${result.stderr}` : prefix;
      return { stdout: result.stdout, stderr, exitCode: 1 };
    }
    default:
      return assertNever(result);
  }
}

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
 * Re-hash every managed file after a hook subprocess returns and persist
 * the updated state.json — the post-hook contract documented in
 * `docs/SHARD-LAYOUT.md §Hooks, state, and re-hash semantics`.
 *
 * Runs on success OR failure of the hook (Helm-style non-fatal contract).
 * Skips the `writeState` call when nothing changed so we don't burn a
 * redundant fs.writeFile on the common case (most hooks edit unmanaged
 * files, not managed ones).
 *
 * The wrapping try/catch is correct semantics, not paranoia: by the
 * time we get here, the executor has already written `state.json` with
 * pre-hook hashes. This function's job is to *update* that state with
 * post-hook hashes. If `writeState` fails (disk full, permission flip),
 * the pre-hook state.json survives, and drift detection surfaces the
 * discrepancy on the next `shardmind` status run — the user's vault is
 * never in a corrupted state, just an out-of-date one. Surfacing the
 * error here would also be misleading: the install/update *succeeded*
 * (state.json was written by the executor, hook ran past the point-of-
 * no-return), and a yellow warning would conflate engine work that
 * completed with a refinement that didn't.
 */
export async function postHookRehash(vaultRoot: string, state: ShardState): Promise<void> {
  try {
    const rehash = await rehashManagedFiles(vaultRoot, state);
    if (rehash.changed.length > 0 || rehash.missing.length > 0 || rehash.failed.length > 0) {
      await writeState(vaultRoot, rehash.state);
    }
  } catch {
    // see comment above — non-fatal by design
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
