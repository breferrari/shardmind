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
 */

import type { EventEmitter } from 'node:events';
import { errnoCode } from '../runtime/errno.js';

/** 128 + SIGPIPE: what a shell reports for a process a closed pipe stopped. */
export const STDOUT_CLOSED_EXIT_CODE = 141;

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

export function exitQuietlyWhenStdoutCloses(proc: {
  stdout: EventEmitter & { write: Write | NodeJS.WritableStream['write'] };
  on(event: 'exit', listener: (code: number) => void): unknown;
  exitCode?: number | string | null | undefined;
}): void {
  let closed = false;
  proc.stdout.on('error', (error: unknown) => {
    // Once closed, the stream reports the rest of its failed writes too.
    if (closed) return;
    // Rethrown, it stays an uncaught exception, which the crash handler reports.
    if (errnoCode(error) !== 'EPIPE') throw error;
    closed = true;
    const dropped: Write = (_chunk, ...rest) => {
      // Ink waits on a write's callback before it exits.
      const callback = rest.find((r): r is () => void => typeof r === 'function');
      callback?.();
      return true;
    };
    proc.stdout.write = dropped as NodeJS.WritableStream['write'];
  });
  proc.on('exit', (code) => {
    // A run that failed on its own keeps its code.
    if (closed && code === 0) proc.exitCode = STDOUT_CLOSED_EXIT_CODE;
  });
}
