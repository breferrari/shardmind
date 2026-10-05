/**
 * Open a conflict in the user's editor (#50). See docs/IMPLEMENTATION.md
 * §4.24.
 *
 * Pure of Ink: the caller releases the terminal's raw mode around
 * `editInEditor` with `withTerminalReleased`, and holds SIGINT with
 * `withSigintHeld`. The vault is never written here; the update executor
 * writes an edit under its snapshot and rollback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type EditOutcome =
  | { kind: 'saved'; content: string }
  | { kind: 'cancelled'; detail: string };

/** `$VISUAL`, then `$EDITOR`. None set: undefined, and the prompt offers no editor. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ['VISUAL', 'EDITOR'] as const) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Write `content` to a temp copy named like `fileName` under `dir`, run the
 * editor on it, and return what was saved. A failed, stopped or unchanged
 * edit, or one that loses the file, is a cancel with a sentence saying why.
 * The temp copy is removed on every path.
 */
export function editInEditor(
  content: string,
  fileName: string,
  opts: { command: string; dir: string; platform?: NodeJS.Platform },
): EditOutcome {
  const platform = opts.platform ?? process.platform;
  let editDir: string | undefined;
  let file: string;
  try {
    editDir = fs.mkdtempSync(path.join(opts.dir, 'shardmind-edit-'));
    file = path.join(editDir, safeFileName(fileName, platform));
    fs.writeFileSync(file, content, 'utf-8');
  } catch (err) {
    removeQuietly(editDir);
    return cancelled(`The temp copy for the editor could not be created: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const run = spawnSync(`${opts.command} ${quoteForShell(file, platform)}`, { shell: true, stdio: 'inherit' });
    if (run.error) return cancelled(`${opts.command} could not start: ${run.error.message}`);
    if (run.signal) return cancelled(`${opts.command} was stopped (${run.signal})`);
    // A shell that cannot find the command exits 127 (POSIX) or 1 (cmd.exe):
    // either way the edit did not happen.
    if (run.status !== 0) return cancelled(`${opts.command} exited with code ${run.status}`);
    const saved = fs.readFileSync(file, 'utf-8');
    if (saved === content) {
      return cancelled(
        'The file was saved unchanged. If your editor opens a window, set it to wait until you close the file, for example VISUAL="code --wait"',
      );
    }
    return { kind: 'saved', content: saved };
  } catch (err) {
    // The editor moved or deleted the temp copy.
    return cancelled(`The edit could not be read back: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    removeQuietly(editDir);
  }
}

function removeQuietly(dir: string | undefined): void {
  if (dir === undefined) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A window editor can still hold it open (Windows EBUSY); it is under the
    // run's temp dir, which is removed when the command ends.
  }
}

/** A line that starts a merge's conflict markers, `<<<<<<< ` or `>>>>>>> `. A lone `=======` is a Markdown setext underline. */
export function hasConflictMarkers(content: string): boolean {
  return /^(?:<<<<<<< |>>>>>>> )/m.test(content);
}

/**
 * Leave raw mode for `fn` (the editor owns the terminal meanwhile) and
 * restore it after, whether `fn` returns or throws. `setRawMode` sets the
 * stream itself: Ink's own setter counts its users and would not leave raw
 * mode while a prompt holds it.
 *
 * The read on `input` stops for `fn` too (#282). Raw mode leaving with a
 * libuv read in flight restarts it in line mode on Windows, a thread blocked
 * in `ReadConsoleW`, and cancelling that read when raw mode returns strands
 * ConPTY: the process never ends after its `exit` event. `input.pause()`
 * cannot do it, since a TTY stream's pause leaves the libuv read running
 * (net.Socket stops it only when its buffer fills), and neither can Ink 8's
 * `pauseInput`. One code path on every OS.
 */
export function withTerminalReleased<T>(
  setRawMode: ((on: boolean) => void) | undefined,
  fn: () => T,
  input: NodeJS.ReadStream = process.stdin,
): T {
  if (!setRawMode) return fn();
  const restartRead = stopRead(input);
  setRawMode(false);
  try {
    return fn();
  } finally {
    setRawMode(true);
    restartRead?.();
  }
}

type ReadHandle = { reading?: boolean; readStop: () => number; readStart: () => number };

/**
 * Stop the libuv read under `input` and return its restart, or undefined when
 * nothing was stopped. The handle is Node's internal `_handle`, so each method
 * is checked: without them the hang can recur, but the handoff still works.
 * A failed restart destroys the stream with its code, as Node's own
 * `tryReadStart` does.
 */
function stopRead(input: NodeJS.ReadStream): (() => void) | undefined {
  const handle: unknown = Reflect.get(input, '_handle');
  if (!isReadHandle(handle) || handle.reading !== true) return undefined;
  if (handle.readStop() !== 0) return undefined;
  handle.reading = false;
  return () => {
    const code = handle.readStart();
    if (code === 0) {
      handle.reading = true;
      return;
    }
    input.destroy(new Error(`stdin could not read again after the editor (libuv error ${code})`));
  };
}

function isReadHandle(handle: unknown): handle is ReadHandle {
  if (typeof handle !== 'object' || handle === null) return false;
  return typeof Reflect.get(handle, 'readStop') === 'function' && typeof Reflect.get(handle, 'readStart') === 'function';
}

let sigintHeld = false;

/**
 * Run `fn` with SIGINT held: a Ctrl+C in an editor that leaves the terminal
 * cooked also reaches node, queued in libuv while `spawnSync` blocks, and it
 * must cancel the edit, not the update and its choices so far.
 *
 * A no-op listener goes on before the others come off, and the others come
 * back before it goes, so SIGINT always has a listener: with none, Node would
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

function cancelled(detail: string): EditOutcome {
  return { kind: 'cancelled', detail: detail.endsWith('.') ? detail : `${detail}.` };
}

/** cmd.exe expands `%VAR%` even inside double quotes, and a name cannot hold `"`. */
function safeFileName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.replace(/[%"]/g, '_') : name;
}

function quoteForShell(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
