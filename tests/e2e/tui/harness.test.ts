/**
 * Smoke tests for the Layer 2 PTY + virtual-screen helpers themselves.
 *
 * Pins the contract the scenario files rely on: spawn works, stdin
 * round-trips through the PTY, ANSI escape sequences are folded by
 * the headless terminal, and `waitForScreen` produces a useful error
 * when its predicate doesn't match.
 *
 * Mirrors Phase 1's `tests/component/flows/harness.test.tsx` shape —
 * if the helpers regress, this file fails before the actual scenario
 * suites do, narrowing the blame surface.
 *
 * Skipped on Windows: ConPTY semantics diverge from POSIX pty enough
 * that Layer 2 doesn't run there. Tracking via #57.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { createVirtualScreen } from './helpers/virtual-screen.js';
import { spawnCliPty, ENTER } from './helpers/pty-cli.js';

const skipOnWindows = process.platform === 'win32';

describe.skipIf(skipOnWindows)('Layer 2 harness — virtual screen', () => {
  it('renders plain text into the visible viewport', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    await screen.feed('hello world');
    expect(screen.contains('hello world')).toBe(true);
    screen.dispose();
  });

  it('folds ANSI escape sequences (cursor + color) into rendered chars', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    // Red foreground, "RED", reset, then plain text. The serialized
    // grid is the rendered chars only — color codes are gone.
    await screen.feed('\x1b[31mRED\x1b[0m TEXT');
    const out = screen.serialize();
    expect(out).toContain('RED TEXT');
    expect(out).not.toContain('\x1b');
    screen.dispose();
  });

  it('handles cursor overdraw — last write wins on the same cell', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    // Write "first", then carriage-return + "later" (overdrawing the
    // first 5 cells with "later"). The visible row should contain
    // "later" — the transient "first" must NOT show.
    await screen.feed('first\rlater');
    expect(screen.contains('later')).toBe(true);
    expect(screen.contains('first')).toBe(false);
    screen.dispose();
  });

  it('matches regex against the serialized viewport', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    await screen.feed('item (2 of 5)');
    expect(screen.matches(/\(2 of 5\)/)).toBe(true);
    expect(screen.matches(/\(3 of 5\)/)).toBe(false);
    screen.dispose();
  });
});

describe.skipIf(skipOnWindows)('Layer 2 harness — PTY spawn', () => {
  it('spawns the CLI inside a PTY and reads --version through the screen', async () => {
    const handle = await spawnCliPty(['--version'], {
      cwd: os.tmpdir(),
    });
    try {
      // --version exits immediately. Wait for the child to close, then
      // assert the rendered grid carries the version string. We don't
      // pin the exact version — the package bumps independently of
      // this test — but the shape must be `<digits>.<digits>.<digits>`.
      const exit = await handle.waitForExit();
      expect(exit.exitCode).toBe(0);
      expect(handle.screen.matches(/\d+\.\d+\.\d+/)).toBe(true);
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('--help renders synchronously and the screen captures the usage line', async () => {
    // Pin two harness contracts in a non-interactive shape:
    //   1. `spawnCliPty` actually spawns the child and reaches its
    //      stdout (the screen ends up with rendered content), and
    //   2. a fast-exit child doesn't deadlock the helper — `waitForExit`
    //      returns within seconds, not minutes.
    // The original test description claimed to verify `write()` round-
    // trips through the child, but `--help` exits immediately without
    // ever reading stdin; renaming so the assertion shape is honest.
    // A genuine input round-trip is exercised by every scenario suite
    // (typeIntoPty / waitForScreen), which is the real coverage.
    const handle = await spawnCliPty(['--help'], {
      cwd: os.tmpdir(),
    });
    try {
      const exit = await handle.waitForExit();
      expect(exit.exitCode).toBe(0);
      const screen = handle.screen.serialize();
      expect(screen.toLowerCase()).toContain('install');
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('waitForScreen times out with the last screen captured in the error', async () => {
    const handle = await spawnCliPty(['--version'], {
      cwd: os.tmpdir(),
    });
    try {
      // --version finishes fast; ask for an impossible predicate.
      // The helper must reject with a message that includes the
      // last serialized screen so a real-test failure points at
      // what the user actually saw.
      await expect(
        handle.waitForScreen(() => false, {
          timeoutMs: 200,
          description: 'an impossible predicate',
        }),
      ).rejects.toThrow(/impossible predicate/);
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('write(ENTER) is delivered as the literal CR byte', () => {
    // No PTY needed — pin the constant value so a future refactor
    // doesn't accidentally swap to '\n' (which the kernel would
    // translate differently under a cooked-line discipline that
    // this layer specifically avoids).
    expect(ENTER).toBe('\r');
  });
});
