import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import ModuleReview from '../../source/components/ModuleReview.js';
import type { ModuleDefinition, ModuleSelections } from '../../source/runtime/types.js';
import { ENTER, SPACE, ARROW_DOWN, tick, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

function mod(label: string, removable: boolean): ModuleDefinition {
  return { label, paths: [], removable };
}

const modules: Record<string, ModuleDefinition> = {
  core: mod('Core', false),
  qmd: mod('QMD', true),
  research: mod('Research', true),
};

const fileCounts: Record<string, number> = {
  core: 10,
  qmd: 5,
  research: 8,
};

const initialSelections: ModuleSelections = {
  core: 'included',
  qmd: 'included',
  research: 'included',
};

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(30);
  return r;
}

describe('ModuleReview', () => {
  it('shows initial total including always-on modules + framework files', async () => {
    const { lastFrame } = await mount(
      <ModuleReview
        modules={modules}
        moduleFileCounts={fileCounts}
        alwaysIncludedFileCount={3}
        initialSelections={initialSelections}
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    // 10 (core) + 5 (qmd) + 8 (research) + 3 (framework) = 26
    expect(frame).toContain('Will install:');
    expect(frame).toContain('26 files');
    expect(frame).toContain('Core');
    expect(frame).toContain('Framework files');
  });

  it('total updates when a removable module is toggled off', async () => {
    const { stdin, lastFrame } = await mount(
      <ModuleReview
        modules={modules}
        moduleFileCounts={fileCounts}
        alwaysIncludedFileCount={0}
        initialSelections={initialSelections}
        onSubmit={() => {}}
      />,
    );

    await waitFor(lastFrame, (f) => f.includes('23 files'));

    // MultiSelect starts highlight on first option (qmd). Space toggles it off.
    stdin.write(SPACE);
    // 10 (core locked) + 0 (qmd off) + 8 (research on) = 18
    await waitFor(lastFrame, (f) => f.includes('18 files'));
  });

  it('onSubmit fires with final selections when Enter pressed', async () => {
    const onSubmit = vi.fn();
    const { stdin } = await mount(
      <ModuleReview
        modules={modules}
        moduleFileCounts={fileCounts}
        alwaysIncludedFileCount={0}
        initialSelections={initialSelections}
        onSubmit={onSubmit}
      />,
    );

    // Toggle qmd off, leave research on, submit
    stdin.write(SPACE);
    await tick(50);
    stdin.write(ENTER);
    await waitFor(() => (onSubmit.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    const [selections] = onSubmit.mock.calls[0] as [ModuleSelections];
    expect(selections.core).toBe('included');
    expect(selections.qmd).toBe('excluded');
    expect(selections.research).toBe('included');
  });

  it('renders "no optional modules" when all are non-removable', async () => {
    const onlyLocked = {
      core: mod('Core', false),
      framework: mod('Framework', false),
    };
    const { lastFrame } = await mount(
      <ModuleReview
        modules={onlyLocked}
        moduleFileCounts={{ core: 10, framework: 2 }}
        alwaysIncludedFileCount={0}
        initialSelections={{ core: 'included', framework: 'included' }}
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('No optional modules');
    expect(frame).toContain('12 files');
  });
});
