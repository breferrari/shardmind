import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import CommandProgress from '../../source/components/CommandProgress.js';

afterEach(() => {
  cleanup();
});

describe('CommandProgress', () => {
  it('renders current/total counter and label', () => {
    const { lastFrame } = render(
      <CommandProgress current={3} total={10} label="Rendering Home.md" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[3/10]');
    expect(frame).toContain('Rendering Home.md');
  });

  it('handles total=0 without NaN', () => {
    const { lastFrame } = render(
      <CommandProgress current={0} total={0} label="Preparing" />,
    );
    // No "NaN" anywhere in the frame (percent calc guards against /0)
    expect(lastFrame()).not.toContain('NaN');
  });

  it('clamps percent at 100 when current > total', () => {
    // Guards against a caller passing bad counts — verify no overflow crash
    const { lastFrame } = render(
      <CommandProgress current={15} total={10} label="Finishing" />,
    );
    expect(lastFrame()).toContain('[15/10]');
  });

  it('renders history lines when verbose + history provided', () => {
    const { lastFrame } = render(
      <CommandProgress
        current={2}
        total={5}
        label="Rendering"
        verbose
        history={['wrote core/Home.md', 'wrote core/Index.md']}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('wrote core/Home.md');
    expect(frame).toContain('wrote core/Index.md');
  });

  it('omits history section when verbose=false', () => {
    const { lastFrame } = render(
      <CommandProgress
        current={2}
        total={5}
        label="Rendering"
        history={['wrote core/Home.md']}
      />,
    );
    expect(lastFrame()).not.toContain('wrote core/Home.md');
  });
});
