/**
 * #225 second review: the error report must hold up when the error, the
 * process or the build is odd. Kept apart from bug-report.test.ts so each
 * case names the failure it guards.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describeError, formatErrorPlain, installCrashHandlers } from '../../source/core/bug-report.js';
import { ShardMindError } from '../../source/runtime/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ShardMindError across bundles (#225)', () => {
  it('is an instance by its brand, as one from the other bundle carries it', () => {
    // What a ShardMindError built by dist/commands/* looks like to dist/cli.js.
    const foreign = Object.assign(new Error('nope'), {
      name: 'ShardMindError',
      code: 'SHARD_NOT_FOUND',
      hint: 'spell it',
      [Symbol.for('shardmind.ShardMindError')]: true,
    });
    expect(foreign instanceof ShardMindError).toBe(true);
    expect(describeError(foreign, '0.1.9', '/v')).toMatchObject({ kind: 'known', code: 'SHARD_NOT_FOUND', hint: 'spell it' });
  });

  it('is not an instance by its name alone', () => {
    const impostor = Object.assign(new Error('x'), { name: 'ShardMindError', code: 'SHARD_NOT_FOUND' });
    expect(impostor instanceof ShardMindError).toBe(false);
    expect(describeError(impostor, '0.1.9', '/v').kind).toBe('bug');
  });

  it('still is one for an error built here', () => {
    expect(new ShardMindError('x', 'SHARD_NOT_FOUND') instanceof ShardMindError).toBe(true);
    expect(new Error('x') instanceof ShardMindError).toBe(false);
    const nothing: unknown = null;
    expect(nothing instanceof ShardMindError).toBe(false);
  });
});

describe('odd throws (#225)', () => {
  it('describes a null-prototype object and one whose toString throws, without throwing', () => {
    const bare = Object.create(null) as object;
    const hostile = { toString: () => { throw new Error('no'); } };
    for (const odd of [bare, hostile]) {
      expect(describeError(odd, '0.1.9', '/v').kind).toBe('bug');
      expect(() => formatErrorPlain(odd, '0.1.9', '/v')).not.toThrow();
    }
  });

  it('does not take an Object.prototype key for an environment code', () => {
    for (const code of ['constructor', 'toString', '__proto__']) {
      expect(describeError(Object.assign(new Error('x'), { code }), '0.1.9', '/v').kind).toBe('bug');
    }
  });
});

describe('a vault removed while shardmind runs (#225)', () => {
  it('still knows a missing file in it is the environment, from the directory shardmind started in', () => {
    const started = process.cwd();
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: process.cwd failed, uv_cwd'), { code: 'ENOENT' });
    });
    const at = path.join(started, 'brain', 'note.md');
    const err = Object.assign(new Error(`ENOENT: open '${at}'`), { code: 'ENOENT', path: at });
    expect(describeError(err, '0.1.9').kind).toBe('environment');
  });

  it.skipIf(process.platform === 'win32')('keeps a POSIX file named with a leading `..\\` inside the vault', () => {
    const at = path.join('/v', '..\\draft.md');
    expect(describeError(Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: at }), '0.1.9', '/v').kind).toBe('environment');
  });
});

describe('one report per process (#225)', () => {
  it('prints once whether the crash comes through the handler or the top-level catch', () => {
    const proc = new EventEmitter();
    const written: string[] = [];
    const exits: number[] = [];
    const report = installCrashHandlers(proc, { version: '0.1.9', write: (s) => written.push(s), exit: (c) => exits.push(c) });
    report(new TypeError('from the catch'));
    proc.emit('unhandledRejection', new TypeError('stray rejection'));
    expect(written.join('')).toContain('from the catch');
    expect(written.join('')).not.toContain('stray rejection');
    expect(exits).toEqual([1]);
  });
});
