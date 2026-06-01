import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import AdoptModePicker from '../../source/components/AdoptModePicker.js';
import { ENTER, ARROW_DOWN, tick, waitFor, waitForCall } from './helpers.js';

afterEach(() => {
  cleanup();
});

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(30);
  return r;
}

describe('AdoptModePicker', () => {
  it('shows the differ count and the four modes', async () => {
    const { lastFrame } = await mount(
      <AdoptModePicker differsCount={7} onSelect={vi.fn()} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Keep all mine'));
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/7 files differ/);
    expect(frame).toContain('Use all theirs');
    expect(frame).toMatch(/Auto-merge \(best-effort\)/);
    expect(frame).toContain('Decide per file');
  });

  it('singularizes the count for one file', async () => {
    const { lastFrame } = await mount(
      <AdoptModePicker differsCount={1} onSelect={vi.fn()} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Keep all mine'));
    expect(lastFrame() ?? '').toMatch(/1 file differ(?!s)/);
  });

  it('ENTER on the focused option selects keep-all-mine', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptModePicker differsCount={3} onSelect={onSelect} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Keep all mine'));
    stdin.write(ENTER);
    await waitForCall(onSelect);
    expect(onSelect).toHaveBeenCalledWith('keep-all-mine');
  });

  it('arrowing to the third option selects auto-merge', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptModePicker differsCount={3} onSelect={onSelect} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Auto-merge'));
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ENTER);
    await waitForCall(onSelect);
    expect(onSelect).toHaveBeenCalledWith('auto-merge');
  });

  it('double ENTER selects exactly once (firedRef guard)', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptModePicker differsCount={3} onSelect={onSelect} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Keep all mine'));
    stdin.write(ENTER);
    await waitForCall(onSelect);
    stdin.write(ENTER);
    await tick(60);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
