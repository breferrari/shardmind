import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import fc from 'fast-check';
import React from 'react';
import ScrollableMultiSelect, {
  clampScrollOffset,
} from '../../source/components/ScrollableMultiSelect.js';
import { ENTER, SPACE, ARROW_DOWN, ARROW_UP, tick, waitFor, waitForCall } from './helpers.js';

afterEach(() => {
  cleanup();
});

const opts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `opt-${i}`, value: `v${i}` }));

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(30);
  return r;
}

describe('ScrollableMultiSelect — render', () => {
  it('0 options: renders no items, no scroll hints; Enter still submits', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={[]} onSubmit={onSubmit} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/more above|more below/);
    expect(frame).not.toContain('opt-');
    stdin.write(ENTER);
    await waitForCall(onSubmit);
    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it('1 option: renders the single option, no scroll hints', async () => {
    const { lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(1)} visibleOptionCount={5} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('opt-0');
    expect(frame).not.toMatch(/more above|more below/);
  });

  it('total === visible: no scroll hints', async () => {
    const { lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(5)} visibleOptionCount={5} />,
    );
    const frame = lastFrame() ?? '';
    for (let i = 0; i < 5; i++) expect(frame).toContain(`opt-${i}`);
    expect(frame).not.toMatch(/more above|more below/);
  });

  it('overflow at top: only ↓ N more below visible', async () => {
    const { lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(7)} visibleOptionCount={5} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↓ 2 more below');
    expect(frame).not.toContain('more above');
    expect(frame).toContain('opt-0');
    expect(frame).toContain('opt-4');
    expect(frame).not.toContain('opt-5');
    expect(frame).not.toContain('opt-6');
  });

  it('arrow-down past viewport: scrolls window, both hints render mid-list', async () => {
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(10)} visibleOptionCount={5} />,
    );
    // 5 down-arrows brings focused from 0 → 5; viewport scrolls to [1, 6).
    for (let i = 0; i < 5; i++) {
      stdin.write(ARROW_DOWN);
      await tick(20);
    }
    await waitFor(lastFrame, (f) => f.includes('↑ 1 more above') && f.includes('↓ 4 more below'));
  });

  it('arrow-down to bottom: only ↑ N more above visible', async () => {
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(7)} visibleOptionCount={5} />,
    );
    // 6 down-arrows: focused 0 → 6 (last). Viewport scrolls to [2, 7).
    for (let i = 0; i < 6; i++) {
      stdin.write(ARROW_DOWN);
      await tick(20);
    }
    await waitFor(
      lastFrame,
      (f) => f.includes('↑ 2 more above') && !f.includes('more below'),
    );
  });

  it('arrow-down clamps at last option (no overflow past end)', async () => {
    const onChange = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(3)} visibleOptionCount={5} onChange={onChange} />,
    );
    // 10 down-arrows on a 3-option list — should clamp to focused = 2.
    for (let i = 0; i < 10; i++) {
      stdin.write(ARROW_DOWN);
      await tick(15);
    }
    // Toggle to verify focused is on the last option (opt-2).
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◆ opt-2'));
    expect(onChange).toHaveBeenLastCalledWith(['v2']);
  });

  it('arrow-up clamps at first option (no underflow past 0)', async () => {
    const onChange = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(3)} visibleOptionCount={5} onChange={onChange} />,
    );
    // Many up-arrows from focused=0 should be a no-op.
    for (let i = 0; i < 10; i++) {
      stdin.write(ARROW_UP);
      await tick(15);
    }
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◆ opt-0'));
    expect(onChange).toHaveBeenLastCalledWith(['v0']);
  });
});

describe('ScrollableMultiSelect — selection', () => {
  it('space toggles focused option; onChange fires with new selection', async () => {
    const onChange = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(3)} onChange={onChange} />,
    );
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◆ opt-0'));
    expect(onChange).toHaveBeenLastCalledWith(['v0']);
    stdin.write(ARROW_DOWN);
    await tick(20);
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◆ opt-1'));
    expect(onChange).toHaveBeenLastCalledWith(['v0', 'v1']);
  });

  it('toggling already-selected option de-selects it', async () => {
    const onChange = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect
        options={opts(3)}
        defaultValue={['v0', 'v1']}
        onChange={onChange}
      />,
    );
    expect(lastFrame() ?? '').toContain('◆ opt-0');
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◇ opt-0'));
    expect(onChange).toHaveBeenLastCalledWith(['v1']);
  });

  it('Enter fires onSubmit with current selection (insertion order)', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(3)} onSubmit={onSubmit} />,
    );
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◆ opt-0'));
    stdin.write(ARROW_DOWN);
    await tick(20);
    stdin.write(SPACE);
    await waitFor(lastFrame, (f) => f.includes('◆ opt-1'));
    stdin.write(ENTER);
    await waitForCall(onSubmit);
    expect(onSubmit).toHaveBeenCalledWith(['v0', 'v1']);
  });

  it('defaultValue honored on initial render', async () => {
    const { lastFrame } = await mount(
      <ScrollableMultiSelect options={opts(3)} defaultValue={['v0', 'v2']} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ opt-0');
    expect(frame).toContain('◇ opt-1');
    expect(frame).toContain('◆ opt-2');
  });

  it('isDisabled: blocks all input (no state change, no callbacks)', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ScrollableMultiSelect
        options={opts(3)}
        onChange={onChange}
        onSubmit={onSubmit}
        isDisabled
      />,
    );
    const frame = lastFrame() ?? '';
    // No focus marker on any option when disabled.
    expect(frame).not.toContain('❯ ');
    stdin.write(SPACE);
    stdin.write(ARROW_DOWN);
    stdin.write(ENTER);
    await tick(50);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ScrollableMultiSelect — clampScrollOffset (property tests)', () => {
  it('result is in [0, max(0, total - visible)]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 50 }),
        fc.integer({ min: -10, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        (offsetIn, focusedIn, total, visible) => {
          const result = clampScrollOffset(offsetIn, focusedIn, total, visible);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(Math.max(0, total - visible));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('when focusedIndex is in range, focused stays inside [result, result + visible)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 50 }),
        (offsetIn, total, visible, focusedSeed) => {
          const focused = total === 0 ? 0 : focusedSeed % total;
          const result = clampScrollOffset(offsetIn, focused, total, visible);
          if (total === 0) {
            expect(result).toBe(0);
            return;
          }
          // focused is always inside the visible window.
          expect(result).toBeLessThanOrEqual(focused);
          expect(focused).toBeLessThan(result + Math.min(visible, total));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('aboveCount + visibleCount + belowCount === total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 50 }),
        (total, visible, focusedSeed) => {
          const focused = total === 0 ? 0 : focusedSeed % total;
          const offset = clampScrollOffset(0, focused, total, visible);
          const visibleEnd = Math.min(total, offset + visible);
          const aboveCount = offset;
          const visibleCount = Math.max(0, visibleEnd - offset);
          const belowCount = Math.max(0, total - visibleEnd);
          expect(aboveCount + visibleCount + belowCount).toBe(total);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('total <= visible: result is always 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 50 }),
        (offsetIn, total, focusedIn, visible) => {
          fc.pre(total <= visible);
          expect(clampScrollOffset(offsetIn, focusedIn, total, visible)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
