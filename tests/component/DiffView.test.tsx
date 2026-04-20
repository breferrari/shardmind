import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import DiffView, { type DiffAction } from '../../source/components/DiffView.js';
import type { MergeResult } from '../../source/runtime/types.js';
import { ARROW_DOWN, ENTER, tick, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

function makeResult(overrides: Partial<MergeResult> = {}): MergeResult {
  return {
    content: [
      'before line 1',
      'before line 2',
      '<<<<<<< yours',
      'user line',
      '=======',
      'shard line',
      '>>>>>>> shard update',
      'after line 1',
      'after line 2',
      '',
    ].join('\n'),
    hasConflicts: true,
    conflicts: [
      {
        lineStart: 3,
        lineEnd: 7,
        base: 'base line',
        theirs: 'user line',
        ours: 'shard line',
      },
    ],
    stats: { linesUnchanged: 4, linesAutoMerged: 0, linesConflicted: 2 },
    ...overrides,
  };
}

describe('DiffView', () => {
  it('renders the conflict header with path and position', () => {
    const { lastFrame } = render(
      <DiffView
        path="brain/Index.md"
        index={2}
        total={5}
        result={makeResult()}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Conflict in');
    expect(frame).toContain('brain/Index.md');
    expect(frame).toContain('(2 of 5)');
  });

  it('renders conflict region with context lines and conflict markers', () => {
    const { lastFrame } = render(
      <DiffView
        path="a.md"
        index={1}
        total={1}
        result={makeResult()}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('user line');
    expect(frame).toContain('shard line');
    expect(frame).toContain('<<<<<<< yours');
    expect(frame).toContain('>>>>>>> shard update');
    // Context before/after present
    expect(frame).toContain('before line 1');
    expect(frame).toContain('after line 2');
  });

  it('renders merge stats summary', () => {
    const { lastFrame } = render(
      <DiffView
        path="a.md"
        index={1}
        total={1}
        result={makeResult({
          stats: { linesUnchanged: 42, linesAutoMerged: 8, linesConflicted: 3 },
        })}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('42 unchanged');
    expect(frame).toContain('8 auto-merged');
    expect(frame).toContain('1 region conflicted');
  });

  it('uses singular "region conflicted" for one region, plural for many', () => {
    const multi = makeResult({
      conflicts: [
        makeResult().conflicts[0]!,
        { lineStart: 10, lineEnd: 14, base: '', theirs: 'x', ours: 'y' },
        { lineStart: 20, lineEnd: 24, base: '', theirs: 'p', ours: 'q' },
      ],
    });
    const { lastFrame } = render(
      <DiffView path="a.md" index={1} total={1} result={multi} onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain('3 regions conflicted');
  });

  it('invokes onChoice with accept_new when Enter is pressed on the first option', async () => {
    const onChoice = vi.fn<(a: DiffAction) => void>();
    const { stdin, lastFrame } = render(
      <DiffView
        path="a.md"
        index={1}
        total={1}
        result={makeResult()}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    stdin.write(ENTER);
    await waitFor(
      () => (onChoice.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    expect(onChoice).toHaveBeenCalledWith('accept_new');
    expect(lastFrame()).toBeTruthy();
  });

  it('invokes onChoice with keep_mine when navigating down once', async () => {
    const onChoice = vi.fn<(a: DiffAction) => void>();
    const { stdin } = render(
      <DiffView
        path="a.md"
        index={1}
        total={1}
        result={makeResult()}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ENTER);
    await waitFor(
      () => (onChoice.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    expect(onChoice).toHaveBeenCalledWith('keep_mine');
  });

  it('never fires onChoice for the disabled "Open in editor" option', async () => {
    const onChoice = vi.fn<(a: DiffAction) => void>();
    const { stdin } = render(
      <DiffView
        path="a.md"
        index={1}
        total={1}
        result={makeResult()}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    // Arrow past accept_new, keep_mine, skip to the disabled option.
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await tick(50);
    stdin.write(ENTER);
    await tick(80);
    // onChoice is never called with 'open_editor' or the raw placeholder.
    for (const call of onChoice.mock.calls) {
      expect(['accept_new', 'keep_mine', 'skip']).toContain(call[0]);
    }
  });

  it('tolerates CRLF line endings in merge content without rendering \\r artifacts', () => {
    const crlfContent = [
      'before line',
      '<<<<<<< yours',
      'user line',
      '=======',
      'shard line',
      '>>>>>>> shard update',
      'after line',
      '',
    ].join('\r\n');
    const { lastFrame } = render(
      <DiffView
        path="a.md"
        index={1}
        total={1}
        result={makeResult({
          content: crlfContent,
          conflicts: [
            {
              lineStart: 2,
              lineEnd: 6,
              base: '',
              theirs: 'user line 1\r\nuser line 2',
              ours: 'shard line',
            },
          ],
        })}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    // No literal \r characters in the rendered frame — would corrupt the TTY.
    expect(frame).not.toContain('\r');
    expect(frame).toContain('user line 1');
    expect(frame).toContain('user line 2');
  });

  it('does not show context lines when the conflict starts at line 1', () => {
    const fromStart = makeResult({
      content: ['<<<<<<< yours', 'u', '=======', 's', '>>>>>>> shard update', 'after', ''].join('\n'),
      conflicts: [
        { lineStart: 1, lineEnd: 5, base: '', theirs: 'u', ours: 's' },
      ],
    });
    const { lastFrame } = render(
      <DiffView path="a.md" index={1} total={1} result={fromStart} onChoice={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    // Still renders the conflict and the one after-context line.
    expect(frame).toContain('after');
    expect(frame).toContain('<<<<<<< yours');
  });
});
