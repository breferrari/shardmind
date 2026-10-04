import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import CrashBoundary from '../../source/components/CrashBoundary.js';

afterEach(() => {
  cleanup();
  process.exitCode = undefined;
});

function Broken(): never {
  throw new TypeError('render went wrong');
}

describe('CrashBoundary (#225)', () => {
  it('renders the children while nothing throws', () => {
    const { lastFrame } = render(
      <CrashBoundary version="0.1.9">
        <Fine />
      </CrashBoundary>,
    );
    expect(lastFrame()).toContain('all good');
    expect(process.exitCode).toBeUndefined();
  });

  it('shows a render crash through the error view, with the report link, and sets exit code 1', () => {
    const r = render(
      <CrashBoundary version="0.1.9">
        <Broken />
      </CrashBoundary>,
    );
    // The boundary ends the app, which blanks the last frame; read them all.
    const frame = r.frames.join(' ').replace(/\s+/g, ' ');
    expect(frame).toContain('render went wrong');
    expect(frame).toContain('This is a bug in shardmind');
    expect(frame).toContain('issues/new?body=shardmind+0.1.9');
    expect(process.exitCode).toBe(1);
  });
});

function Fine() {
  return <Text>all good</Text>;
}
