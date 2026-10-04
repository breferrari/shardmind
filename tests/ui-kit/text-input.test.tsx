/**
 * ui-kit TextInput (#43): upstream @inkjs/ui 2.0.0 behaviour, plus the
 * fixes named by issue. No ShardMind fixtures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { TextInput } from '../../source/ui-kit/index.js';

const ENTER = '\r';
const BACKSPACE = '\x7f';
const LEFT = '\x1b[D';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  cleanup();
});

describe('ui-kit TextInput', () => {
  it('types, deletes and submits the value', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<TextInput onChange={onChange} onSubmit={onSubmit} />);
    await tick();
    stdin.write('ab');
    await tick();
    stdin.write('c');
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    expect(lastFrame()).toContain('ab');
    expect(onChange).toHaveBeenLastCalledWith('ab');
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('ab');
  });

  it('inserts at the cursor after moving left', async () => {
    const onChange = vi.fn();
    const { stdin } = render(<TextInput onChange={onChange} />);
    await tick();
    stdin.write('ac');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('b');
    await tick();
    expect(onChange).toHaveBeenLastCalledWith('abc');
  });

  it('shows the placeholder while empty', () => {
    const { lastFrame } = render(<TextInput placeholder="REINSTALL" />);
    expect(lastFrame()).toContain('EINSTALL');
  });
});
