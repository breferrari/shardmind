/**
 * Cross-platform cancellation bridge.
 *
 * POSIX delivers parent→child SIGINT via `child_process.kill('SIGINT')`; the
 * child receives a catchable signal and `useSigintRollback` rolls back any
 * in-progress mutation. Windows does not — Node's `subprocess.kill()`
 * emulates SIGINT as `TerminateProcess`, which skips every registered
 * handler and leaves the vault in whatever partial state the write phase
 * was in.
 *
 * The hook here closes that gap: when the CLI runs non-interactively
 * (stdin is a pipe, not a TTY), we listen for the ETX byte (0x03 — the
 * ASCII form of Ctrl+C) on stdin. A parent that wants clean cancellation
 * writes that byte and we `process.emit('SIGINT')`, which fires every
 * SIGINT listener registered via `process.on('SIGINT', ...)` — the same
 * listeners that already run on a native POSIX signal.
 *
 * TTY invocations are unaffected: real users hit Ctrl+C in the console
 * and Node's built-in console-signal plumbing delivers SIGINT natively
 * on both platforms. The stdin listener is attached only when `isTTY` is
 * falsy on boot, so interactive wizards don't fight for stdin bytes with
 * Ink's keyboard handling.
 *
 * Scope: this file is imported once at CLI startup and has no runtime
 * consumers beyond that. The listener stays alive for the lifetime of
 * the process; Node's default behavior on process exit cleans up the
 * stdin reference.
 */

const ETX = 0x03;

let installed = false;

export function installStdinCancellation(): void {
  // Idempotent — calling twice is harmless but wasteful.
  if (installed) return;
  installed = true;

  // Attach only in non-TTY mode: `isTTY` is undefined when stdin is a
  // pipe (our target case) and true when it's a terminal. Real users
  // running `shardmind install ...` from a shell see TTY stdin and go
  // through Ink's normal console-signal path.
  if (process.stdin.isTTY) return;

  // `process.stdin` defaults to paused on Node 22+; `.on('data')` resumes
  // it automatically, but we guard by only reading raw bytes (no string
  // encoding) so Ink's own stdin consumers — if any happen to attach
  // later — see the raw stream unchanged. Explicit `.resume()` is a
  // belt-and-suspenders guard for Windows pipe stdin, where auto-resume
  // behavior has historically been inconsistent across Node minors.
  process.stdin.on('data', (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === ETX) {
        process.emit('SIGINT');
        return;
      }
    }
  });
  process.stdin.resume();

  // `.unref()` lets Node exit normally when the only remaining handle is
  // stdin. Without it, the listener above would keep the event loop alive
  // after Ink unmounts, and the CLI would hang waiting for bytes that
  // never arrive (the parent test / wrapper has already moved on). The
  // listener still fires if ETX lands before exit — unref only removes
  // the "block exit" property, not the data subscription.
  //
  // Not every stdin handle shape exposes `.unref()` (Windows pipes via
  // redirected input, some CI environments). Fall back silently: the worst
  // case is the familiar "CLI hangs on exit" behavior we're trying to
  // avoid, and wrapper scripts can always close stdin to unstick it.
  const stdin = process.stdin as { unref?: () => void };
  stdin.unref?.();
}
