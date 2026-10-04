/**
 * Open a conflict in the user's editor (#50). See docs/IMPLEMENTATION.md
 * §4.23.
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
  try {
    editDir = fs.mkdtempSync(path.join(opts.dir, 'shardmind-edit-'));
    const file = path.join(editDir, safeFileName(fileName, platform));
    fs.writeFileSync(file, content, 'utf-8');
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
    // The temp copy could not be written or read back (moved, deleted, disk full).
    return cancelled(`The edit could not be read back: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (editDir !== undefined) {
      try {
        fs.rmSync(editDir, { recursive: true, force: true });
      } catch {
        // A window editor can still hold it open (Windows EBUSY); it is under
        // the run's temp dir, which is removed when the command ends.
      }
    }
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
 */
export function withTerminalReleased<T>(setRawMode: ((on: boolean) => void) | undefined, fn: () => T): T {
  if (!setRawMode) return fn();
  setRawMode(false);
  try {
    return fn();
  } finally {
    setRawMode(true);
  }
}

/**
 * Run `fn` with SIGINT held: a Ctrl+C in an editor that leaves the terminal
 * cooked also reaches node, queued until `fn` returns, and must cancel the
 * edit, not the update. The listeners come back on the next turn of the
 * event loop, after any such signal is delivered; then `onRestored` runs.
 */
export function withSigintHeld<T>(fn: () => T, onRestored?: () => void): T {
  const listeners = process.listeners('SIGINT');
  const hold = (): void => {};
  for (const l of listeners) process.off('SIGINT', l);
  process.on('SIGINT', hold);
  const restore = (): void => {
    process.off('SIGINT', hold);
    for (const l of listeners) process.on('SIGINT', l);
    onRestored?.();
  };
  try {
    return fn();
  } finally {
    setImmediate(restore);
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
