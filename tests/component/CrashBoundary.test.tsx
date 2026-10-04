import { describe, it, expect, afterEach, vi } from 'vitest';
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
      <CrashBoundary getVersion={() => '0.1.9'}>
        <Fine />
      </CrashBoundary>,
    );
    expect(lastFrame()).toContain('all good');
    expect(process.exitCode).toBeUndefined();
  });

  it('shows a render crash through the error view, with the report link, and sets exit code 1', () => {
    const r = render(
      <CrashBoundary getVersion={() => '0.1.9'}>
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

describe('CrashBoundary under --json (#225)', () => {
  it('writes one jsonFailure document with the stack instead of the human view', () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const r = render(
        <CrashBoundary getVersion={() => '0.1.9'} json="status">
          <Broken />
        </CrashBoundary>,
      );
      const doc = JSON.parse(chunks.join('')) as { ok: boolean; command: string; error: { stack: string } };
      expect(doc).toMatchObject({ ok: false, command: 'status' });
      expect(doc.error.stack).toContain('render went wrong');
      expect(r.frames.join('')).not.toContain('This is a bug');
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
