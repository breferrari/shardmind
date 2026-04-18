import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import Summary from '../../source/components/Summary.js';
import type { ShardManifest } from '../../source/runtime/types.js';
import type { BackupRecord } from '../../source/core/install-executor.js';

afterEach(() => {
  cleanup();
});

const manifest: ShardManifest = {
  apiVersion: 'v1',
  name: 'mini',
  namespace: 'breferrari',
  version: '0.1.0',
  dependencies: [],
  hooks: {},
};

const baseProps = {
  manifest,
  vaultRoot: '/home/alice/vault',
  fileCount: 23,
  durationMs: 1234,
  backups: [] as BackupRecord[],
  hookOutput: null,
};

describe('Summary', () => {
  it('renders install success line with shard ref and file count', () => {
    const { lastFrame } = render(<Summary {...baseProps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Installed');
    expect(frame).toContain('breferrari/mini@0.1.0');
    expect(frame).toContain('23 files');
    expect(frame).toContain('1.2s');
  });

  it('renders dry-run line when dryRun=true', () => {
    const { lastFrame } = render(<Summary {...baseProps} dryRun />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Dry run complete');
    expect(frame).toContain('23 files would be written');
    expect(frame).not.toContain('Next:');
  });

  it('renders backup list when backups present, truncates above 10', () => {
    const backups: BackupRecord[] = Array.from({ length: 13 }, (_, i) => ({
      originalPath: `/vault/File${i}.md`,
      backupPath: `/vault/File${i}.md.shardmind-backup-xyz`,
    }));
    const { lastFrame } = render(<Summary {...baseProps} backups={backups} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Backed up 13 existing files');
    expect(frame).toContain('File0.md.shardmind-backup-xyz');
    expect(frame).toContain('…and 3 more');
  });

  it('surfaces deferred hook warning', () => {
    const { lastFrame } = render(
      <Summary {...baseProps} hookOutput={{ deferred: true }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-install hook detected but not executed');
    expect(frame).toContain('#30');
  });

  it('includes platform-specific open command on success', () => {
    const { lastFrame } = render(<Summary {...baseProps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next:');
    // One of the three known openers must appear
    expect(
      frame.includes('open "') ||
        frame.includes('start ""') ||
        frame.includes('xdg-open "'),
    ).toBe(true);
    expect(frame).toContain('/home/alice/vault');
  });
});
