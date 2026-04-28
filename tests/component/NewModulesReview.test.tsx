import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import NewModulesReview from '../../source/components/NewModulesReview.js';
import type { ModuleDefinition } from '../../source/runtime/types.js';
import { ENTER, SPACE, tick, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

const EXTRAS: ModuleDefinition = {
  label: 'Extras',
  paths: ['extras/'],
  removable: true,
};

const WORK: ModuleDefinition = {
  label: 'Work',
  paths: ['work/'],
  removable: true,
};

describe('NewModulesReview', () => {
  it('renders offered modules with their labels', async () => {
    const { lastFrame } = render(
      <NewModulesReview
        offered={[
          { id: 'extras', def: EXTRAS },
          { id: 'work', def: WORK },
        ]}
        onSubmit={() => {}}
      />,
    );
    await tick(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('New modules offered');
    expect(frame).toContain('Extras');
    expect(frame).toContain('Work');
  });

  it('submits everything as included when the user presses Enter without changes', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <NewModulesReview
        offered={[
          { id: 'extras', def: EXTRAS },
          { id: 'work', def: WORK },
        ]}
        onSubmit={onSubmit}
      />,
    );
    await tick(40);
    stdin.write(ENTER);
    await waitFor(
      () => (onSubmit.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    expect(onSubmit).toHaveBeenCalledWith({ extras: 'included', work: 'included' });
  });

  it('toggles a module off with Space before submit', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <NewModulesReview
        offered={[
          { id: 'extras', def: EXTRAS },
          { id: 'work', def: WORK },
        ]}
        onSubmit={onSubmit}
      />,
    );
    await tick(40);
    stdin.write(SPACE);
    await tick(40);
    stdin.write(ENTER);
    await waitFor(
      () => (onSubmit.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ extras: 'excluded' });
  });

  it('renders ↓ N more below when offered modules overflow the viewport (#100)', async () => {
    const offered = Array.from({ length: 7 }, (_, i) => ({
      id: `mod${i}`,
      def: { label: `Module ${i}`, paths: [`mod${i}/`], removable: true } as ModuleDefinition,
    }));
    const { lastFrame } = render(
      <NewModulesReview offered={offered} onSubmit={() => {}} />,
    );
    await tick(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Module 0');
    expect(frame).toContain('Module 4');
    expect(frame).not.toContain('Module 6');
    expect(frame).toContain('↓ 2 more below');
  });

  it('renders a "no new modules" continuation when offered is empty', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <NewModulesReview offered={[]} onSubmit={onSubmit} />,
    );
    await tick(30);
    expect(lastFrame()).toContain('No new modules in this update.');
    stdin.write(ENTER);
    await waitFor(
      () => (onSubmit.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    expect(onSubmit).toHaveBeenCalledWith({});
  });
});
