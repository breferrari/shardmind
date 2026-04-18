import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import Header from '../../source/components/Header.js';
import type { ShardManifest } from '../../source/runtime/types.js';

afterEach(() => {
  cleanup();
});

const base: ShardManifest = {
  apiVersion: 'v1',
  name: 'mini',
  namespace: 'breferrari',
  version: '0.1.0',
  dependencies: [],
  hooks: {},
};

describe('Header', () => {
  it('renders namespace/name and version badge', () => {
    const { lastFrame } = render(<Header manifest={base} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('breferrari/mini');
    expect(frame).toContain('v0.1.0');
  });

  it('renders description when present', () => {
    const { lastFrame } = render(
      <Header manifest={{ ...base, description: 'A minimal test shard' }} />,
    );
    expect(lastFrame()).toContain('A minimal test shard');
  });

  it('renders persona with "for" prefix when present', () => {
    const { lastFrame } = render(
      <Header manifest={{ ...base, persona: 'solo engineers' }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('for');
    expect(frame).toContain('solo engineers');
  });

  it('omits description and persona sections when absent', () => {
    const { lastFrame } = render(<Header manifest={base} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('for ');
    // 'breferrari/mini' + version badge is the only line of content
    expect(frame.split('\n').filter((l) => l.trim().length > 0).length).toBeLessThan(3);
  });
});
