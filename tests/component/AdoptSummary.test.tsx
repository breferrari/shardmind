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
    adoptedMerged: [],
    updatedBehind: [],
    installedFresh: [],
    renamedFiles: [],
    totalManaged: 2,
    ...overrides,
  };
}

const baseProps = {
  manifest,
  vaultRoot: '/home/alice/vault',
  durationMs: 1234,
  hooks: [],
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

  it('renders the auto-merged bucket with a review-recommended note (#120)', () => {
    const summary = makeSummary({
      adoptedMerged: ['notes/a.md', 'notes/b.md'],
      totalManaged: 4,
    });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/2 auto-merged/);
    expect(frame).toMatch(/review recommended/i);
  });

  it('lists the files moved to a new path (#179)', () => {
    const summary = makeSummary({ renamedFiles: [{ from: 'CLAUDE.md', to: 'AGENTS.md' }] });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Moved to a new path');
    expect(frame).toContain('CLAUDE.md → AGENTS.md');
  });

  it('says a dry run would move them', () => {
    const summary = makeSummary({ renamedFiles: [{ from: 'CLAUDE.md', to: 'AGENTS.md' }] });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} dryRun />);
    expect(lastFrame() ?? '').toContain('Would move to a new path');
  });

  it('reports files updated from the base release, with both versions (#325)', () => {
    const { lastFrame } = render(
      <AdoptSummary {...baseProps} summary={makeSummary({ updatedBehind: ['CLAUDE.md', 'Home.md'] })} base={{ version: '0.0.9' }} />,
    );
    expect(lastFrame()).toContain('2 updated to 0.1.0: unchanged since 0.0.9');
  });

  it('says a dry run would update them (#325)', () => {
    const { lastFrame } = render(
      <AdoptSummary {...baseProps} dryRun summary={makeSummary({ updatedBehind: ['CLAUDE.md'] })} base={{ version: '0.0.9' }} />,
    );
    expect(lastFrame()).toContain('1 would be updated to 0.1.0');
  });

  it('warns when the base release could not be read, and names it (#325)', () => {
    const { lastFrame } = render(
      <AdoptSummary {...baseProps} summary={makeSummary()} base={{ version: '0.0.9', unavailable: 'Version 0.0.9 not found' }} />,
    );
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('Could not read 0.0.9');
    expect(frame).toContain('Version 0.0.9 not found');
    expect(frame).toContain('treated as yours');
  });

  it('omits zero-count rows', () => {
    const summary = makeSummary({
      matchedAuto: ['a.md'],
      adoptedMine: [],
      adoptedShard: [],
      installedFresh: [],
      renamedFiles: [],
      totalManaged: 1,
    });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 matched');
    expect(frame).not.toContain('kept your version');
    expect(frame).not.toContain('switched to the shard');
    expect(frame).not.toContain('installed fresh');
    expect(frame).not.toContain('to a new path');
  });

  it('renders empty-plan footnote when totalManaged is 0', () => {
    const summary = makeSummary({
      matchedAuto: [],
      adoptedMine: [],
      adoptedShard: [],
      installedFresh: [],
      renamedFiles: [],
      totalManaged: 0,
    });
    const { lastFrame } = render(<AdoptSummary {...baseProps} summary={summary} />);
    expect(lastFrame() ?? '').toContain('no files adopted');
  });

  it('forwards bootstrap + personalize outcomes to HookSummarySection', () => {
    const { lastFrame } = render(
      <AdoptSummary
        {...baseProps}
        summary={makeSummary()}
        hooks={[
          { slot: 'bootstrap', summary: { stdout: 'hook ran ok', stderr: '', exitCode: 0 } },
          { slot: 'personalize', summary: { stdout: 'personalized', stderr: '', exitCode: 0 } },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook completed.');
    expect(frame).toContain('hook ran ok');
    expect(frame).toContain('Personalize hook completed.');
  });

  it('renders "skipped" note for a deferred hook (dry run hook)', () => {
    const { lastFrame } = render(
      <AdoptSummary
        {...baseProps}
        summary={makeSummary()}
        hooks={[{ slot: 'bootstrap', summary: { deferred: true } }]}
      />,
    );
    expect(lastFrame() ?? '').toContain('Bootstrap hook skipped (dry run).');
  });
});

describe('AdoptSummary: external tools (#138)', () => {
  it('shows the dry-run note', () => {
    const { lastFrame } = render(
      <AdoptSummary {...baseProps} summary={makeSummary({})} externalTools={['external tools not checked (dry run)']} />,
    );
    expect(lastFrame()).toContain('external tools not checked (dry run)');
  });
});
