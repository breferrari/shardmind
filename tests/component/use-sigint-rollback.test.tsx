/**
 * `useSigintRollback` runs once per process (#155).
 *
 * Ctrl+C can now reach the handler twice in quick succession: from the
 * stdin bridge (raw-mode 0x03, or ETX on a pipe) and from a kernel SIGINT.
 * A second run would race the first on the same paths, so the handler
 * absorbs repeats and the first run alone ends in exit(130).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import {
  useSigintRollback,
  resetSigintRollbackForTests,
  newRunAbort,
  stopRun,
  trackRun,
  isCancelledRun,
} from '../../source/commands/hooks/shared.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { withRollbackFailures } from '../../source/core/rollback-report.js';
import { withSigintHeld } from '../../source/core/editor.js';

function Probe(props: { rollback: () => Promise<unknown>; cleanup: () => Promise<void> }) {
  useSigintRollback({ isActive: () => true, rollback: props.rollback, cleanup: props.cleanup });
  return <Text>probe</Text>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSigintRollbackForTests();
});

describe('useSigintRollback', () => {
  it('rolls back once and exits 130 once, however many SIGINTs arrive', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let release!: () => void;
    const rollback = vi.fn(() => new Promise<void>((r) => (release = r)));
    const cleanupFn = vi.fn(async () => {});
    render(<Probe rollback={rollback} cleanup={cleanupFn} />);
    await new Promise((r) => setImmediate(r));

    process.emit('SIGINT');
    process.emit('SIGINT'); // the user presses Ctrl+C again mid-rollback
    await new Promise((r) => setImmediate(r));
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(cleanupFn).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('keeps absorbing SIGINT after the tree unmounts mid-rollback', async () => {
    // In a TTY the first Ctrl+C also reaches Ink, which unmounts the tree
    // while the rollback is still running. A second Ctrl+C must not find
    // zero listeners, or Node's default action kills the rollback.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let release!: () => void;
    const rollback = vi.fn(() => new Promise<void>((r) => (release = r)));
    const listenersBefore = process.listenerCount('SIGINT');
    const r = render(<Probe rollback={rollback} cleanup={async () => {}} />);
    await new Promise((res) => setImmediate(res));

    process.emit('SIGINT');
    r.unmount();
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore + 1);
    process.emit('SIGINT');
    await new Promise((res) => setImmediate(res));
    expect(rollback).toHaveBeenCalledTimes(1);

    release();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('does not start a second rollback from a remounted instance', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let release!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => (release = r)));
    const second = vi.fn(async () => {});
    render(<Probe rollback={first} cleanup={async () => {}} />);
    render(<Probe rollback={second} cleanup={async () => {}} />);
    await new Promise((res) => setImmediate(res));

    process.emit('SIGINT');
    await new Promise((res) => setImmediate(res));
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    release?.();
  });

  it('prints what the rollback could not restore to stderr, then exits 130 (#247)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const rollback = vi.fn(async () => [
      { path: 'Home.md', reason: 'restore failed: EBUSY', backup: '/v/.shardmind/backups/adopt-1/files/Home.md' },
    ]);
    render(<Probe rollback={rollback} cleanup={async () => {}} />);
    await new Promise((r) => setImmediate(r));
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/Rollback incomplete \((1 path)\)/);
    expect(written).toMatch(/Home\.md: restore failed: EBUSY; its backup is at \/v\/\.shardmind\/backups\/adopt-1\/files\/Home\.md/);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('prints a rollback that throws partway, then exits 130 (#247)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    render(<Probe rollback={async () => { throw new Error('EIO on the snapshot'); }} cleanup={async () => {}} />);
    await new Promise((r) => setImmediate(r));
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/\(the rollback\): stopped partway: EIO on the snapshot/);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('a Ctrl+C while the editor holds SIGINT starts nothing, and later runs are not aborted (#50, #249)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const rollback = vi.fn(async () => []);
    render(<Probe rollback={rollback} cleanup={async () => {}} />);
    await new Promise((r) => setImmediate(r));
    // The editor runs inside withSigintHeld; a Ctrl+C there is absorbed.
    withSigintHeld(() => {
      process.emit('SIGINT');
    });
    // Listeners come back two turns later; the user returns and accepts.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(rollback).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(newRunAbort().signal.aborted).toBe(false);
    // And a Ctrl+C after the editor still works.
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('a run started after Ctrl+C was handled is born aborted (#249)', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    expect(newRunAbort().signal.aborted).toBe(false);
    render(<Probe rollback={async () => []} cleanup={async () => {}} />);
    await new Promise((r) => setImmediate(r));
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(newRunAbort().signal.aborted).toBe(true);
  });
});

describe('the run in flight (#249)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stopRun aborts the run and returns its rollback's failures", async () => {
    const abort = new AbortController();
    const failure = { path: 'Home.md', reason: 'restore failed: EBUSY' };
    let reject!: (e: unknown) => void;
    const run = new Promise((_, r) => (reject = r));
    const tracked = trackRun(abort, run);
    const stopped = stopRun(tracked);
    expect(abort.signal.aborted).toBe(true);
    reject(withRollbackFailures(new ShardMindError('Cancelled.', 'CANCELLED'), [failure]));
    expect(await stopped).toEqual([failure]);
  });

  it('stopRun says so when the run had already finished', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await stopRun(trackRun(new AbortController(), Promise.resolve()))).toEqual([]);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/already finished/);
  });

  it('isCancelledRun sees a cancel, also inside ROLLBACK_INCOMPLETE, and nothing else', () => {
    const cancelled = new ShardMindError('Cancelled.', 'CANCELLED');
    expect(isCancelledRun(cancelled)).toBe(true);
    expect(isCancelledRun(withRollbackFailures(cancelled, [{ path: 'a', reason: 'b' }]))).toBe(true);
    expect(isCancelledRun(new ShardMindError('x', 'ADOPT_WRITE_FAILED'))).toBe(false);
    expect(isCancelledRun(null)).toBe(false);
  });
});
