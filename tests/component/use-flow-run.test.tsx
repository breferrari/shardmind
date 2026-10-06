/**
 * useFlowRun (#302): what a superseded run may still do. Spec:
 * docs/IMPLEMENTATION.md §4.30 step 10.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { useEffect } from 'react';
import { Text } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import os from 'node:os';
import { useFlowRun, type BasePhase, type FlowRunContext } from '../../source/commands/hooks/use-flow-run.js';
import { tick } from './helpers.js';
import { resetSigintRollbackForTests } from '../../source/commands/hooks/shared.js';

type Phase = { kind: 'booting' } | { kind: 'done' } | BasePhase;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // A Ctrl+C sets a once-per-process latch; reset it between tests.
  resetSigintRollbackForTests();
});

/** Runs `start` once per `runKey`; a new key supersedes the run before it. */
function Harness({
  runKey,
  start,
  dryRun = true,
}: {
  runKey: number;
  start: (key: number, ctx: FlowRunContext<Phase>) => Promise<Phase>;
  dryRun?: boolean;
}) {
  const { phase, launch } = useFlowRun<Phase>({
    vaultRoot: os.tmpdir(),
    command: 'install',
    // The lock is taken only through `lock()`; these runs never call it.
    dryRun,
    initial: { kind: 'booting' },
    isFinal: (p) => p.kind === 'done' || p.kind === 'error' || p.kind === 'cancelled',
    rolledBackLine: 'Rolled back.',
    asPhase: (p) => p,
  });
  useEffect(() => launch((ctx) => start(runKey, ctx)), [runKey]);
  return <Text>{phase.kind}</Text>;
}

describe('useFlowRun: a superseded run (#302)', () => {
  it('gets an aborted run abort, so its executor stops before it writes', async () => {
    let releaseFirst: () => void = () => {};
    const firstAbort: { signal?: AbortSignal } = {};
    const start = async (key: number, ctx: FlowRunContext<Phase>): Promise<Phase> => {
      if (key === 1) {
        // The run's last question was answered; it plans, then reaches its write.
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        firstAbort.signal = ctx.io.newRunAbort().signal;
      }
      return { kind: 'done' };
    };
    const r = render(<Harness runKey={1} start={start} />);
    await tick(20);
    r.rerender(<Harness runKey={2} start={start} />);
    await tick(20);
    releaseFirst();
    await tick(20);
    expect(firstAbort.signal?.aborted).toBe(true);
  });

  it('cannot clear the hooks abort of the run that replaced it', async () => {
    let releaseFirst: () => void = () => {};
    const seen: { second?: AbortController } = {};
    const start = async (key: number, ctx: FlowRunContext<Phase>): Promise<Phase> => {
      const abort = new AbortController();
      ctx.io.onHookAbort(abort);
      if (key === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        // The superseded run's hooks end: its `finally` clears its abort.
        ctx.io.onHookAbort(null);
        return { kind: 'done' };
      }
      seen.second = abort;
      return new Promise<Phase>(() => {});
    };
    const r = render(<Harness runKey={1} start={start} />);
    await tick(20);
    r.rerender(<Harness runKey={2} start={start} />);
    await tick(20);
    releaseFirst();
    await tick(20);
    // A Ctrl+C now still reaches the second run's hook.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.emit('SIGINT');
    await tick(20);
    expect(seen.second?.signal.aborted).toBe(true);
  });

  it('a run superseded mid-write has its run abort aborted, so it rolls back', async () => {
    let held: AbortSignal | undefined;
    let reached: () => void = () => {};
    const atWrite = new Promise<void>((resolve) => (reached = resolve));
    const start = async (key: number, ctx: FlowRunContext<Phase>): Promise<Phase> => {
      if (key === 1) {
        held = ctx.io.newRunAbort().signal;
        reached();
        return new Promise<Phase>(() => {});
      }
      return { kind: 'done' };
    };
    const r = render(<Harness runKey={1} start={start} />);
    await atWrite;
    expect(held?.aborted).toBe(false);
    r.rerender(<Harness runKey={2} start={start} />);
    await tick(20);
    expect(held?.aborted).toBe(true);
  });

  it('cannot take its successor\'s run handle or hooks abort, nor release a lock it never took', async () => {
    let releaseFirst: () => void = () => {};
    const seen: { second?: AbortController; secondRun?: AbortController; firstHook?: AbortController; firstRelease?: () => void } = {};
    const start = async (key: number, ctx: FlowRunContext<Phase>): Promise<Phase> => {
      if (key === 1) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        // Superseded now: it reaches its write and its hooks anyway.
        const abort = ctx.io.newRunAbort();
        ctx.io.onRun(abort, new Promise(() => {}));
        seen.firstHook = new AbortController();
        ctx.io.onHookAbort(seen.firstHook);
        seen.firstRelease = ctx.io.lock().release;
        return { kind: 'done' };
      }
      // The successor is mid-write, and its hook runs too.
      seen.secondRun = ctx.io.newRunAbort();
      const signal = seen.secondRun.signal;
      // As an executor does: stopped by its signal, it rolls back and rejects.
      ctx.io.onRun(seen.secondRun, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))));
      const abort = new AbortController();
      ctx.io.onHookAbort(abort);
      seen.second = abort;
      return new Promise<Phase>(() => {});
    };
    // Not a dry run: a Ctrl+C stops the run in flight.
    const r = render(<Harness runKey={1} start={start} dryRun={false} />);
    await tick(20);
    r.rerender(<Harness runKey={2} start={start} dryRun={false} />);
    await tick(20);
    releaseFirst();
    await tick(20);
    // The superseded run's hooks abort is aborted at once: it runs no hooks.
    expect(seen.firstHook?.signal.aborted).toBe(true);
    // A Ctrl+C reaches the successor's hook, not the superseded run's.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.emit('SIGINT');
    await tick(20);
    expect(seen.second?.signal.aborted).toBe(true);
    // ...and stops the successor's run, whose handle the superseded run did not take.
    expect(seen.secondRun?.signal.aborted).toBe(true);
  });
});
