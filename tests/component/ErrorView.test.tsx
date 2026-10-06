import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import ErrorView from '../../source/components/ErrorView.js';
import { ShardMindError } from '../../source/runtime/types.js';

afterEach(() => {
  cleanup();
});

const text = (frame: string | undefined) => (frame ?? '').replace(/\s+/g, ' ');

describe('ErrorView (#225)', () => {
  it('shows a ShardMindError with its code and hint, and no stack or report link', () => {
    const err = new ShardMindError('Shard not found', 'SHARD_NOT_FOUND', 'Check the spelling');
    const frame = text(render(<ErrorView error={err} version="0.1.9" detail="extra detail" />).lastFrame());
    expect(frame).toContain('Shard not found');
    expect(frame).toContain('code: SHARD_NOT_FOUND');
    expect(frame).toContain('Check the spelling');
    expect(frame).toContain('extra detail');
    expect(frame).not.toContain('This is a bug');
    expect(frame).not.toContain('issues/new');
    expect(frame).not.toMatch(/\bat \S+ \(/);
  });

  it('shows an unexpected error as a bug, with the report link and the stack', () => {
    const err = new TypeError('Cannot read properties of undefined');
    err.stack = 'TypeError: Cannot read properties of undefined\n    at planUpdate (update-planner.js:10:5)';
    const frame = text(render(<ErrorView error={err} version="0.1.9" />).lastFrame());
    expect(frame).toContain('Cannot read properties of undefined');
    expect(frame).toContain('This is a bug in shardmind');
    expect(frame).toContain('github.com/breferrari/shardmind/issues/new');
    expect(frame).toContain('at planUpdate (update-planner.js:10:5)');
    // The link carries nothing from the error.
    expect(frame).toMatch(/issues\/new\?body=shardmind\+0\.1\.9(?!\S)/);
  });

  it('shows an error from the environment with its code and a hint, not as a bug (#225)', () => {
    const err = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const frame = text(render(<ErrorView error={err} version="0.1.9" />).lastFrame());
    expect(frame).toContain('ENOSPC: no space left on device, write');
    expect(frame).toContain('code: ENOSPC');
    expect(frame).toMatch(/disk is full/i);
    expect(frame).not.toContain('This is a bug');
    expect(frame).not.toContain('issues/new');
  });

  it('shows a thrown non-Error as a bug too, without a stack', () => {
    const frame = text(render(<ErrorView error="something odd" />).lastFrame());
    expect(frame).toContain('something odd');
    expect(frame).toContain('This is a bug in shardmind');
    expect(frame).toContain('issues/new');
  });

  it('puts a lead in front of the message', () => {
    const frame = text(
      render(<ErrorView error={new ShardMindError('gone', 'VALIDATE_TARGET_INVALID')} lead="Could not check the shard" />).lastFrame(),
    );
    expect(frame).toContain('Could not check the shard: gone');
  });
});
