/**
 * How a command shows an error (#225). `describeError` sorts it into one of
 * three kinds, and every surface renders from that: the Ink error view, the
 * plain-text top-level handler, and `--json`.
 *
 * - `known`: a ShardMindError. Its code and hint, as before.
 * - `environment`: a Node errno error the user's machine causes (a full disk,
 *   a permission, a locked file). Its code and a hint, and no report link:
 *   telling a user to report a full disk teaches them to ignore the prompt.
 * - `bug`: anything else. A report link and the stack.
 *
 * The report link carries the shardmind version and nothing else. No part of
 * the error travels in it, so no value, vault path or file content can leave
 * the machine through it; the user pastes what they choose. It is kept short
 * on purpose: Ink wraps a line at the terminal width with real line breaks,
 * and a link broken across lines can be neither clicked nor copied whole. At
 * about 70 characters it fits an 80-column terminal.
 */

import path from 'node:path';
import { ShardMindError, type ErrorCode } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';

const NEW_ISSUE_URL = 'https://github.com/breferrari/shardmind/issues/new';

/** With no readable version, the bare new-issue URL. */
export function bugReportUrl(version: string | undefined): string {
  return version === undefined ? NEW_ISSUE_URL : `${NEW_ISSUE_URL}?${new URLSearchParams({ body: `shardmind ${version}` })}`;
}

const ENVIRONMENT_HINTS: Readonly<Record<string, string>> = {
  EACCES: 'shardmind was not allowed to use this path. Check its permissions, then run the command again.',
  EPERM: 'The operating system refused this operation. Check the path’s permissions, or whether another program holds it, then run the command again.',
  ENOSPC: 'The disk is full. Free some space, then run the command again.',
  EBUSY: 'Another program is using this file (an editor, a sync client, a virus scan). Close it, then run the command again.',
  EROFS: 'This path is on a read-only file system. Run shardmind in a folder you can write to.',
  EMFILE: 'Too many files are open at once. Close other programs or raise the open-file limit (`ulimit -n`), then run the command again.',
  ENOENT: 'A file in your vault went missing while shardmind ran (moved, deleted, or still syncing). Run the command again.',
};

/** The per-code hint for an environmental errno (a full disk, a locked file, #225), or undefined. */
export function environmentHint(err: unknown): string | undefined {
  const code = errnoCode(err);
  return code !== undefined && Object.hasOwn(ENVIRONMENT_HINTS, code) ? ENVIRONMENT_HINTS[code] : undefined;
}

/**
 * A command's filesystem failure as a known error (#313). The error view
 * shows a `ShardMindError` with its own hint, so an environmental errno keeps
 * its per-code hint ("The disk is full…"); otherwise the hint is `fallback`,
 * or the raw message. The original error is the `cause`.
 */
export function wrapWriteError(code: ErrorCode, message: string, err: unknown, fallback?: string): ShardMindError {
  const hint = environmentHint(err) ?? fallback ?? (err instanceof Error ? err.message : String(err));
  return Object.assign(new ShardMindError(message, code, hint), { cause: err });
}

export type ErrorDescription =
  | { kind: 'known'; message: string; code: string; hint: string | null }
  | { kind: 'environment'; message: string; code: string; hint: string }
  | { kind: 'bug'; message: string; url: string; stack: string | null };

/**
 * `cwd` defaults to the working directory, read only for an ENOENT. Once
 * the vault folder itself is removed, reading it throws, so the directory
 * shardmind started in stands in.
 */
export function describeError(error: unknown, version: string | undefined, cwd?: string): ErrorDescription {
  const message = error instanceof Error ? error.message : safeString(error);
  if (error instanceof ShardMindError) {
    return { kind: 'known', message, code: error.code, hint: error.hint ?? null };
  }
  const code = errnoCode(error);
  if (code !== undefined && Object.hasOwn(ENVIRONMENT_HINTS, code) && (code !== 'ENOENT' || isInside(errnoPath(error), cwd ?? currentDir()))) {
    return { kind: 'environment', message, code, hint: ENVIRONMENT_HINTS[code]! };
  }
  return {
    kind: 'bug',
    message,
    url: bugReportUrl(version),
    stack: error instanceof Error && error.stack ? error.stack : null,
  };
}

/**
 * The same view as plain text, for the top-level handler: a throw that
 * escaped every command may arrive before Ink is mounted, or after it is gone.
 */
export function formatErrorPlain(error: unknown, version: string | undefined, cwd?: string): string {
  const d = describeError(error, version, cwd);
  const lines = [`✘ ${d.message}`];
  if (d.kind === 'bug') {
    lines.push('', 'This is a bug in shardmind. Please report it:', d.url);
    if (d.stack) lines.push('', d.stack);
  } else {
    lines.push(`code: ${d.code}`);
    if (d.hint) lines.push(d.hint);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Print a throw that escaped every command, and exit 1 (#225). Only the first
 * is printed: a second one during teardown would repeat the report. SIGINT is
 * not touched.
 */
export function installCrashHandlers(
  proc: { on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown },
  opts: {
    readonly version: string | undefined;
    write: (text: string) => void;
    /** A `--json` run: also answer the caller on stdout (#198). */
    writeJson?: (error: unknown) => void;
    exit: (code: number) => void;
  },
): (error: unknown) => void {
  let crashed = false;
  const crash = (error: unknown): void => {
    if (crashed) return;
    crashed = true;
    try {
      opts.writeJson?.(error);
    } catch {
      // The plain-text report and the exit below must still happen.
    }
    opts.write(formatErrorPlain(error, opts.version));
    opts.exit(1);
  };
  proc.on('uncaughtException', crash);
  proc.on('unhandledRejection', crash);
  // The top-level catch reports through the same function, so it shares the once-guard.
  return crash;
}

function errnoPath(error: unknown): string | undefined {
  const at = (error as { path?: unknown }).path;
  return typeof at === 'string' ? at : undefined;
}

/** The folder itself, or anything under it. */
function isInside(target: string | undefined, dir: string | undefined): boolean {
  if (target === undefined || dir === undefined) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

const START_DIR = (() => {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
})();

function currentDir(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return START_DIR;
  }
}

/** String(value), which throws for a null-prototype object or a throwing toString. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
