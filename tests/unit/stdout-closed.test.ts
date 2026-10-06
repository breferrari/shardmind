/**
 * A closed stdout (`shardmind --json | head -1`) ends the run quietly with
 * 141, after the run has finished on its own (#252).
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { exitQuietlyWhenStdoutCloses, STDOUT_CLOSED_EXIT_CODE } from '../../source/core/stdout-closed.js';

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE', syscall: 'write' });
}

/** A stand-in for `process`: its stdout records what reaches it. */
function fakeProcess() {
  const written: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string, ...rest: unknown[]): boolean => {
      written.push(chunk);
      const callback = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    },
  });
  const proc = Object.assign(new EventEmitter(), { stdout, exitCode: undefined as number | string | undefined });
  return { proc, stdout, written };
}

describe('exitQuietlyWhenStdoutCloses', () => {
  it('does not end the run at EPIPE: later writes are dropped, their callbacks still called', async () => {
    const { proc, stdout, written } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    stdout.emit('error', epipe());
    let called = false;
    const returned = stdout.write('after the pipe closed', () => (called = true));
    // On a later tick, as a stream calls it.
    expect(called).toBe(false);
    await new Promise((resolve) => process.nextTick(resolve));
    expect(called).toBe(true);
    expect(written).toEqual([]);
    expect(returned).toBe(true);
    expect(proc.exitCode).toBeUndefined();
  });

  it('exits 141 when the run exits before the stream has emitted its EPIPE', () => {
    // A failed write's callback runs before 'error' is emitted; a run that
    // exits from that callback must still exit 141.
    const { proc, stdout } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    Object.assign(stdout, { errored: epipe() });
    proc.emit('exit', 0);
    expect(proc.exitCode).toBe(STDOUT_CLOSED_EXIT_CODE);
  });

  it('exits 141 when the run would have exited 0', () => {
    const { proc, stdout } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    stdout.emit('error', epipe());
    proc.emit('exit', 0);
    expect(proc.exitCode).toBe(STDOUT_CLOSED_EXIT_CODE);
    expect(STDOUT_CLOSED_EXIT_CODE).toBe(141);
  });

  it('keeps an exit code the run reached itself', () => {
    const { proc, stdout } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    stdout.emit('error', epipe());
    proc.exitCode = 1;
    proc.emit('exit', 1);
    expect(proc.exitCode).toBe(1);
  });

  it('leaves the exit code alone while stdout is open', () => {
    const { proc, written, stdout } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    stdout.write('{}\n');
    proc.emit('exit', 0);
    expect(proc.exitCode).toBeUndefined();
    expect(written).toEqual(['{}\n']);
  });

  it('rethrows any other stdout error, so the crash handler still reports it', () => {
    const { proc, stdout } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    const other = Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    expect(() => stdout.emit('error', other)).toThrow(other);
  });

  it('ignores further stdout errors once the pipe has closed', () => {
    const { proc, stdout } = fakeProcess();
    exitQuietlyWhenStdoutCloses(proc, (code) => (proc.exitCode = code));
    stdout.emit('error', epipe());
    const destroyed = Object.assign(new Error('Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
    expect(() => stdout.emit('error', destroyed)).not.toThrow();
    expect(() => stdout.emit('error', epipe())).not.toThrow();
  });
});
