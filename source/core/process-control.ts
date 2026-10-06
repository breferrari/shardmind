/**
 * The one owner of the CLI process's SIGINT handling, its exit code and its
 * startup order (#303). Spec: docs/IMPLEMENTATION.md §4.32.
 *
 * Every other module goes through these functions; a scan test fails a
 * `process.on('SIGINT', …)`, `process.exitCode =` or `process.exit(`
 * anywhere else in `source/`, except `internal/` (child processes with their
 * own exit) and `cli-kit/` (vendored). Imports nothing, so `cli.ts` can load
 * it before anything else.
 */

type SigintHandler = () => void | Promise<void>;

interface Entry {
  handler: SigintHandler;
  once: boolean;
}

/** The handlers, in the order they were added. */
const stack: Entry[] = [];

/** The one process listener: every handler, in order; a rejection never stops the next. */
const dispatch = (): void => {
  for (const entry of [...stack]) {
    if (entry.once) remove(entry);
    try {
      void Promise.resolve(entry.handler()).catch(() => {});
    } catch {
      // A handler that throws synchronously does not stop the others.
    }
  }
};

function remove(entry: Entry): void {
  const at = stack.indexOf(entry);
  if (at === -1) return;
  stack.splice(at, 1);
  // With nothing to run, no listener: `emitSigint` is then false, and the
  // stdin bridge exits 130 itself (#155).
  if (stack.length === 0) process.removeListener('SIGINT', dispatch);
}

/**
 * Run `handler` on SIGINT, after the handlers added before it. Returns its
 * removal. `once`: removed before it runs.
 */
export function onSigint(handler: SigintHandler, opts: { once?: boolean } = {}): () => void {
  const entry: Entry = { handler, once: opts.once ?? false };
  if (stack.length === 0) process.on('SIGINT', dispatch);
  stack.push(entry);
  return () => remove(entry);
}

/** Deliver a SIGINT in-process (the stdin bridge's Ctrl+C, #155): true when a listener ran. */
export function emitSigint(): boolean {
  return process.emit('SIGINT');
}

let sigintHeld = false;

/**
 * Run `fn` while every SIGINT listener is held off: an editor owns the
 * terminal, and a Ctrl+C there must cancel the edit, not the run (#50).
 *
 * A Ctrl+C in a terminal that went cooked also reaches node, queued in libuv
 * while `spawnSync` blocks. A no-op listener goes on before the others come
 * off (the stack's and Ink's own `signal-exit` one), and the others come back
 * before it goes, so SIGINT always has a listener: with none, Node would
 * close its signal handle and a signal in that window would take the default
 * action and kill the process. The queued signal is delivered in the poll
 * phase of the loop turn after `fn` returns; the restore waits for the check
 * phase after that one (two `setImmediate`s), so the no-op listener takes it.
 * `rawListeners` keeps a `once` listener a `once`. A nested call just runs
 * `fn`. `onRestored` runs once the listeners are back.
 */
export function withSigintHeld<T>(fn: () => T, onRestored?: () => void): T {
  if (sigintHeld) return fn();
  sigintHeld = true;
  const hold = (): void => {};
  const listeners = process.rawListeners('SIGINT') as Array<(...args: unknown[]) => void>;
  process.on('SIGINT', hold);
  for (const l of listeners) process.removeListener('SIGINT', l);
  const restore = (): void => {
    for (const l of listeners) process.on('SIGINT', l);
    process.removeListener('SIGINT', hold);
    sigintHeld = false;
    onRestored?.();
  };
  try {
    return fn();
  } finally {
    setImmediate(() => setImmediate(restore));
  }
}

/** The process's exit code, kept for when it exits. */
export function setExitCode(code: number): void {
  process.exitCode = code;
}

/**
 * End the process now, with `code` (or the exit code set so far). With no
 * code, `process.exit` is called with no argument: Node 22 counts its
 * arguments, and an explicit `undefined` exits 0 over the code already set.
 */
export function exitProcess(code?: number): void {
  if (code === undefined) process.exit();
  else process.exit(code);
}

/**
 * The order `cli.ts` sets the process up in, before anything loads Ink
 * (§4.32 step 4). A unit test reads `cli.ts` and asserts its calls follow it.
 */
export const STARTUP_STEPS = ['applyNoColor', 'exitQuietlyWhenStdoutCloses', 'installCrashHandlers', 'installStdinCancellation'] as const;

/** For tests: drop every handler and the listener, as a fresh process has none. */
export function resetSigintForTests(): void {
  stack.length = 0;
  process.removeListener('SIGINT', dispatch);
}
