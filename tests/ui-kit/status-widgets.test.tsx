/**
 * ui-kit Spinner, ProgressBar and the glyph fallback (#273): behaviour
 * the golden frames don't cover. No ShardMind fixtures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Box } from 'ink';
import { ProgressBar, Spinner } from '../../source/ui-kit/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ui-kit Spinner', () => {
  it('advances a frame per interval and wraps after the last', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // React's scheduler runs on setImmediate in Node, so only the
    // spinner's interval is faked.
    const { lastFrame } = render(<Spinner label="Working" />);
    await tick();
    expect(lastFrame()).toBe('⠋ Working');
    await vi.advanceTimersByTimeAsync(80);
    await tick();
    expect(lastFrame()).toBe('⠙ Working');
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(80);
      await tick();
    }
    expect(lastFrame()).toBe('⠋ Working');
  });

  it('leaves no timer behind once unmounted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { unmount } = render(<Spinner />);
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ui-kit ProgressBar', () => {
  it('fills a narrow bar by rounding, and clamps values outside 0 to 100', () => {
    const bar = (value: number) => render(<Box width={3}><ProgressBar value={value} /></Box>).lastFrame();
    expect(bar(50)).toBe('██░');
    expect(bar(-20)).toBe('░░░');
    expect(bar(250)).toBe('███');
  });
});

const UNICODE = { tick: '✔', cross: '✘', warning: '⚠', info: 'ℹ', pointer: '❯' };
const ASCII_FALLBACK = { tick: '√', cross: '×', warning: '‼', info: 'i', pointer: '>' };

describe('ui-kit glyphs', () => {
  // The golden frames take their glyphs from lib/figures.ts, so these pin
  // the glyphs themselves to what figures 6 draws.
  it.skipIf(process.platform === 'win32')("are figures' Unicode set on a Unicode terminal", async () => {
    vi.stubEnv('TERM', 'xterm-256color');
    const { figures } = await import('../../source/ui-kit/lib/figures.js');
    expect(figures).toMatchObject(UNICODE);
  });

  it.runIf(process.platform === 'win32')("are figures' Unicode set in Windows Terminal", async () => {
    vi.stubEnv('WT_SESSION', '1');
    const { figures } = await import('../../source/ui-kit/lib/figures.js');
    expect(figures).toMatchObject(UNICODE);
  });

  it.skipIf(process.platform === 'win32')('falls back on the Linux console', async () => {
    vi.stubEnv('TERM', 'linux');
    const { figures } = await import('../../source/ui-kit/lib/figures.js');
    expect(figures).toMatchObject(ASCII_FALLBACK);
  });

  it.runIf(process.platform === 'win32')('falls back on a Windows console that names no Unicode terminal', async () => {
    for (const name of ['WT_SESSION', 'TERMINUS_SUBLIME', 'ConEmuTask', 'TERM_PROGRAM', 'TERM', 'TERMINAL_EMULATOR']) {
      vi.stubEnv(name, '');
    }
    const { figures } = await import('../../source/ui-kit/lib/figures.js');
    expect(figures).toMatchObject(ASCII_FALLBACK);
  });
});
