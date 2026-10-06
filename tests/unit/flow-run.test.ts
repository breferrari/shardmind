/**
 * The write step every flow ends with (#302): `runAndHooks` and the one
 * rolled-back marker. Spec: docs/IMPLEMENTATION.md §4.30 steps 4 and 8.
 */

import { describe, it, expect, vi } from 'vitest';

const runHooks = vi.fn(async () => ({ outcomes: [{ stage: 'post-install' }], finalState: {} }));
vi.mock('../../source/core/hook-orchestrator.js', () => ({ runHooks }));

const { runAndHooks } = await import('../../source/core/flows/run.js');
const { markRolledBack, wasRolledBack } = await import('../../source/core/rollback-report.js');

function recordingIO() {
  const calls: string[] = [];
  const io = {
    hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
    takeLock: () => calls.push('takeLock'),
    onCleanup: () => {},
    newRunAbort: () => {
      calls.push('newRunAbort');
      return new AbortController();
    },
    onRun: () => void calls.push('onRun'),
    onCommitted: () => void calls.push('onCommitted'),
    onHookAbort: (abort: AbortController | null) => void calls.push(abort ? 'hookAbort set' : 'hookAbort cleared'),
  };
  return { io, calls };
}

const plan = (state: unknown) => ({ command: 'install', state }) as never;

describe('runAndHooks (#302)', () => {
  it('runs under the run abort, commits, then runs the hooks under their own abort', async () => {
    const { io, calls } = recordingIO();
    let seen: AbortSignal | undefined;
    const { result, hooks } = await runAndHooks(
      io,
      { markOnFailure: true },
      async (signal) => {
        seen = signal;
        calls.push('run');
        return { state: { v: 1 } } as never;
      },
      (done) => plan((done as { state: unknown }).state),
    );
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(calls).toEqual(['newRunAbort', 'run', 'onRun', 'onCommitted', 'hookAbort set', 'hookAbort cleared']);
    expect(result).toEqual({ state: { v: 1 } });
    expect(hooks).toEqual([{ stage: 'post-install' }]);
    expect(runHooks).toHaveBeenCalledWith(expect.objectContaining({ state: { v: 1 } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('a failure is rethrown, marked as rolled back when the executor rolls back on any failure, and never commits', async () => {
    const { io, calls } = recordingIO();
    const boom = new Error('write failed');
    await expect(runAndHooks(io, { markOnFailure: true }, async () => Promise.reject(boom), () => plan({}))).rejects.toBe(boom);
    expect(wasRolledBack(boom)).toBe(true);
    expect(calls).not.toContain('onCommitted');
  });

  it('with markOnFailure false (a dry run, or install, whose executor marks its own) the failure is not marked', async () => {
    const { io } = recordingIO();
    const boom = new Error('nothing rolled back');
    await expect(runAndHooks(io, { markOnFailure: false }, async () => Promise.reject(boom), () => plan({}))).rejects.toBe(boom);
    expect(wasRolledBack(boom)).toBe(false);
  });

  it('the hooks abort is cleared when a hook throws', async () => {
    const { io, calls } = recordingIO();
    runHooks.mockRejectedValueOnce(new Error('hook crashed'));
    await expect(runAndHooks(io, { markOnFailure: true }, async () => ({ state: {} }) as never, () => plan({}))).rejects.toThrow('hook crashed');
    expect(calls.at(-1)).toBe('hookAbort cleared');
  });
});

describe('the rolled-back marker', () => {
  it('marks objects only, and nothing unmarked', () => {
    const err = new Error('x');
    expect(wasRolledBack(err)).toBe(false);
    markRolledBack(err);
    expect(wasRolledBack(err)).toBe(true);
    markRolledBack('a string');
    expect(wasRolledBack('a string')).toBe(false);
    expect(wasRolledBack(null)).toBe(false);
  });
});
