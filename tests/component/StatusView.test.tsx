import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';

import StatusView from '../../source/components/StatusView.js';
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
  description: 'The flagship shard',
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
  modules: { brain: 'included', extras: 'excluded' },
  files: {},
};

function baseReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    manifest: MANIFEST,
    state: STATE,
    installedAgo: '3 weeks ago',
    updatedAgo: null,
    drift: {
      managed: 47,
      modified: 0,
      volatile: 0,
      missing: 0,
      orphaned: 0,
      modifiedPaths: [],
      orphanedPaths: [],
      missingPaths: [],
      truncated: false,
    },
    update: { kind: 'up-to-date', current: '3.5.0' },
    modules: { included: ['brain'], excluded: ['extras'] },
    values: {
      valid: true,
      total: 4,
      invalidKeys: [],
      invalidCount: 0,
      fileMissing: false,
    },
    frontmatter: null,
    environment: null,
    warnings: [],
    ...overrides,
  };
}

describe('StatusView', () => {
  it('shows namespace/name and version in the header', () => {
    const { lastFrame } = render(<StatusView report={baseReport()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('breferrari/obsidian-mind');
    expect(frame).toContain('v3.5.0');
  });

  it('renders the installed line with file count', () => {
    const { lastFrame } = render(<StatusView report={baseReport()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Installed 3 weeks ago');
    expect(frame).toContain('47 managed files');
    expect(frame).toContain('0 modified');
  });

  it('shows an updated timestamp when updatedAgo is set', () => {
    const { lastFrame } = render(
      <StatusView report={baseReport({ updatedAgo: '5 days ago' })} />,
    );
    expect(lastFrame()).toContain('updated 5 days ago');
  });

  it('renders "Up to date" for the up-to-date update status', () => {
    const { lastFrame } = render(<StatusView report={baseReport()} />);
    expect(lastFrame()).toContain('Up to date');
  });

  it('renders the available line when an update exists', () => {
    const { lastFrame } = render(
      <StatusView
        report={baseReport({
          update: {
            kind: 'available',
            current: '3.5.0',
            latest: '4.0.0',
            cacheAge: 'fresh',
          },
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('v4.0.0 available');
    expect(frame).toContain('shardmind update');
  });

  it('labels the update line as cached when the answer came from a stale cache', () => {
    const { lastFrame } = render(
      <StatusView
        report={baseReport({
          update: {
            kind: 'available',
            current: '3.5.0',
            latest: '4.0.0',
            cacheAge: 'stale',
          },
        })}
      />,
    );
    expect(lastFrame()).toContain('(cached)');
  });

  it('renders an unknown update line when offline and no cache', () => {
    const { lastFrame } = render(
      <StatusView
        report={baseReport({
          update: { kind: 'unknown', current: '3.5.0', reason: 'no-network' },
        })}
      />,
    );
    expect(lastFrame()).toContain('offline');
  });

  it('lists warnings with their hints', () => {
    const { lastFrame } = render(
      <StatusView
        report={baseReport({
          warnings: [
            {
              severity: 'warning',
              message: '3 managed files modified by you.',
              hint: 'Your edits are preserved on update via three-way merge.',
            },
          ],
          drift: {
            ...baseReport().drift,
            modified: 3,
            modifiedPaths: ['a.md', 'b.md', 'c.md'],
          },
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('3 managed files modified by you');
    expect(frame).toContain('three-way merge');
  });
});
