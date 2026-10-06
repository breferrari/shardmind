/**
 * The write step every flow ends with (#302): `runAndHooks` and the one
 * rolled-back marker. Spec: docs/IMPLEMENTATION.md §4.30 steps 4 and 8.
 */

import { describe, it, expect, vi } from 'vitest';

const runHooks = vi.fn(async () => ({ outcomes: [{ slot: 'bootstrap' }], finalState: {} }));
vi.mock('../../source/core/hook-orchestrator.js', () => ({ runHooks }));

const { runAndHooks } = await import('../../source/core/flows/run.js');
const { markRolledBack, rolledBackError, wasRolledBack } = await import('../../source/core/rollback-report.js');

function recordingIO() {
  const calls: string[] = [];
  const io = {
    hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
    lock: () => ({ release: () => {} }),
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
    expect(hooks).toEqual([{ slot: 'bootstrap' }]);
    expect(runHooks).toHaveBeenCalledWith(expect.objectContaining({ state: { v: 1 } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('a failure is rethrown as the executor threw it, and never commits', async () => {
    const { io, calls } = recordingIO();
    const boom = new Error('write failed');
    await expect(runAndHooks(io, async () => Promise.reject(boom), () => plan({}))).rejects.toBe(boom);
    expect(wasRolledBack(boom)).toBe(false);
    expect(calls).not.toContain('onCommitted');
  });

  it('the hooks abort is cleared when a hook throws', async () => {
    const { io, calls } = recordingIO();
    runHooks.mockRejectedValueOnce(new Error('hook crashed'));
    await expect(runAndHooks(io, async () => ({ state: {} }) as never, () => plan({}))).rejects.toThrow('hook crashed');
    expect(calls.at(-1)).toBe('hookAbort cleared');
  });
});

describe('the rolled-back marker', () => {
  it('rolledBackError after a clean rollback returns the error itself, marked', async () => {
    const err = new Error('write failed');
    const thrown = await rolledBackError(err, async () => []);
    expect(thrown).toBe(err);
    expect(wasRolledBack(thrown)).toBe(true);
  });

  it('rolledBackError after an incomplete rollback returns ROLLBACK_INCOMPLETE naming what was left, marked', async () => {
    const err = new Error('write failed');
    const thrown = (await rolledBackError(err, async () => [{ path: 'Home.md', reason: 'restore failed: EBUSY' }])) as {
      code?: string;
      cause?: unknown;
      rollbackFailures?: unknown;
    };
    expect(thrown.code).toBe('ROLLBACK_INCOMPLETE');
    expect(thrown.cause).toBe(err);
    expect(thrown.rollbackFailures).toEqual([{ path: 'Home.md', reason: 'restore failed: EBUSY' }]);
    expect(wasRolledBack(thrown)).toBe(true);
  });

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
