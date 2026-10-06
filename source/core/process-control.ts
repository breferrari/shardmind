/**
 * The one owner of the CLI process's SIGINT handling, its exit code and its
 * startup order (#303). Spec: docs/IMPLEMENTATION.md §4.32.
 *
 * Every other module goes through these functions; a scan test fails a
 * `process.on('SIGINT', …)`, `process.exitCode =` or `process.exit(`
 * anywhere else in `source/`, except `internal/` (child processes with their
 * own exit) and `cli-kit/` (vendored). Imports nothing, so `cli.ts` and the
 * stdin bridge can load it before chalk (#37). The startup order `cli.ts`
 * runs is asserted by a test that reads it (§4.32 step 4).
 */

type SigintHandler = () => void | Promise<void>;

interface Entry {
  handler: SigintHandler;
  once: boolean;
}

/** The handlers, in the order they were added. */
const stack: Entry[] = [];

/** While an editor owns the terminal, the stack runs nothing (`withSigintHeld`). */
let held = false;

/**
 * The one process listener: every handler, in the order it was added. A
 * handler that throws does not stop the others; the first throw is rethrown
 * once they have all run, so it still reaches the crash handler, as a
 * listener's throw did. A rejection stays unhandled, as before.
 */
const dispatch = (): void => {
  if (held) return;
  let thrown: { error: unknown } | undefined;
  for (const entry of [...stack]) {
    if (entry.once) remove(entry);
    try {
      void entry.handler();
    } catch (error) {
      thrown ??= { error };
    }
  }
  if (thrown) throw thrown.error;
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
 * removal. `once`: removed before it runs. The handlers run together, where
 * the first of them was added among the process's other listeners (Ink's).
 */
export function onSigint(handler: SigintHandler, opts: { once?: boolean } = {}): () => void {
  const entry: Entry = { handler, once: opts.once ?? false };
  if (stack.length === 0) process.on('SIGINT', dispatch);
  stack.push(entry);
  return () => remove(entry);
}

/**
 * On SIGINT, run the cleanup `cleanupOf` returns (a download's temp dir, #57),
 * then exit 130: a headless run's Ctrl+C. Once; returns its removal.
 */
export function exitOnSigint(cleanupOf: () => (() => Promise<void>) | undefined): () => void {
  return onSigint(
    () => {
      void Promise.resolve()
        .then(() => cleanupOf()?.())
        .catch(() => {})
        .finally(() => exitProcess(130));
    },
    { once: true },
  );
}

/** Deliver a SIGINT in-process (the stdin bridge's Ctrl+C, #155): true when a listener ran. */
export function emitSigint(): boolean {
  return process.emit('SIGINT');
}

/**
 * Run `fn` while SIGINT is held off: an editor owns the terminal, and a
 * Ctrl+C there must cancel the edit, not the run (#50).
 *
 * A Ctrl+C in a terminal that went cooked also reaches node, queued in libuv
 * while `spawnSync` blocks. The stack is held (`held`: its listener runs
 * nothing), so a handler added or removed meanwhile keeps the listener in
 * step with the stack. The process's other listeners (Ink's `signal-exit`)
 * come off behind a no-op one and come back before it goes, so SIGINT always
 * has a listener: with none, Node would close its signal handle and a signal
 * in that window would take the default action and kill the process. The
 * queued signal is delivered in the poll phase of the loop turn after `fn`
 * returns; the restore waits for the check phase after that one (two
 * `setImmediate`s), so the hold takes it. `rawListeners` keeps a `once`
 * listener a `once`. A nested call just runs `fn`. `onRestored` runs once
 * the listeners are back.
 */
export function withSigintHeld<T>(fn: () => T, onRestored?: () => void): T {
  if (held) return fn();
  held = true;
  const hold = (): void => {};
  const foreign = (process.rawListeners('SIGINT') as Array<(...args: unknown[]) => void>).filter((l) => l !== dispatch);
  process.on('SIGINT', hold);
  for (const l of foreign) process.removeListener('SIGINT', l);
  const restore = (): void => {
    for (const l of foreign) process.on('SIGINT', l);
    process.removeListener('SIGINT', hold);
    held = false;
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

/** For tests: drop every handler and the listener, as a fresh process has none. */
export function resetSigintForTests(): void {
  stack.length = 0;
  held = false;
  process.removeListener('SIGINT', dispatch);
}
