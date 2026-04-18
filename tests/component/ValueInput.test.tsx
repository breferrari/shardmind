import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import ValueInput from '../../source/components/ValueInput.js';
import type { ValueDefinition } from '../../source/runtime/types.js';
import { ENTER, tick, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

async function mount(node: React.ReactElement) {
  const r = render(node);
  // Give Ink time to mount useInput handlers before we write.
  await tick(30);
  return r;
}

describe('ValueInput', () => {
  it('string: required + empty submit shows validation error', async () => {
    const def: ValueDefinition = {
      type: 'string',
      required: true,
      message: 'Your name?',
      group: 'identity',
    };
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ValueInput id="user_name" def={def} initialValue="" onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Required'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('string: typed value submits correctly', async () => {
    const def: ValueDefinition = {
      type: 'string',
      message: 'Your name?',
      group: 'identity',
    };
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ValueInput id="user_name" def={def} initialValue="" onSubmit={onSubmit} />,
    );

    stdin.write('Alice');
    await waitFor(lastFrame, (f) => f.includes('Alice'));
    stdin.write(ENTER);
    await waitFor(() => (onSubmit.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    expect(onSubmit).toHaveBeenCalledWith('Alice');
  });

  it('number: non-numeric input shows validation error', async () => {
    const def: ValueDefinition = {
      type: 'number',
      message: 'Age?',
      group: 'identity',
    };
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ValueInput id="age" def={def} initialValue="" onSubmit={onSubmit} />,
    );

    stdin.write('abc');
    await waitFor(lastFrame, (f) => f.includes('abc'));
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Must be a number'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('number: out-of-range value shows min error', async () => {
    const def: ValueDefinition = {
      type: 'number',
      message: 'Age?',
      min: 18,
      max: 99,
      group: 'identity',
    };
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ValueInput id="age" def={def} initialValue="" onSubmit={onSubmit} />,
    );

    stdin.write('5');
    await waitFor(lastFrame, (f) => f.includes('5'));
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => /Must be ≥ 18/.test(f));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders message, hint, and required marker', async () => {
    const def: ValueDefinition = {
      type: 'string',
      required: true,
      message: 'Your name?',
      hint: 'Shown in CLAUDE.md',
      group: 'identity',
    };
    const { lastFrame } = await mount(
      <ValueInput id="user_name" def={def} initialValue="" onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Your name?');
    expect(frame).toContain('*');
    expect(frame).toContain('Shown in CLAUDE.md');
  });
});
