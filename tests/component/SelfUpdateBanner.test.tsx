import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import SelfUpdateBanner from '../../source/components/SelfUpdateBanner.js';

afterEach(() => {
  cleanup();
});

describe('SelfUpdateBanner', () => {
  it('renders the banner when info is provided', () => {
    const { lastFrame } = render(
      <SelfUpdateBanner info={{ current: '0.1.0', latest: '0.1.2' }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('shardmind');
    expect(frame).toContain('0.1.2');
    expect(frame).toContain('0.1.0');
    // The actionable hint with the canonical install command.
    expect(frame).toContain('npm install -g shardmind@latest');
  });

  it('renders nothing when info is null', () => {
    const { lastFrame } = render(<SelfUpdateBanner info={null} />);
    const frame = lastFrame() ?? '';
    // Ink may render the empty container as a literal newline; the
    // contract is "no banner content" — check for the load-bearing
    // strings the rendered banner would contain.
    expect(frame).not.toContain('shardmind');
    expect(frame).not.toContain('available');
    expect(frame).not.toContain('npm install');
  });

  it('keeps the version values distinguishable when current and latest differ only by patch', () => {
    const { lastFrame } = render(
      <SelfUpdateBanner info={{ current: '0.1.1', latest: '0.1.2' }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('0.1.1');
    expect(frame).toContain('0.1.2');
    // Order: latest is the bold lead, current is the parenthetical.
    expect(frame.indexOf('0.1.2')).toBeLessThan(frame.indexOf('0.1.1'));
  });
});
