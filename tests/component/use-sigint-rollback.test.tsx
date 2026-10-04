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
import { useSigintRollback } from '../../source/commands/hooks/shared.js';

function Probe(props: { rollback: () => Promise<void>; cleanup: () => Promise<void> }) {
  useSigintRollback({ isActive: () => true, rollback: props.rollback, cleanup: props.cleanup });
  return <Text>probe</Text>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
});
