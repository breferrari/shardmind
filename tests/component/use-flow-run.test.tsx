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
function Harness({ runKey, start }: { runKey: number; start: (key: number, ctx: FlowRunContext<Phase>) => Promise<Phase> }) {
  const { phase, launch } = useFlowRun<Phase>({
    vaultRoot: os.tmpdir(),
    command: 'install',
    // A dry run takes no lock, so the harness needs no vault.
    dryRun: true,
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
});
