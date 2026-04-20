import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import CommandFrame from '../../source/components/CommandFrame.js';

afterEach(() => {
  cleanup();
});

describe('CommandFrame', () => {
  it('renders children inside the frame', () => {
    const { lastFrame } = render(
      <CommandFrame dryRun={false}>
        <Text>inner content</Text>
      </CommandFrame>,
    );
    expect(lastFrame()).toContain('inner content');
  });

  it('shows the DRY RUN banner when dryRun is true', () => {
    const { lastFrame } = render(
      <CommandFrame dryRun={true}>
        <Text>whatever</Text>
      </CommandFrame>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('DRY RUN');
    expect(frame).toContain('no files will be written');
  });

  it('omits the banner when dryRun is false', () => {
    const { lastFrame } = render(
      <CommandFrame dryRun={false}>
        <Text>whatever</Text>
      </CommandFrame>,
    );
    expect(lastFrame()).not.toContain('DRY RUN');
  });

  it('renders the keyboard legend by default', () => {
    const { lastFrame } = render(
      <CommandFrame dryRun={false}>
        <Text>hi</Text>
      </CommandFrame>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('navigate');
    expect(frame).toContain('Enter');
    expect(frame).toContain('Ctrl+C');
  });

  it('hides the legend when showLegend=false (summary/error screens)', () => {
    const { lastFrame } = render(
      <CommandFrame dryRun={false} showLegend={false}>
        <Text>hi</Text>
      </CommandFrame>,
    );
    expect(lastFrame()).not.toContain('navigate');
  });
});
