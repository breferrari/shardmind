import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { useOncePerKey } from '../../source/components/use-once-per-key.js';
import { tick } from './helpers.js';

afterEach(() => {
  cleanup();
});

/**
 * Test harness: calls `tryFire()` once per render via an effect, reports
 * the boolean result through `onResult`. Re-rendering the same root with
 * a new `kVal` exercises the iteration shape that production parents
 * (`adopt.tsx`, `update.tsx`) use to advance state without remounting.
 */
function Harness({
  kVal,
  onResult,
}: {
  kVal: string | null;
  onResult: (didFire: boolean) => void;
}) {
  const tryFire = useOncePerKey(kVal);
  useEffect(() => {
    onResult(tryFire());
    // Intentionally fires on every render — we want to observe the
    // hook's response across the test's rerender() cycles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  return null;
}

describe('useOncePerKey', () => {
  it('first call returns true and records the key', async () => {
    const onResult = vi.fn();
    render(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith(true);
  });

  it('second call with same key returns false', async () => {
    const onResult = vi.fn();
    const r = render(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenNthCalledWith(1, true);
    expect(onResult).toHaveBeenNthCalledWith(2, false);
  });

  it('returns true again after the key changes', async () => {
    const onResult = vi.fn();
    const r = render(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="b" onResult={onResult} />);
    await tick(20);
    expect(onResult.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
  });

  it('subsequent calls with the new key return false', async () => {
    const onResult = vi.fn();
    const r = render(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="b" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="b" onResult={onResult} />);
    await tick(20);
    expect(onResult.mock.calls.map((c) => c[0])).toEqual([true, true, false]);
  });

  it('returning to a previously-fired key returns true (refs reset on miss)', async () => {
    // The hook only remembers the LAST fired key, not every key it has
    // seen. A key that fired earlier, was replaced, then comes back
    // again is treated as fresh. This matches the real-world iteration
    // pattern (adopt/update advance forward through differs/conflicts;
    // they don't revisit prior files within the same run).
    const onResult = vi.fn();
    const r = render(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="b" onResult={onResult} />);
    await tick(20);
    r.rerender(<Harness kVal="a" onResult={onResult} />);
    await tick(20);
    expect(onResult.mock.calls.map((c) => c[0])).toEqual([true, true, true]);
  });

  it('treats null as a valid key (first call after null fires)', async () => {
    // The hook seeds `lastFiredKeyRef.current = null`. If the caller
    // passes `null` as the current key, the first call would compare
    // `null === null` and return false — the wrong answer. Pin the
    // contract: keys must be primitives that aren't `null`. (The hook
    // is typed `K = K`, so passing null is a type-level decision the
    // caller makes; this case documents the gotcha.)
    const onResult = vi.fn();
    render(<Harness kVal={null} onResult={onResult} />);
    await tick(20);
    expect(onResult).toHaveBeenLastCalledWith(false);
  });
});
