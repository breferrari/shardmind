import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';

import VerboseView from '../../source/components/VerboseView.js';
import type {
  StatusReport,
  ShardManifest,
  ShardState,
} from '../../source/runtime/types.js';

afterEach(() => {
  cleanup();
});

const MANIFEST: ShardManifest = {
  apiVersion: 'v1',
  name: 'obsidian-mind',
  namespace: 'breferrari',
  version: '3.5.0',
  dependencies: [],
  hooks: {},
};

const STATE: ShardState = {
  schema_version: 1,
  shard: 'breferrari/obsidian-mind',
  source: 'github:breferrari/obsidian-mind',
  version: '3.5.0',
  tarball_sha256: 'deadbeef',
  installed_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
  values_hash: 'cafef00d',
  modules: { brain: 'included' },
  files: {},
};

function baseReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    manifest: MANIFEST,
    state: STATE,
    installedAgo: '3 weeks ago',
    updatedAgo: null,
    drift: {
      managed: 43,
      modified: 4,
      volatile: 0,
      missing: 0,
      orphaned: 127,
      modifiedPaths: ['CLAUDE.md', 'brain/North Star.md', 'Home.md', 'brain/Goals.md'],
      orphanedPaths: [],
      missingPaths: [],
      truncated: false,
    },
    update: { kind: 'up-to-date', current: '3.5.0' },
    modules: { included: ['brain', 'work', 'reference'], excluded: ['perf'] },
    values: {
      valid: true,
      total: 4,
      invalidKeys: [],
      invalidCount: 0,
      fileMissing: false,
    },
    frontmatter: {
      valid: 44,
      total: 47,
      issues: [
        { path: 'work/active/Auth Refactor.md', missing: ['quarter'], noteType: 'work-note' },
      ],
      issueCount: 1,
      truncated: false,
    },
    environment: { nodeVersion: 'v22.1.0', obsidianCliAvailable: true },
    warnings: [],
    ...overrides,
  };
}

describe('VerboseView', () => {
  it('renders all five verbose sections', () => {
    const { lastFrame } = render(<VerboseView report={baseReport()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Values:');
    expect(frame).toContain('Modules:');
    expect(frame).toContain('Files:');
    expect(frame).toContain('Frontmatter:');
    expect(frame).toContain('Environment:');
  });

  it('shows values count when valid', () => {
    const { lastFrame } = render(<VerboseView report={baseReport()} />);
    expect(lastFrame()).toContain('4/4 valid');
  });

  it('lists invalid value keys when values are invalid', () => {
    const { lastFrame } = render(
      <VerboseView
        report={baseReport({
          values: {
            valid: false,
            total: 4,
            invalidKeys: ['qmd_enabled', 'vault_purpose'],
            invalidCount: 2,
            fileMissing: false,
          },
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('qmd_enabled');
    expect(frame).toContain('vault_purpose');
  });

  it('renders the file-missing message when values.fileMissing=true', () => {
    const { lastFrame } = render(
      <VerboseView
        report={baseReport({
          values: {
            valid: false,
            total: 4,
            invalidKeys: [],
            invalidCount: 0,
            fileMissing: true,
          },
        })}
      />,
    );
    expect(lastFrame()).toContain('shard-values.yaml is missing or unreadable');
  });

  it('shows "…and N more" when the invalid-keys list is capped below the true count', () => {
    const shown = Array.from({ length: 20 }, (_, i) => `key_${i}`);
    const { lastFrame } = render(
      <VerboseView
        report={baseReport({
          values: {
            valid: false,
            total: 25,
            invalidKeys: shown,
            invalidCount: 25,
            fileMissing: false,
          },
        })}
      />,
    );
    expect(lastFrame()).toContain('…and 5 more');
  });

  it('lists included modules with the included suffix', () => {
    const { lastFrame } = render(<VerboseView report={baseReport()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('brain');
    expect(frame).toContain('included');
  });

  it('renders modified file list in the Files section', () => {
    const { lastFrame } = render(<VerboseView report={baseReport()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('CLAUDE.md');
    expect(frame).toContain('brain/North Star.md');
  });

  it('shows "…and N more" when the modified list is truncated', () => {
    const modifiedPaths = Array.from({ length: 20 }, (_, i) => `file-${i}.md`);
    const { lastFrame } = render(
      <VerboseView
        report={baseReport({
          drift: {
            ...baseReport().drift,
            modified: 30,
            modifiedPaths,
            truncated: true,
          },
        })}
      />,
    );
    expect(lastFrame()).toContain('…and 10 more');
  });

  it('renders per-file frontmatter missing keys in verbose output', () => {
    const { lastFrame } = render(<VerboseView report={baseReport()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('work/active/Auth Refactor.md');
    expect(frame).toContain('missing: quarter');
  });

  it('renders the environment Node.js version', () => {
    const { lastFrame } = render(<VerboseView report={baseReport()} />);
    expect(lastFrame()).toContain('Node.js v22.1.0');
  });

  it('renders Obsidian CLI present / absent differently', () => {
    const present = render(
      <VerboseView
        report={baseReport({
          environment: { nodeVersion: 'v22.0.0', obsidianCliAvailable: true },
        })}
      />,
    );
    expect(present.lastFrame()).toContain('Obsidian CLI on PATH');
    cleanup();

    const absent = render(
      <VerboseView
        report={baseReport({
          environment: { nodeVersion: 'v22.0.0', obsidianCliAvailable: false },
        })}
      />,
    );
    expect(absent.lastFrame()).toContain('Obsidian CLI not on PATH');
  });

  it('renders no environment section when not provided', () => {
    const { lastFrame } = render(
      <VerboseView report={baseReport({ environment: null })} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Environment:');
  });
});
