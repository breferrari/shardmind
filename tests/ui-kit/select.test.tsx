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

  it('ignores keys while disabled', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<Select options={OPTIONS} isDisabled onChange={onChange} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
  });
});
