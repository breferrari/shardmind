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
import { ShardMindError } from '../runtime/types.js';
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

export type ErrorDescription =
  | { kind: 'known'; message: string; code: string; hint: string | null }
  | { kind: 'environment'; message: string; code: string; hint: string }
  | { kind: 'bug'; message: string; url: string; stack: string | null };

export function describeError(error: unknown, version: string | undefined, cwd: string = process.cwd()): ErrorDescription {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ShardMindError) {
    return { kind: 'known', message, code: error.code, hint: error.hint ?? null };
  }
  const code = errnoCode(error);
  if (code !== undefined && code in ENVIRONMENT_HINTS && (code !== 'ENOENT' || isInside(errnoPath(error), cwd))) {
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

/** Print a throw that escaped every command, and exit 1 (#225). SIGINT is not touched. */
export function installCrashHandlers(
  proc: { on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown },
  opts: { version: string | undefined; write: (text: string) => void; exit: (code: number) => void },
): void {
  const crash = (error: unknown): void => {
    opts.write(formatErrorPlain(error, opts.version));
    opts.exit(1);
  };
  proc.on('uncaughtException', crash);
  proc.on('unhandledRejection', crash);
}

function errnoPath(error: unknown): string | undefined {
  const at = (error as { path?: unknown }).path;
  return typeof at === 'string' ? at : undefined;
}

function isInside(target: string | undefined, dir: string): boolean {
  if (target === undefined) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
