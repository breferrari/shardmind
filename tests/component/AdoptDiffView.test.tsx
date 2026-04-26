import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import AdoptDiffView, {
  type AdoptDiffAction,
} from '../../source/components/AdoptDiffView.js';
import { ARROW_DOWN, ENTER, tick, waitFor, waitForCall } from './helpers.js';

afterEach(() => {
  cleanup();
});

const SHARD = Buffer.from('line one\nline two\nline three\nline four\nline five\n', 'utf-8');
const MINE = Buffer.from('line one\nline TWO mine\nline three\nline four\nline five\n', 'utf-8');
const BIN_USER = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
const BIN_SHARD = Buffer.from([0x00, 0x05, 0x06, 0x07]);

describe('AdoptDiffView', () => {
  it('renders header with path and position', () => {
    const { lastFrame } = render(
      <AdoptDiffView
        path="brain/Index.md"
        index={2}
        total={5}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Differs from shard:');
    expect(frame).toContain('brain/Index.md');
    expect(frame).toContain('(2 of 5)');
  });

  it('shows the user-side line in red and shard-side in green', () => {
    const { lastFrame } = render(
      <AdoptDiffView
        path="a.md"
        index={1}
        total={1}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('mine');
    expect(frame).toContain('shard');
    expect(frame).toContain('line TWO mine');
    expect(frame).toContain('line two');
  });

  it('binary fallback: byte sizes only, no preview attempt', () => {
    const { lastFrame } = render(
      <AdoptDiffView
        path="icon.bin"
        index={1}
        total={1}
        shardContent={BIN_SHARD}
        userContent={BIN_USER}
        isBinary={true}
        onChoice={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Binary file');
    expect(frame).toContain('Mine: 5B');
    expect(frame).toContain('Shard: 4B');
    // The Select choices remain available — user can still pick a side.
    expect(frame).toContain('Keep mine');
    expect(frame).toContain('Use shard');
  });

  it('invokes onChoice with keep_mine when Enter is pressed on the first option', async () => {
    const onChoice = vi.fn<(a: AdoptDiffAction) => void>();
    const { stdin } = render(
      <AdoptDiffView
        path="a.md"
        index={1}
        total={1}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    stdin.write(ENTER);
    await waitFor(
      () => (onChoice.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    expect(onChoice).toHaveBeenCalledWith('keep_mine');
  });

  it('invokes onChoice with use_shard after one ARROW_DOWN', async () => {
    const onChoice = vi.fn<(a: AdoptDiffAction) => void>();
    const { stdin } = render(
      <AdoptDiffView
        path="a.md"
        index={1}
        total={1}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
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
    expect(onChoice).toHaveBeenCalledWith('use_shard');
  });

  it('does not fire onChoice twice on the same mount', async () => {
    const onChoice = vi.fn<(a: AdoptDiffAction) => void>();
    const { stdin } = render(
      <AdoptDiffView
        path="a.md"
        index={1}
        total={1}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    stdin.write(ENTER);
    await waitFor(
      () => (onChoice.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );
    stdin.write(ENTER);
    stdin.write(ENTER);
    await tick(80);
    expect(onChoice).toHaveBeenCalledTimes(1);
  });

  it('fires onChoice for the next file after the parent advances path without remounting (#109)', async () => {
    // Repro of the iterated-firedRef bug: adopt.tsx renders <AdoptDiffView>
    // without a `key` prop, so when phase.currentIndex advances React keeps
    // the same component instance. A boolean firedRef would leak `true`
    // across files and freeze every prompt after the first. Here we mimic
    // the parent by re-rendering the SAME root with new props.
    const onChoice = vi.fn<(a: AdoptDiffAction) => void>();
    const r = render(
      <AdoptDiffView
        path="file-1.md"
        index={1}
        total={2}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    r.stdin.write(ENTER);
    await waitForCall(onChoice);
    expect(onChoice).toHaveBeenNthCalledWith(1, 'keep_mine');

    // Parent advances to the next file — no key prop, same instance.
    r.rerender(
      <AdoptDiffView
        path="file-2.md"
        index={2}
        total={2}
        shardContent={SHARD}
        userContent={MINE}
        isBinary={false}
        onChoice={onChoice}
      />,
    );
    await tick(30);
    r.stdin.write(ENTER);
    await waitFor(() => (onChoice.mock.calls.length >= 2 ? 'ok' : ''), (f) => f === 'ok');
    expect(onChoice).toHaveBeenCalledTimes(2);
    expect(onChoice).toHaveBeenNthCalledWith(2, 'keep_mine');
  });

  it('does NOT render \\r artifacts on CRLF input', () => {
    const crlfMine = Buffer.from('line one\r\nline two-mine\r\nline three\r\n', 'utf-8');
    const lfShard = Buffer.from('line one\nline two\nline three\n', 'utf-8');
    const { lastFrame } = render(
      <AdoptDiffView
        path="a.md"
        index={1}
        total={1}
        shardContent={lfShard}
        userContent={crlfMine}
        isBinary={false}
        onChoice={() => {}}
      />,
    );
    expect(lastFrame() ?? '').not.toContain('\r');
  });
});
