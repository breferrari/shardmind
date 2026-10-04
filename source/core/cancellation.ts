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
 * A TTY needs the same bridge for a different reason (#155). Ink puts the
 * terminal in raw mode for its prompts, and in raw mode Ctrl+C arrives as
 * the byte 0x03, not a signal. Ink's default `exitOnCtrlC` then unmounts
 * the app (Pastel exposes no way to turn it off), so without the bridge no
 * SIGINT handler runs and a cancelled install exits 0. In a TTY the bridge
 * therefore observes the bytes Ink reads. It wraps `stdin.setRawMode` and
 * attaches a passive `data` listener only while raw mode is on, which is
 * which is the span Ink's `readable` listener is attached for: Ink adds it
 * right after `setRawMode(true)` and removes it right after
 * `setRawMode(false)` (ink/build/components/App.js, enable and
 * `disableRawMode`). Either order is safe: a `data` listener only flows the
 * stream when no `readable` listener is attached by the next tick.
 * With a `readable` listener present, Node emits `data` from inside each
 * `read()` and never switches the stream to flowing mode, so Ink still gets
 * every byte and the observer sees each chunk before Ink parses it. Outside
 * raw mode the kernel turns Ctrl+C into a real SIGINT, as before.
 *
 * Scope: this file is imported once at CLI startup and has no runtime
 * consumers beyond that. In a pipe the listener stays alive for the
 * lifetime of the process; in a TTY it comes and goes with raw mode.
 *
 * A second Ctrl+C forces exit 130 at once: the first starts the rollback
 * handlers, which end in `exit(130)` themselves, and a second is the user
 * escalating (a wrapper writing ETX again, or a rollback stuck on a held
 * file), so it must not be swallowed or start a second rollback.
 */

const ETX = 0x03;
const ETX_CHAR = String.fromCharCode(ETX);

/** What the bridge does on Ctrl+C; injectable so tests need no real process. */
export interface CancellationDeps {
  /** `process.emit('SIGINT')`: true when a handler was registered. */
  emitSigint: () => boolean;
  exit: (code: number) => void;
}

const processDeps: CancellationDeps = {
  emitSigint: () => process.emit('SIGINT'),
  exit: (code) => process.exit(code),
};

let installed = false;

export function installStdinCancellation(): void {
  // Idempotent — calling twice is harmless but wasteful.
  if (installed) return;
  installed = true;
  attachStdinCancellation(process.stdin, processDeps);
}

interface StdinLike extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  unref?: () => void;
}

export function attachStdinCancellation(stdin: StdinLike, deps: CancellationDeps): void {
  // Fallback: SIGINT handlers are only registered by interactive machines
  // (useSigintRollback in install / update / adopt). Commands without
  // rollback — `--version`, `--help`, status — never install a listener,
  // and `process.emit('SIGINT')` with zero listeners is a no-op that
  // violates the documented "Ctrl+C cancels cleanly" contract. If no
  // handler is present at emit time, exit 130 directly so cancellation is
  // always observable to the parent. (While Ink is mounted, its
  // signal-exit dependency always has a SIGINT listener, so in a TTY the
  // fallback is in practice the pipe's.)
  let cancelled = false;
  const onData = (chunk: Buffer | string): void => {
    // Buffers unless someone set an encoding on stdin; both have includes().
    if (!(typeof chunk === 'string' ? chunk.includes(ETX_CHAR) : chunk.includes(ETX))) return;
    if (cancelled) {
      deps.exit(130);
      return;
    }
    cancelled = true;
    if (!deps.emitSigint()) deps.exit(130);
  };

  if (stdin.isTTY) {
    // Observe only while raw mode is on (see the header). A `data` listener
    // left behind after Ink stops reading would switch the stream to
    // flowing mode on its own and swallow keystrokes typed before the next
    // prompt mounts. Node's Readable does not emit `removeListener` events
    // (measured on Node 22.14), so raw mode is the signal to follow, not
    // Ink's listener.
    const setRawMode = stdin.setRawMode?.bind(stdin);
    if (!setRawMode) return;
    let observing = false;
    stdin.setRawMode = (mode: boolean) => {
      // The real call first: if it throws (a hung-up terminal), nothing is
      // left attached to flow the stream.
      const result = setRawMode(mode);
      if (mode && !observing) {
        observing = true;
        stdin.on('data', onData);
      } else if (!mode && observing) {
        observing = false;
        stdin.removeListener('data', onData);
      }
      return result;
    };
    return;
  }

  // Non-TTY (a pipe): read it directly. `process.stdin` defaults to paused
  // on Node 22+; `.on('data')` resumes it automatically, but we guard by
  // only reading raw bytes (no string encoding) so Ink's own stdin
  // consumers — if any happen to attach later — see the raw stream
  // unchanged. Explicit `.resume()` is a belt-and-suspenders guard for
  // Windows pipe stdin, where auto-resume behavior has historically been
  // inconsistent across Node minors.
  stdin.on('data', onData);
  stdin.resume();

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
  stdin.unref?.();
}
