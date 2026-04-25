import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import AdoptSummary from '../../source/components/AdoptSummary.js';
import type { ShardManifest } from '../../source/runtime/types.js';
import type { AdoptSummary as AdoptSummaryData } from '../../source/core/adopt-executor.js';

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

function makeSummary(overrides: Partial<AdoptSummaryData> = {}): AdoptSummaryData {
  return {
    matchedAuto: ['CLAUDE.md', 'README.md'],
    adoptedMine: [],
    adoptedShard: [],
    installedFresh: [],
    totalManaged: 2,
    ...overrides,
  };
}

const baseProps = {
  manifest,
  vaultRoot: '/home/alice/vault',
  durationMs: 1234,
  hookOutput: null,
};

describe('AdoptSummary', () => {
  it('renders adopt success line with shard ref and total managed', () => {
    const { lastFrame } = render(
      <AdoptSummary {...baseProps} summary={makeSummary({ totalManaged: 23 })} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Adopted');
    expect(frame).toContain('breferrari/mini@0.1.0');
    expect(frame).toContain('23 files');
    expect(frame).toContain('1.2s');
  });

  it('renders dry-run line when dryRun=true', () => {
    const { lastFrame } = render(
      <AdoptSummary {...baseProps} summary={makeSummary()} dryRun />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Dry run complete');
    expect(frame).toContain('would be adopted');
    expect(frame).not.toContain('Next:');
  });

  it('renders all four bucket counts when each is non-zero', () => {
    const summary = makeSummary({
      matchedAuto: ['a.md', 'b.md'],
      adoptedMine: ['c.md'],
      adoptedShard: ['d.md', 'e.md', 'f.md'],
      installedFresh: ['g.md'],
      totalManaged: 7,
    });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 matched');
    expect(frame).toContain('1 kept your version');
    expect(frame).toContain('3 switched to the shard');
    expect(frame).toContain('1 installed fresh');
  });

  it('omits zero-count rows', () => {
    const summary = makeSummary({
      matchedAuto: ['a.md'],
      adoptedMine: [],
      adoptedShard: [],
      installedFresh: [],
      totalManaged: 1,
    });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 matched');
    expect(frame).not.toContain('kept your version');
    expect(frame).not.toContain('switched to the shard');
    expect(frame).not.toContain('installed fresh');
  });

  it('renders empty-plan footnote when totalManaged is 0', () => {
    const summary = makeSummary({
      matchedAuto: [],
      adoptedMine: [],
      adoptedShard: [],
      installedFresh: [],
      totalManaged: 0,
    });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    expect(lastFrame() ?? '').toContain('no files adopted');
  });

  it('forwards hook output to HookSummarySection (post-install stage)', () => {
    const { lastFrame } = render(
      <AdoptSummary
        {...baseProps}
        summary={makeSummary()}
        hookOutput={{
          stdout: 'hook ran ok',
          stderr: '',
          exitCode: 0,
        }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-install hook completed.');
    expect(frame).toContain('hook ran ok');
  });

  it('renders "skipped" note for a deferred hook (dry run hook)', () => {
    const { lastFrame } = render(
      <AdoptSummary
        {...baseProps}
        summary={makeSummary()}
        hookOutput={{ deferred: true }}
      />,
    );
    expect(lastFrame() ?? '').toContain('Post-install hook skipped (dry run).');
  });
});
