/**
 * ui-kit TextInput (#43): upstream @inkjs/ui 2.0.0 behaviour, plus the
 * fixes named by issue. No ShardMind fixtures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { useState } from 'react';
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

  it('fires onChange only when the text changes, never on a parent re-render (vadimdemedes/ink-ui#26)', async () => {
    const onChange = vi.fn();
    const r = render(<TextInput onChange={(v) => onChange(v)} />);
    await tick();
    r.stdin.write('x');
    await tick();
    r.rerender(<TextInput onChange={(v) => onChange(v)} />);
    await tick();
    r.rerender(<TextInput onChange={(v) => onChange(v)} />);
    await tick();
    expect(onChange.mock.calls).toEqual([['x']]);
  });

  it('draws the text whole around the cursor, an astral character included', async () => {
    const { stdin, lastFrame } = render(<TextInput />);
    await tick();
    stdin.write('a😀b');
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write(LEFT);
    await tick();
    expect(lastFrame()).toContain('a😀b');
  });

  it('fires onChange once per keystroke, never again when submitting re-renders the parent (vadimdemedes/ink-ui#26)', async () => {
    // The shape of the upstream bug report: onSubmit sets the parent's
    // state, the parent re-renders with a new inline onChange, and
    // upstream fired onChange again with the unchanged value.
    const changes: string[] = [];
    const submits: string[] = [];
    function Harness() {
      const [, setSubmitCount] = useState(0);
      return (
        <TextInput
          onChange={(v) => changes.push(v)}
          onSubmit={(v) => {
            submits.push(v);
            setSubmitCount((c) => c + 1);
          }}
        />
      );
    }
    const { stdin } = render(<Harness />);
    await tick();
    for (const char of 'abc') {
      stdin.write(char);
      await tick();
    }
    stdin.write(ENTER);
    await tick(200);
    expect(submits).toEqual(['abc']);
    expect(changes).toEqual(['a', 'ab', 'abc']);
  });

  it('submits text typed in the same input chunk as Enter, as a paste delivers it (#317)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextInput onSubmit={onSubmit} />);
    await tick();
    stdin.write('REINSTALL' + ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('REINSTALL');
  });

  it('shows the placeholder while empty', () => {
    const { lastFrame } = render(<TextInput placeholder="REINSTALL" />);
    expect(lastFrame()).toContain('EINSTALL');
  });
});
