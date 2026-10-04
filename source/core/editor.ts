/**
 * Open a conflict in the user's editor (#50). See docs/IMPLEMENTATION.md
 * §4.23.
 *
 * Pure of Ink: the caller releases the terminal's raw mode around
 * `editInEditor` with `withTerminalReleased`. The vault is never written
 * here; the update executor writes an edit under its snapshot and rollback.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export type EditOutcome =
  | { kind: 'saved'; content: string }
  | { kind: 'cancelled'; reason: 'not-started' | 'exit' | 'unchanged'; detail: string };

/** `$VISUAL`, then `$EDITOR`. None set: undefined, and the prompt offers no editor. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ['VISUAL', 'EDITOR'] as const) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Write `content` to a temp copy named `fileName` under `dir`, run the editor
 * on it, and return what was saved. A failed, stopped or unchanged edit is a
 * cancel. The temp copy is removed on every path.
 */
export function editInEditor(
  content: string,
  fileName: string,
  opts: { command: string; dir: string; platform?: NodeJS.Platform },
): EditOutcome {
  const editDir = path.join(opts.dir, `shardmind-edit-${crypto.randomBytes(6).toString('hex')}`);
  const file = path.join(editDir, fileName);
  try {
    fs.mkdirSync(editDir, { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    const run = spawnSync(`${opts.command} ${quoteForShell(file, opts.platform ?? process.platform)}`, {
      shell: true,
      stdio: 'inherit',
    });
    if (run.error) return { kind: 'cancelled', reason: 'not-started', detail: `${opts.command} could not start: ${run.error.message}` };
    if (run.signal) return { kind: 'cancelled', reason: 'exit', detail: `${opts.command} was stopped (${run.signal})` };
    if (run.status !== 0) {
      // A shell that cannot find the command exits 127 (POSIX) or 1 (cmd.exe):
      // either way the edit did not happen.
      return { kind: 'cancelled', reason: 'exit', detail: `${opts.command} exited with code ${run.status}` };
    }
    const saved = fs.readFileSync(file, 'utf-8');
    if (saved === content) return { kind: 'cancelled', reason: 'unchanged', detail: 'The file was saved unchanged.' };
    return { kind: 'saved', content: saved };
  } finally {
    fs.rmSync(editDir, { recursive: true, force: true });
  }
}

/** A line that starts a merge's conflict markers: `<<<<<<< `, `>>>>>>> `, or exactly `=======`. */
export function hasConflictMarkers(content: string): boolean {
  return /^(?:<<<<<<< |>>>>>>> |=======\r?$)/m.test(content);
}

/**
 * Leave raw mode for `fn` (the editor owns the terminal meanwhile) and
 * restore it after, whether `fn` returns or throws.
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

function quoteForShell(value: string, platform: NodeJS.Platform): string {
  // cmd.exe: double quotes; a filename cannot contain one on Windows.
  if (platform === 'win32') return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
