/**
 * The error report (#225): which errors are shardmind's bugs, what the
 * report link carries, and the plain-text view the top-level handler prints.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { z } from 'zod';
import {
  bugReportUrl,
  describeError,
  formatErrorPlain,
  installCrashHandlers,
} from '../../source/core/bug-report.js';
import { ShardMindError } from '../../source/runtime/types.js';

const VAULT = path.resolve('/vaults/my-vault');

function errno(code: string, message: string, at?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, ...(at ? { path: at } : {}) });
}

describe('bugReportUrl (#225)', () => {
  it('opens a new issue on the shardmind tracker with the version in the body', () => {
    const url = bugReportUrl('0.1.9');
    expect(url.startsWith('https://github.com/breferrari/shardmind/issues/new?')).toBe(true);
    expect([...new URL(url).searchParams]).toEqual([['body', 'shardmind 0.1.9']]);
  });

  it('is the bare new-issue URL when the version cannot be read', () => {
    expect(bugReportUrl(undefined)).toBe('https://github.com/breferrari/shardmind/issues/new');
  });

  it('fits one 80-column line, so Ink never breaks it, even for a long version', () => {
    expect(bugReportUrl('10.20.30').length).toBeLessThanOrEqual(80);
    expect(bugReportUrl(undefined).length).toBeLessThanOrEqual(80);
  });
});

describe('describeError (#225)', () => {
  it('keeps a ShardMindError as known, with its code and hint', () => {
    expect(describeError(new ShardMindError('nope', 'SHARD_NOT_FOUND', 'spell it'), '0.1.9', VAULT)).toEqual({
      kind: 'known',
      message: 'nope',
      code: 'SHARD_NOT_FOUND',
      hint: 'spell it',
    });
  });

  it.each(['EACCES', 'EPERM', 'ENOSPC', 'EBUSY', 'EROFS', 'EMFILE'])(
    'treats %s as the environment: its code and a hint, no report link',
    (code) => {
      const d = describeError(errno(code, `${code}: failed, open '/tmp/x'`, '/tmp/x'), '0.1.9', VAULT);
      expect(d).toMatchObject({ kind: 'environment', code, message: `${code}: failed, open '/tmp/x'` });
      expect(d.kind === 'environment' && d.hint.length).toBeGreaterThan(10);
      expect(d).not.toHaveProperty('url');
    },
  );

  it('treats ENOENT inside the working directory (the vault) as the environment', () => {
    const at = path.join(VAULT, 'brain', 'note.md');
    expect(describeError(errno('ENOENT', `ENOENT: no such file, open '${at}'`, at), '0.1.9', VAULT)).toMatchObject({
      kind: 'environment',
      code: 'ENOENT',
    });
  });

  it("treats ENOENT outside the working directory (shardmind's own temp) as a bug", () => {
    const at = path.resolve('/tmp/shardmind-abc/x.njk');
    expect(describeError(errno('ENOENT', 'ENOENT', at), '0.1.9', VAULT).kind).toBe('bug');
    expect(describeError(errno('ENOENT', 'ENOENT'), '0.1.9', VAULT).kind).toBe('bug');
  });

  it('counts the vault folder itself, and a name inside it that starts with two dots, as the vault', () => {
    for (const at of [VAULT, path.join(VAULT, '..sync-conflict.md')]) {
      expect(describeError(errno('ENOENT', 'ENOENT', at), '0.1.9', VAULT).kind).toBe('environment');
    }
  });

  it('does not throw when the working directory itself is gone', () => {
    const spy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw errno('ENOENT', 'ENOENT: process.cwd failed, uv_cwd');
    });
    try {
      expect(describeError(errno('EACCES', 'EACCES'), '0.1.9').kind).toBe('environment');
      expect(describeError(errno('ENOENT', 'ENOENT', path.join(VAULT, 'x.md')), '0.1.9').kind).toBe('bug');
      expect(describeError(new TypeError('boom'), '0.1.9').kind).toBe('bug');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not take a sibling folder that shares the vault prefix for the vault', () => {
    const at = `${VAULT}-old${path.sep}x.md`;
    expect(describeError(errno('ENOENT', 'ENOENT', at), '0.1.9', VAULT).kind).toBe('bug');
  });

  it('keeps an unrecognised errno code, a raw ZodError and a thrown string as bugs', () => {
    const zod = z.object({ a: z.string() }).safeParse({ a: 1 });
    for (const err of [errno('ECONNRESET', 'socket hang up'), zod.success ? null : zod.error, 'odd']) {
      const d = describeError(err, '0.1.9', VAULT);
      expect(d.kind).toBe('bug');
      expect(d.kind === 'bug' && d.url).toBe(bugReportUrl('0.1.9'));
    }
  });

  it("carries a bug's stack, and none for a thrown non-Error", () => {
    const err = new TypeError('boom');
    expect(describeError(err, '0.1.9', VAULT)).toMatchObject({ kind: 'bug', message: 'boom', stack: err.stack });
    expect(describeError('odd', '0.1.9', VAULT)).toMatchObject({ kind: 'bug', message: 'odd', stack: null });
  });
});

describe('formatErrorPlain (#225)', () => {
  it('prints a bug with the report line, the link and the stack, and no terminal codes', () => {
    const err = new TypeError('boom');
    const out = formatErrorPlain(err, '0.1.9', VAULT);
    expect(out).toContain('boom');
    expect(out).toContain('This is a bug in shardmind. Please report it:');
    expect(out).toContain(bugReportUrl('0.1.9'));
    expect(out).toContain(err.stack!);
    expect(out).not.toContain('\u001b');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('prints an environment error and a known error with code and hint, without bug framing', () => {
    for (const err of [errno('ENOSPC', 'ENOSPC: no space left on device, write'), new ShardMindError('nope', 'SHARD_NOT_FOUND', 'spell it')]) {
      const out = formatErrorPlain(err, '0.1.9', VAULT);
      expect(out).toMatch(/code: (ENOSPC|SHARD_NOT_FOUND)/);
      expect(out).not.toContain('This is a bug');
      expect(out).not.toContain('issues/new');
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installCrashHandlers (#225)', () => {
  function harness() {
    const proc = new EventEmitter();
    const written: string[] = [];
    const exits: number[] = [];
    installCrashHandlers(proc, { version: '0.1.9', write: (s) => written.push(s), exit: (c) => exits.push(c) });
    return { proc, written, exits };
  }

  it('prints an uncaught exception as plain text and exits 1', () => {
    const { proc, written, exits } = harness();
    proc.emit('uncaughtException', new TypeError('escaped'));
    expect(written.join('')).toMatch(/escaped[\s\S]*This is a bug in shardmind/);
    expect(exits).toEqual([1]);
  });

  it('reports only the first crash, so a second one during teardown is not printed twice', () => {
    const { proc, written, exits } = harness();
    proc.emit('uncaughtException', new TypeError('first'));
    proc.emit('unhandledRejection', new TypeError('second'));
    expect(written.join('')).toContain('first');
    expect(written.join('')).not.toContain('second');
    expect(exits).toEqual([1]);
  });

  it('prints an unhandled rejection the same way', () => {
    const { proc, written, exits } = harness();
    proc.emit('unhandledRejection', new RangeError('nobody awaited'));
    expect(written.join('')).toMatch(/nobody awaited[\s\S]*issues\/new/);
    expect(exits).toEqual([1]);
  });
});
