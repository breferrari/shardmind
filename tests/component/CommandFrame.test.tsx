import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
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

  /**
   * The frame with each stream's isTTY set as given, then re-rendered, since
   * ink-testing-library's stdout has no isTTY and its stdin has `true`.
   */
  function renderOn(terminal: { stdout: boolean; stdin: boolean }, showLegend?: boolean): string {
    // A new element each time: React skips re-rendering an identical one.
    const frame = () => (
      <CommandFrame dryRun={false} showLegend={showLegend}>
        <Text>hi</Text>
      </CommandFrame>
    );
    const { stdout, stdin, rerender, lastFrame } = render(frame());
    Object.assign(stdout, { isTTY: terminal.stdout });
    Object.assign(stdin, { isTTY: terminal.stdin });
    rerender(frame());
    return lastFrame() ?? '';
  }

  it('renders the keyboard legend on a terminal', () => {
    const frame = renderOn({ stdout: true, stdin: true });
    expect(frame).toContain('navigate');
    expect(frame).toContain('Enter');
    expect(frame).toContain('Ctrl+C');
  });

  it('hides the legend when showLegend=false (summary/error screens)', () => {
    expect(renderOn({ stdout: true, stdin: true }, false)).not.toContain('navigate');
  });

  // #381: with nothing to navigate, the legend only pollutes captured output.
  it.each([
    ['stdout is piped (update --yes > log)', { stdout: false, stdin: true }],
    ['stdin is piped', { stdout: true, stdin: false }],
    ['both are piped (CI)', { stdout: false, stdin: false }],
  ])('hides the legend when %s (#381)', (_case, terminal) => {
    const frame = renderOn(terminal);
    expect(frame).not.toContain('navigate');
    expect(frame).toContain('hi');
  });
});
