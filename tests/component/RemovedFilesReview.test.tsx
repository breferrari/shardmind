import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import RemovedFilesReview from '../../source/components/RemovedFilesReview.js';
import { ARROW_DOWN, ENTER, tick, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

describe('RemovedFilesReview', () => {
  it('shows the current file path and position counter', async () => {
    const { lastFrame } = render(
      <RemovedFilesReview
        paths={['brain/Alpha.md', 'brain/Beta.md']}
        onSubmit={() => {}}
      />,
    );
    await tick(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('brain/Alpha.md');
    expect(frame).toContain('(1 of 2)');
    expect(frame).toContain('Keep my edits (untrack)');
    expect(frame).toContain('Delete');
  });

  it('cycles through files and emits the complete decision map on submit', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <RemovedFilesReview
        paths={['a.md', 'b.md', 'c.md']}
        onSubmit={onSubmit}
      />,
    );
    await tick(30);

    // File 1: keep (first option)
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('b.md'));

    // File 2: delete (arrow down then enter)
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('c.md'));

    // File 3: keep
    stdin.write(ENTER);
    await waitFor(
      () => (onSubmit.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      'a.md': 'keep',
      'b.md': 'delete',
      'c.md': 'keep',
    });
  });

  it('renders nothing when given an empty list', async () => {
    const onSubmit = vi.fn();
    const { lastFrame } = render(
      <RemovedFilesReview paths={[]} onSubmit={onSubmit} />,
    );
    await tick(30);
    expect(lastFrame()?.trim() ?? '').toBe('');
  });
});
