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
import { useSigintRollback, resetSigintRollbackForTests } from '../../source/commands/hooks/shared.js';

function Probe(props: { rollback: () => Promise<void>; cleanup: () => Promise<void> }) {
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
});
