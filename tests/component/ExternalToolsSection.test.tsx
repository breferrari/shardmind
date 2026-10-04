import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import ExternalToolsSection from '../../source/components/ExternalToolsSection.js';

describe('ExternalToolsSection (#138)', () => {
  it('renders nothing when there is nothing to say', () => {
    const { lastFrame } = render(<ExternalToolsSection lines={[]} />);
    expect(lastFrame()).toBe('');
  });

  it('lists each unmet optional tool with its install hint', () => {
    const { lastFrame } = render(
      <ExternalToolsSection lines={['qmd: not found on PATH. Install: npm i -g @tobilu/qmd@">=2.5.0"']} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('External tools:');
    expect(frame).toContain('qmd: not found on PATH');
    expect(frame).toContain('npm i -g @tobilu/qmd@">=2.5.0"');
  });

  it('shows the dry-run note', () => {
    const { lastFrame } = render(<ExternalToolsSection lines={['external tools not checked (dry run)']} />);
    expect(lastFrame()).toContain('external tools not checked (dry run)');
  });
});
