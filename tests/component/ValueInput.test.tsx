import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import ValueInput from '../../source/components/ValueInput.js';
import type { ValueDefinition } from '../../source/runtime/types.js';
import { ENTER, ARROW_DOWN, tick, typeText, waitFor, waitForCall } from './helpers.js';

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

    await typeText(stdin, 'Alice');
    await waitFor(lastFrame, (f) => f.includes('Alice'));
    stdin.write(ENTER);
    await waitForCall(onSubmit);

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

  it('select: arrow + Enter picks an option and calls onSubmit', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Purpose?',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'research', label: 'Research' },
        { value: 'general', label: 'General' },
      ],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ValueInput id="vault_purpose" def={def} initialValue="" onSubmit={onSubmit} />,
    );

    // All three options should render
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Engineering');
    expect(frame).toContain('Research');
    expect(frame).toContain('General');

    // Move down to 'research' and select
    stdin.write(ARROW_DOWN);
    await tick(30);
    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('research');
  });

  // #103 select-Enter regression + adversarial matrix.
  // Upstream-bug context lives next to the fix in source/components/ValueInput.tsx.

  it('select: default = first option + single Enter fires (#103 regression)', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Purpose?',
      default: 'engineering',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'independent', label: 'Independent' },
        { value: 'freelance', label: 'Freelance' },
      ],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="vault_purpose" def={def} initialValue="engineering" onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('engineering');
  });

  it('select: default = middle option + single Enter fires the default', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Purpose?',
      default: 'research',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'research', label: 'Research' },
        { value: 'general', label: 'General' },
      ],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="vault_purpose" def={def} initialValue="research" onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('research');
  });

  it('select: single-option default-matches Enter fires (#103 degenerate edge)', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Mode?',
      default: 'only',
      options: [{ value: 'only', label: 'Only Choice' }],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="mode" def={def} initialValue="only" onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('only');
  });

  it('select: no default + no initialValue, Enter fires the first option', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Purpose?',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'research', label: 'Research' },
        { value: 'general', label: 'General' },
      ],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="vault_purpose" def={def} initialValue={undefined} onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('engineering');
  });

  it('select: back-nav initialValue ≠ default, Enter fires initialValue', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Purpose?',
      default: 'engineering',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'research', label: 'Research' },
        { value: 'general', label: 'General' },
      ],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="vault_purpose" def={def} initialValue="general" onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('general');
  });

  it('select: initialValue not in options falls back to first option (no freeze)', async () => {
    const def: ValueDefinition = {
      type: 'select',
      required: true,
      message: 'Purpose?',
      default: 'engineering',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'research', label: 'Research' },
        { value: 'general', label: 'General' },
      ],
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="vault_purpose" def={def} initialValue="renamed-old-value" onSubmit={onSubmit} />,
    );

    stdin.write(ENTER);
    await waitForCall(onSubmit);

    expect(onSubmit).toHaveBeenCalledWith('engineering');
  });

  it('boolean: y confirms → onSubmit(true)', async () => {
    const def: ValueDefinition = {
      type: 'boolean',
      message: 'Enable QMD?',
      default: false,
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="qmd_enabled" def={def} initialValue={false} onSubmit={onSubmit} />,
    );

    stdin.write('y');
    await waitForCall(onSubmit);
    expect(onSubmit).toHaveBeenCalledWith(true);
  });

  it('boolean: n cancels → onSubmit(false)', async () => {
    const def: ValueDefinition = {
      type: 'boolean',
      message: 'Enable QMD?',
      default: true,
      group: 'setup',
    };
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ValueInput id="qmd_enabled" def={def} initialValue={true} onSubmit={onSubmit} />,
    );

    stdin.write('n');
    await waitForCall(onSubmit);
    expect(onSubmit).toHaveBeenCalledWith(false);
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
