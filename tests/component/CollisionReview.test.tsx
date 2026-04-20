import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import CollisionReview from '../../source/components/CollisionReview.js';
import type { Collision } from '../../source/core/install-planner.js';
import { ENTER, ARROW_DOWN, tick, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

function collision(outputPath: string, kind: 'file' | 'directory' = 'file'): Collision {
  return {
    absolutePath: `/vault/${outputPath}`,
    outputPath,
    kind,
    size: 1024,
    mtime: new Date('2026-04-01T12:00:00Z'),
  };
}

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(30);
  return r;
}

describe('CollisionReview', () => {
  it('renders file count and choices', async () => {
    const { lastFrame } = await mount(
      <CollisionReview
        collisions={[collision('Home.md'), collision('Index.md')]}
        onChoice={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 existing paths will be affected');
    expect(frame).toContain('Home.md');
    expect(frame).toContain('Index.md');
    expect(frame).toContain('Back up');
    expect(frame).toContain('Overwrite');
    expect(frame).toContain('Cancel');
  });

  it('warns about directory deletion when a collision is a directory', async () => {
    const { lastFrame } = await mount(
      <CollisionReview
        collisions={[collision('Home.md'), collision('brain/', 'directory')]}
        onChoice={() => {}}
      />,
    );

    expect(lastFrame()).toContain('files AND directories will be deleted');
  });

  it('truncates collision list above 15 entries', async () => {
    const many = Array.from({ length: 20 }, (_, i) => collision(`File${i}.md`));
    const { lastFrame } = await mount(
      <CollisionReview collisions={many} onChoice={() => {}} />,
    );

    expect(lastFrame()).toContain('…and 5 more');
  });

  it('backup choice fires onChoice("backup")', async () => {
    const onChoice = vi.fn();
    const { stdin, lastFrame } = await mount(
      <CollisionReview
        collisions={[collision('Home.md')]}
        onChoice={onChoice}
      />,
    );

    // `mount`'s 30 ms stabilization tick is sometimes too short for Ink's
    // Select to bind its `useInput` handler on Windows CI. The sibling
    // cancel test gets enough grace from its two ARROW_DOWN writes;
    // this test writes ENTER immediately, so we wait for the Back-up
    // option to render before injecting input. `waitFor` adds its own
    // post-predicate tick, which covers the remaining useInput latency.
    await waitFor(lastFrame, (f) => f.includes('Back up'));
    stdin.write(ENTER);
    await waitFor(() => (onChoice.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    expect(onChoice).toHaveBeenCalledWith('backup');
  });

  it('cancel choice fires onChoice("cancel")', async () => {
    const onChoice = vi.fn();
    const { stdin, lastFrame } = await mount(
      <CollisionReview
        collisions={[collision('Home.md')]}
        onChoice={onChoice}
      />,
    );

    // Same Windows useInput-registration race as the backup test — wait
    // for the Select to render before driving it.
    await waitFor(lastFrame, (f) => f.includes('Back up'));
    // Move down twice: backup → overwrite → cancel
    stdin.write(ARROW_DOWN);
    await tick(30);
    stdin.write(ARROW_DOWN);
    await tick(30);
    stdin.write(ENTER);
    await waitFor(() => (onChoice.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    expect(onChoice).toHaveBeenCalledWith('cancel');
  });
});
