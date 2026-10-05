/**
 * ui-kit Select (#43): upstream @inkjs/ui 2.0.0 behaviour, plus the fixes
 * named by issue. No ShardMind fixtures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Select } from '../../source/ui-kit/index.js';

const ENTER = '\r';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const OPTIONS = [
  { label: 'Alpha', value: 'a' },
  { label: 'Beta', value: 'b' },
  { label: 'Gamma', value: 'c' },
];

afterEach(() => {
  cleanup();
});

describe('ui-kit Select', () => {
  it('renders the options with the pointer on the first', () => {
    const { lastFrame } = render(<Select options={OPTIONS} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/[❯>] Alpha/);
    expect(frame).toContain('Beta');
  });

  it('moves with the arrows and fires onChange with the focused value on Enter', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} onChange={onChange} />);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('selects the option focused by keys that arrive in the same burst as Enter', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} onChange={onChange} />);
    await tick();
    stdin.write(DOWN + DOWN + ENTER);
    await tick();
    expect(onChange.mock.calls).toEqual([['c']]);
  });

  it('shows only visibleOptionCount options and scrolls', async () => {
    const { stdin, lastFrame } = render(<Select options={OPTIONS} visibleOptionCount={2} />);
    await tick();
    expect(lastFrame()).not.toContain('Gamma');
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('Gamma');
    expect(lastFrame()).not.toContain('Alpha');
  });

  it('fires onChange on Enter on the seeded default (ShardMind #103)', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} defaultValue="a" onChange={onChange} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('starts focused on the default, scrolled into view', async () => {
    const onChange = vi.fn();
    const { stdin, lastFrame } = render(
      <Select options={OPTIONS} defaultValue="c" visibleOptionCount={2} onChange={onChange} />,
    );
    await tick();
    expect(lastFrame()).toMatch(/[❯>] Gamma/);
    expect(lastFrame()).not.toContain('Alpha');
    stdin.write(ENTER);
    await tick();
    expect(onChange.mock.calls).toEqual([['c']]);
  });

  it('starts on the first option when the default is not an option', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} defaultValue="zz" onChange={onChange} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onChange.mock.calls).toEqual([['a']]);
  });

  it('fires onChange once per Enter, never again on a parent re-render (vadimdemedes/ink-ui#26)', async () => {
    const onChange = vi.fn();
    const r = render(<Select options={OPTIONS} onChange={(v) => onChange(v)} />);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    // The parent re-renders with a new callback and new option objects.
    r.rerender(<Select options={OPTIONS.map((o) => ({ ...o }))} onChange={(v) => onChange(v)} />);
    await tick();
    r.rerender(<Select options={OPTIONS.map((o) => ({ ...o }))} onChange={(v) => onChange(v)} />);
    await tick();
    expect(onChange.mock.calls).toEqual([['b']]);
  });

  it('selects on an Enter that arrives inside a run of plain keys (#317)', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} onChange={onChange} />);
    await tick();
    stdin.write('x' + ENTER);
    await tick();
    expect(onChange.mock.calls).toEqual([['a']]);
  });

  it('ignores keys while disabled', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} isDisabled onChange={onChange} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
  });
});
