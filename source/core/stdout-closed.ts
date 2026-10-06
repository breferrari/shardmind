/**
 * A reader that closes stdout early (#252). Spec: docs/IMPLEMENTATION.md
 * §7.2a "Stdout closed early".
 *
 * `shardmind --json | head -1` closes the pipe before shardmind finishes
 * writing, and the next write fails with EPIPE. That is the reader's choice,
 * not a failure of shardmind, so it ends the run the way a Unix tool cut off
 * by `head` ends: quietly, with 141 (128 + SIGPIPE). The run itself is not
 * cut short: an update or adopt in its write pass finishes, or rolls back,
 * through its own paths, so a closed pipe never leaves a half-written vault.
 *
 * Imports nothing, so `cli.ts` can load it statically and install it before
 * anything writes.
 */

import type { EventEmitter } from 'node:events';

/** 128 + SIGPIPE: what a shell reports for a process a closed pipe stopped. */
export const STDOUT_CLOSED_EXIT_CODE = 141;

import { setExitCode } from './process-control.js';

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

function isEpipe(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EPIPE';
}

export function exitQuietlyWhenStdoutCloses(
  proc: {
    stdout: EventEmitter & { write: Write | NodeJS.WritableStream['write']; errored?: unknown };
    on(event: 'exit', listener: (code: number) => void): unknown;
  },
  /** The exit code's one writer (#303); a test passes its own. */
  setCode: (code: number) => void = setExitCode,
): void {
  let closed = false;
  proc.stdout.on('error', (error: unknown) => {
    // Once closed, the stream reports the rest of its failed writes too.
    if (closed) return;
    // Rethrown, it stays an uncaught exception, which the crash handler reports.
    if (!isEpipe(error)) throw error;
    closed = true;
    const dropped: Write = (_chunk, ...rest) => {
      // Ink waits on a write's callback before it exits. Called on a later
      // tick, as a stream calls it.
      const callback = rest.find((r): r is () => void => typeof r === 'function');
      if (callback) process.nextTick(callback);
      return true;
    };
    proc.stdout.write = dropped as NodeJS.WritableStream['write'];
  });
  proc.on('exit', (code) => {
    // The stream calls a failed write's callback before it emits 'error', so
    // a run that exits from that callback has not seen the event yet; the
    // stream's recorded error says the pipe closed all the same.
    const pipeClosed = closed || isEpipe(proc.stdout.errored);
    // A run that failed on its own keeps its code.
    if (pipeClosed && code === 0) setCode(STDOUT_CLOSED_EXIT_CODE);
  });
}
